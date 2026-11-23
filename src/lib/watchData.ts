import type {
  DailyWorkout,
  Effort,
  HealthSnapshot,
  HrvStatus,
  VolumeProfile,
  WatchActivity,
} from './types';

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Parse real .gpx, .tcx, or Garmin .json watch activity files uploaded by the athlete.
 */
export function parseWatchActivityFile(
  content: string,
  fileName: string
): WatchActivity {
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.json')) {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const act = Array.isArray(parsed)
      ? (parsed[0] as Record<string, unknown>)
      : ((parsed.activity ?? parsed) as Record<string, unknown>);
    const dist = Number(act.distance ?? act.distance_m ?? 0);
    const dur = Number(act.duration ?? act.duration_s ?? 0);
    if (!dist && !dur) {
      throw new Error('JSON file does not contain recognized distance or duration fields.');
    }
    const rawType = act.activityType;
    const typeKey =
      rawType && typeof rawType === 'object'
        ? String((rawType as Record<string, unknown>).typeKey ?? 'running')
        : String(rawType ?? 'running');
    return {
      id: `imp-${Date.now()}`,
      name: String(act.activityName ?? act.name ?? fileName.replace(/\.json$/i, '')),
      date: String(act.startTimeLocal ?? act.date ?? new Date().toISOString()).slice(0, 10),
      activity_type: typeKey,
      distance_m: dist,
      duration_s: dur,
      avg_hr: act.averageHR != null ? Math.round(Number(act.averageHR)) : null,
      max_hr: act.maxHR != null ? Math.round(Number(act.maxHR)) : null,
      elevation_gain_ft: Math.round(Number(act.elevationGain ?? 0) * 3.28084),
      avg_cadence:
        act.averageRunningCadenceInStepsPerMinute != null
          ? Math.round(Number(act.averageRunningCadenceInStepsPerMinute))
          : null,
      source: 'file_import',
      source_label: fileName,
    };
  }

  if (lower.endsWith('.gpx')) {
    const trkptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
    const pts: Array<{ lat: number; lon: number; ele?: number; time?: number; hr?: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = trkptRegex.exec(content)) !== null) {
      const lat = Number(match[1]);
      const lon = Number(match[2]);
      const body = match[3];
      const eleM = body.match(/<ele>([^<]+)<\/ele>/i);
      const timeM = body.match(/<time>([^<]+)<\/time>/i);
      const hrM = body.match(/<(?:gpxtpx:)?hr>([^<]+)<\/(?:gpxtpx:)?hr>/i);
      pts.push({
        lat,
        lon,
        ele: eleM ? Number(eleM[1]) : undefined,
        time: timeM ? Date.parse(timeM[1]) : undefined,
        hr: hrM ? Number(hrM[1]) : undefined,
      });
    }
    if (pts.length < 2) {
      throw new Error('GPX file contains fewer than 2 trackpoints.');
    }

    let distM = 0;
    let gainM = 0;
    const hrs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].hr && Number.isFinite(pts[i].hr)) hrs.push(pts[i].hr!);
      if (i > 0) {
        distM += haversineMeters(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
        if (pts[i].ele !== undefined && pts[i - 1].ele !== undefined) {
          const d = pts[i].ele! - pts[i - 1].ele!;
          if (d > 0.3) gainM += d;
        }
      }
    }

    const firstTime = pts.find((p) => p.time)?.time;
    const lastTime = [...pts].reverse().find((p) => p.time)?.time;
    const durationS = firstTime && lastTime && lastTime > firstTime ? (lastTime - firstTime) / 1000 : 0;
    const nameMatch = content.match(/<name>([^<]+)<\/name>/i);

    return {
      id: `gpx-${Date.now()}`,
      name: nameMatch ? nameMatch[1].trim() : fileName.replace(/\.gpx$/i, ''),
      date: firstTime
        ? new Date(firstTime).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      activity_type: 'running',
      distance_m: Math.round(distM),
      duration_s: Math.round(durationS),
      avg_hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
      max_hr: hrs.length ? Math.round(Math.max(...hrs)) : null,
      elevation_gain_ft: Math.round(gainM * 3.28084),
      avg_cadence: null,
      source: 'file_import',
      source_label: fileName,
    };
  }

  if (lower.endsWith('.tcx')) {
    const distMatches = [...content.matchAll(/<DistanceMeters>([^<]+)<\/DistanceMeters>/gi)];
    const durMatches = [...content.matchAll(/<TotalTimeSeconds>([^<]+)<\/TotalTimeSeconds>/gi)];
    const hrMatches = [...content.matchAll(/<HeartRateBpm[^>]*>\s*<Value>([^<]+)<\/Value>/gi)];
    const altMatches = [...content.matchAll(/<AltitudeMeters>([^<]+)<\/AltitudeMeters>/gi)];
    const idMatch = content.match(/<Id>([^<]+)<\/Id>/i);

    const distM = distMatches.length
      ? Math.max(...distMatches.map((m) => Number(m[1]) || 0))
      : 0;
    const durationS = durMatches.reduce((acc, m) => acc + (Number(m[1]) || 0), 0);
    const hrs = hrMatches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n) && n > 30);

    let gainM = 0;
    const alts = altMatches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
    for (let i = 1; i < alts.length; i++) {
      if (alts[i] - alts[i - 1] > 0.3) gainM += alts[i] - alts[i - 1];
    }

    if (!distM && !durationS) {
      throw new Error('TCX file does not contain DistanceMeters or TotalTimeSeconds.');
    }

    return {
      id: `tcx-${Date.now()}`,
      name: fileName.replace(/\.tcx$/i, ''),
      date: idMatch ? idMatch[1].slice(0, 10) : new Date().toISOString().slice(0, 10),
      activity_type: 'running',
      distance_m: Math.round(distM),
      duration_s: Math.round(durationS),
      avg_hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
      max_hr: hrs.length ? Math.round(Math.max(...hrs)) : null,
      elevation_gain_ft: Math.round(gainM * 3.28084),
      avg_cadence: null,
      source: 'file_import',
      source_label: fileName,
    };
  }

  throw new Error('Unsupported watch file format. Please upload a .gpx, .tcx, or Garmin .json export.');
}

/**
 * Compute real 6-week average weekly miles and longest run from synced watch activities.
 */
export function computeVolumeFromActivities(activities: WatchActivity[]): VolumeProfile | null {
  const runActivities = activities.filter((a) => {
    const t = a.activity_type.toLowerCase();
    return !t || t.includes('run') || t.includes('track') || t.includes('trail') || t.includes('treadmill');
  });

  if (runActivities.length === 0) return null;

  let longestMiles = 0;
  let totalRecentMiles = 0;
  const nowMs = Date.now();
  const sixWeeksMs = 42 * 86400 * 1000;
  let earliestRecentMs = nowMs;

  for (const act of runActivities) {
    const miles = act.distance_m / 1609.344;
    if (miles > longestMiles) longestMiles = miles;
    const actMs = Date.parse(act.date);
    if (Number.isFinite(actMs) && nowMs - actMs <= sixWeeksMs) {
      totalRecentMiles += miles;
      if (actMs < earliestRecentMs) earliestRecentMs = actMs;
    }
  }

  const weeksCovered = Math.max(1, Math.min(6, (nowMs - earliestRecentMs) / (7 * 86400 * 1000)));
  const avgWeekly = totalRecentMiles > 0 ? totalRecentMiles / weeksCovered : longestMiles;

  return {
    longest_run_miles: Number(longestMiles.toFixed(2)),
    avg_weekly_miles: Number(avgWeekly.toFixed(1)),
  };
}

/**
 * Extract structured JSON from an MCP tool call result block (supports both text JSON and structuredContent).
 */
export function unwrapMcpToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const rec = result as Record<string, unknown>;
  if (rec.structuredContent !== undefined) return rec.structuredContent;
  const content = rec.content;
  if (Array.isArray(content)) {
    const texts = content
      .map((item) =>
        item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'
          ? String((item as Record<string, unknown>).text)
          : ''
      )
      .filter(Boolean);
    const combined = texts.join('\n').trim();
    if (!combined) return null;
    try {
      return JSON.parse(combined);
    } catch {
      return combined;
    }
  }
  return result;
}

function toFiniteNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize activities returned from Garmlink MCP tools into RaceKit WatchActivity records.
 */
export function normalizeGarmlinkActivities(raw: unknown): WatchActivity[] {
  const payload = unwrapMcpToolResult(raw);
  let rows: unknown[] = [];

  if (Array.isArray(payload)) {
    rows = payload;
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const candidate = obj.activities ?? obj.items ?? obj.data ?? obj.results;
    if (Array.isArray(candidate)) {
      rows = candidate;
    }
  }

  const out: WatchActivity[] = [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i];
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;

    // Handle distance in meters or km/miles depending on Garmlink field names
    let distanceM =
      toFiniteNumber(r.distance_m) ??
      toFiniteNumber(r.distanceMeters) ??
      toFiniteNumber(r.distance) ??
      0;
    const distKm = toFiniteNumber(r.distance_km ?? r.distanceKm);
    const distMi = toFiniteNumber(r.distance_miles ?? r.distanceMiles);
    if (distanceM === 0 && distKm) distanceM = distKm * 1000;
    if (distanceM === 0 && distMi) distanceM = distMi * 1609.344;

    const durationS =
      toFiniteNumber(r.duration_s) ??
      toFiniteNumber(r.durationSeconds) ??
      toFiniteNumber(r.duration) ??
      toFiniteNumber(r.movingDuration) ??
      (toFiniteNumber(r.duration_min) ? toFiniteNumber(r.duration_min)! * 60 : 0);

    const rawType = r.activityType ?? r.activity_type ?? r.type ?? r.sport;
    const typeKey =
      rawType && typeof rawType === 'object'
        ? String((rawType as Record<string, unknown>).typeKey ?? (rawType as Record<string, unknown>).name ?? 'running')
        : String(rawType ?? 'running');

    const elevM = toFiniteNumber(r.elevationGain ?? r.elevation_gain_m ?? r.elevation_gain);
    const elevFt = toFiniteNumber(r.elevation_gain_ft ?? r.elevationGainFt);

    const dateRaw = String(
      r.startTimeLocal ?? r.start_time_local ?? r.startTimeGMT ?? r.start_time ?? r.date ?? ''
    );

    const idVal = r.activityId ?? r.activity_id ?? r.garmin_id ?? r.id ?? `gm-${i}-${dateRaw}`;

    out.push({
      id: `garmlink-${String(idVal)}`,
      name: String(r.activityName ?? r.activity_name ?? r.name ?? r.title ?? 'Garmin Activity'),
      date: dateRaw ? dateRaw.slice(0, 10) : new Date().toISOString().slice(0, 10),
      activity_type: typeKey,
      distance_m: Math.round(distanceM),
      duration_s: Math.round(durationS),
      avg_hr: toFiniteNumber(r.averageHR ?? r.average_hr ?? r.avg_hr ?? r.avgHr),
      max_hr: toFiniteNumber(r.maxHR ?? r.max_hr ?? r.maxHr),
      elevation_gain_ft: elevFt != null ? Math.round(elevFt) : elevM != null ? Math.round(elevM * 3.28084) : 0,
      avg_cadence: toFiniteNumber(
        r.averageRunningCadenceInStepsPerMinute ?? r.avg_cadence ?? r.averageCadence ?? r.cadence
      ),
      source: 'garmlink_mcp',
      source_label: 'Garmlink MCP',
    });
  }

  return out
    .filter((a) => a.distance_m > 0 || a.duration_s > 0)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function normalizeHrvStatus(raw: unknown): HrvStatus {
  const s = String(raw ?? 'BALANCED').toUpperCase();
  if (s.includes('POOR')) return 'POOR';
  if (s.includes('UNBALANCED')) return 'UNBALANCED';
  if (s.includes('LOW')) return 'LOW';
  return 'BALANCED';
}

function findFirstNumberDeep(obj: unknown, keys: string[], depth = 0): number | null {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstNumberDeep(item, keys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (rec[k] !== undefined && rec[k] !== null) {
      const n = toFiniteNumber(rec[k]);
      if (n !== null) return n;
    }
  }
  for (const val of Object.values(rec)) {
    if (val && typeof val === 'object') {
      const found = findFirstNumberDeep(val, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function findFirstStringDeep(obj: unknown, keys: string[], depth = 0): string | null {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstStringDeep(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (typeof rec[k] === 'string' && rec[k].trim()) return rec[k].trim();
  }
  for (const val of Object.values(rec)) {
    if (val && typeof val === 'object') {
      const found = findFirstStringDeep(val, keys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Combine multiple Garmlink MCP health/physiology tool results into one clean HealthSnapshot.
 * Returns null if no real watch metrics were found.
 */
export function normalizeGarmlinkHealth(
  payloads: Record<string, unknown>,
  activities: WatchActivity[] = []
): HealthSnapshot | null {
  const unwrapped = Object.values(payloads)
    .map((p) => unwrapMcpToolResult(p))
    .filter((p) => p !== null && p !== undefined);

  if (unwrapped.length === 0) return null;

  const vo2max = findFirstNumberDeep(unwrapped, ['vo2MaxPreciseValue', 'vo2MaxValue', 'vo2_max', 'vo2max']);
  const hrvLastNight = findFirstNumberDeep(unwrapped, ['lastNightAvg', 'last_night_avg', 'hrv_last_night', 'lastNight', 'overnightAvg']);
  const hrvWeekly = findFirstNumberDeep(unwrapped, ['weeklyAvg', 'weekly_avg', 'hrv_weekly_avg']);
  const hrvLow = findFirstNumberDeep(unwrapped, ['balancedLow', 'baseline_low', 'hrv_baseline_low']) ?? 48;
  const hrvHigh = findFirstNumberDeep(unwrapped, ['balancedUpper', 'baseline_high', 'hrv_baseline_high']) ?? 74;
  const hrvStatusStr = findFirstStringDeep(unwrapped, ['hrvStatus', 'hrv_status', 'status']);

  const sleepScore = findFirstNumberDeep(unwrapped, ['sleepScore', 'sleep_score', 'overallScore', 'score']);
  const sleepSeconds = findFirstNumberDeep(unwrapped, ['sleepTimeSeconds', 'sleep_seconds', 'totalSleepSeconds', 'durationInSeconds']);
  const sleepHoursRaw = findFirstNumberDeep(unwrapped, ['sleep_hours', 'sleepHours']);
  const sleepHours =
    sleepHoursRaw !== null
      ? Number(sleepHoursRaw.toFixed(1))
      : sleepSeconds !== null
        ? Number((sleepSeconds / 3600).toFixed(1))
        : null;

  const bodyBattery = findFirstNumberDeep(unwrapped, [
    'bodyBatteryMostRecentValue',
    'bodyBatteryHighestValue',
    'body_battery',
    'bodyBattery',
    'chargedValue',
  ]);
  const restingHr = findFirstNumberDeep(unwrapped, ['restingHeartRate', 'resting_hr', 'restingHr', 'minAvgHeartRate']);
  const stressAvg = findFirstNumberDeep(unwrapped, ['averageStressLevel', 'stress_avg', 'avgStressLevel']);
  const loadLow = findFirstNumberDeep(unwrapped, ['monthlyLoadAerobicLow', 'load_aerobic_low', 'aerobicLow']);
  const loadHigh = findFirstNumberDeep(unwrapped, ['monthlyLoadAerobicHigh', 'load_aerobic_high', 'aerobicHigh']);
  const loadAnaerobic = findFirstNumberDeep(unwrapped, ['monthlyLoadAnaerobic', 'load_anaerobic', 'anaerobic']);

  // Compute consecutive run days from real synced activities
  const runDates = new Set(
    activities
      .filter((a) => a.distance_m >= 500)
      .map((a) => a.date)
  );
  let consecutiveRunDays = 0;
  const cursor = new Date();
  for (let i = 0; i < 14; i++) {
    const key = cursor.toISOString().slice(0, 10);
    if (runDates.has(key)) {
      consecutiveRunDays += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else if (i === 0) {
      // Allow checking starting yesterday if user hasn't run yet today
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }

  const hasAnyMetric =
    vo2max !== null ||
    hrvLastNight !== null ||
    sleepScore !== null ||
    bodyBattery !== null ||
    restingHr !== null ||
    loadLow !== null;

  if (!hasAnyMetric) return null;

  return {
    date: new Date().toISOString().slice(0, 10),
    vo2max: vo2max !== null ? Number(vo2max.toFixed(1)) : null,
    hrv_last_night: hrvLastNight !== null ? Math.round(hrvLastNight) : null,
    hrv_weekly_avg: hrvWeekly !== null ? Math.round(hrvWeekly) : null,
    hrv_status: normalizeHrvStatus(hrvStatusStr),
    hrv_baseline_low: Math.round(hrvLow),
    hrv_baseline_high: Math.round(hrvHigh),
    sleep_score: sleepScore !== null ? Math.round(sleepScore) : null,
    sleep_hours: sleepHours,
    body_battery: bodyBattery !== null ? Math.round(bodyBattery) : null,
    resting_hr: restingHr !== null ? Math.round(restingHr) : null,
    stress_avg: stressAvg !== null ? Math.round(stressAvg) : null,
    load_anaerobic: loadAnaerobic !== null ? Math.round(loadAnaerobic) : null,
    load_aerobic_low: loadLow !== null ? Math.round(loadLow) : null,
    load_aerobic_high: loadHigh !== null ? Math.round(loadHigh) : null,
    consecutive_run_days: consecutiveRunDays,
    source: 'garmlink_mcp',
    synced_at: new Date().toISOString(),
  };
}

const GARMIN_PR_DIST_MAP: Record<number, { distance_m: number; label: string }> = {
  1: { distance_m: 1000, label: '1K' },
  2: { distance_m: 1609.344, label: 'Mile' },
  3: { distance_m: 5000, label: '5K' },
  4: { distance_m: 10000, label: '10K' },
  5: { distance_m: 21097.5, label: 'Half Marathon' },
  6: { distance_m: 42195, label: 'Marathon' },
};

/**
 * Normalize Personal Records returned by Garmlink MCP into RaceKit Effort records.
 */
export function normalizeGarmlinkPrs(raw: unknown): Effort[] {
  const payload = unwrapMcpToolResult(raw);
  let rows: unknown[] = [];
  if (Array.isArray(payload)) {
    rows = payload;
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const candidate = obj.personal_records ?? obj.personalRecords ?? obj.records ?? obj.items ?? obj.data;
    if (Array.isArray(candidate)) rows = candidate;
  }

  const out: Effort[] = [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i];
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const typeId = toFiniteNumber(r.typeId ?? r.type_id);
    let distM: number | null = null;
    let label = '';

    if (typeId && GARMIN_PR_DIST_MAP[typeId]) {
      distM = GARMIN_PR_DIST_MAP[typeId].distance_m;
      label = GARMIN_PR_DIST_MAP[typeId].label;
    } else {
      const nameStr = String(r.pr_name ?? r.typeKey ?? r.personalRecordType ?? r.label ?? '').toLowerCase();
      if (nameStr.includes('1k') || nameStr.includes('1_km')) {
        distM = 1000;
        label = '1K';
      } else if (nameStr.includes('mile') && !nameStr.includes('5')) {
        distM = 1609.344;
        label = 'Mile';
      } else if (nameStr.includes('5k') || nameStr.includes('5_km')) {
        distM = 5000;
        label = '5K';
      } else if (nameStr.includes('10k') || nameStr.includes('10_km')) {
        distM = 10000;
        label = '10K';
      } else if (nameStr.includes('half')) {
        distM = 21097.5;
        label = 'Half Marathon';
      } else if (nameStr.includes('marathon')) {
        distM = 42195;
        label = 'Marathon';
      }
    }

    const timeS = toFiniteNumber(r.value ?? r.value_raw ?? r.prValue ?? r.time_s);
    if (distM && timeS && timeS > 30) {
      const dateRaw = String(
        r.actStartDateTimeInGMTFormatted ?? r.prStartTimeGmtFormatted ?? r.date_gmt ?? r.date ?? ''
      );
      out.push({
        id: `gm-pr-${label.toLowerCase().replace(/\s+/g, '-')}`,
        distance_m: distM,
        time_s: Number(timeS.toFixed(2)),
        date: dateRaw ? dateRaw.slice(0, 10) : new Date().toISOString().slice(0, 10),
        source: 'garmlink_pr',
        label,
      });
    }
  }
  return out;
}

/**
 * Translate Open-Meteo WMO weather code into a concise label.
 */
export function describeWmoWeather(code: number): string {
  if (code === 0) return 'Clear Sky';
  if (code === 1) return 'Mainly Clear';
  if (code === 2) return 'Partly Cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Rain Showers';
  if (code >= 85 && code <= 86) return 'Snow Showers';
  if (code >= 95) return 'Thunderstorm';
  return 'Fair';
}

/**
 * Convert meteorological wind degrees (0-360) to 16-point compass string.
 */
export function degreesToCompass(deg: number | null | undefined): string {
  if (deg === null || deg === undefined || !Number.isFinite(deg)) return 'Var';
  const dirs = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return dirs[idx];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractHrCapNumber(hrCapStr: string): number {
  const m = hrCapStr.match(/(\d{3})/);
  return m ? Math.min(205, Math.max(115, Number(m[1]))) : 145;
}

/**
 * Generate Garmin Connect-compatible JSON workout payload for pushing AI workouts to a watch.
 */
export function buildGarminWorkoutJson(workout: DailyWorkout): string {
  const cap = extractHrCapNumber(workout.hr_cap);
  const meters = Math.round(Math.max(workout.distance_miles, 0.5) * 1609.344);
  const payload = {
    workoutName: `RaceKit: ${workout.name}`,
    description: `${workout.description} | Guardrail: ${workout.injury_prevention_note}`,
    sportType: { sportTypeId: 1, sportTypeKey: 'running' },
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: { sportTypeId: 1, sportTypeKey: 'running' },
        workoutSteps: [
          {
            type: 'ExecutableStepDTO',
            stepOrder: 1,
            stepType: { stepTypeId: 3, stepTypeKey: 'interval' },
            endCondition: { conditionTypeId: 3, conditionTypeKey: 'distance' },
            endConditionValue: meters,
            targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: 'heart.rate.zone' },
            targetValueOne: Math.max(110, cap - 20),
            targetValueTwo: cap,
            description: `${workout.pace_target} · HR ${workout.hr_cap}`,
          },
        ],
      },
    ],
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Generate Garmin Training Center XML (.TCX) workout file for direct watch import.
 */
export function buildGarminWorkoutTcx(workout: DailyWorkout): string {
  const cap = extractHrCapNumber(workout.hr_cap);
  const lowHr = Math.max(110, cap - 20);
  const meters = Math.round(Math.max(workout.distance_miles, 0.5) * 1609.344);
  const safeName = escapeXml(`RaceKit - ${workout.name}`.slice(0, 60));
  const safeNotes = escapeXml(
    `${workout.pace_target} | HR ${workout.hr_cap} | ${workout.description}`
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Workouts>
    <Workout Sport="Running">
      <Name>${safeName}</Name>
      <Step xsi:type="Step_t">
        <StepId>1</StepId>
        <Name>${escapeXml(workout.name.slice(0, 40))}</Name>
        <Duration xsi:type="Distance_t">
          <Meters>${meters}</Meters>
        </Duration>
        <Intensity>Active</Intensity>
        <Target xsi:type="HeartRate_t">
          <HeartRateZone xsi:type="CustomHeartRateZone_t">
            <Low xsi:type="HeartRateInBeatsPerMinute_t"><Value>${lowHr}</Value></Low>
            <High xsi:type="HeartRateInBeatsPerMinute_t"><Value>${cap}</Value></High>
          </HeartRateZone>
        </Target>
      </Step>
      <Notes>${safeNotes}</Notes>
    </Workout>
  </Workouts>
</TrainingCenterDatabase>`;
}
