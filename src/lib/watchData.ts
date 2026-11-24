import type {
  DailyWorkout,
  Effort,
  GarminExtras,
  GarminZone,
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
    const summary = (r.summaryDTO && typeof r.summaryDTO === 'object')
      ? (r.summaryDTO as Record<string, unknown>)
      : {};

    // Handle distance in meters or km/miles depending on Garmlink field names
    let distanceM =
      toFiniteNumber(r.distance_m) ??
      toFiniteNumber(r.distanceMeters) ??
      toFiniteNumber(r.distance) ??
      toFiniteNumber(summary.distance) ??
      toFiniteNumber(summary.distanceMeters) ??
      0;
    const distKm = toFiniteNumber(r.distance_km ?? r.distanceKm ?? summary.distanceKm);
    const distMi = toFiniteNumber(r.distance_miles ?? r.distanceMiles ?? summary.distanceMiles);
    if (distanceM === 0 && distKm) distanceM = distKm * 1000;
    if (distanceM === 0 && distMi) distanceM = distMi * 1609.344;

    const durationS =
      toFiniteNumber(r.duration_s) ??
      toFiniteNumber(r.durationSeconds) ??
      toFiniteNumber(r.duration) ??
      toFiniteNumber(summary.duration) ??
      toFiniteNumber(r.movingDuration) ??
      toFiniteNumber(summary.movingDuration) ??
      (toFiniteNumber(r.duration_min) ? toFiniteNumber(r.duration_min)! * 60 : 0);

    const rawType = r.activityType ?? summary.activityType ?? r.activity_type ?? r.type ?? r.sport;
    const typeKey =
      rawType && typeof rawType === 'object'
        ? String((rawType as Record<string, unknown>).typeKey ?? (rawType as Record<string, unknown>).name ?? 'running')
        : String(rawType ?? 'running');

    // garmlink_activities_list nests elevation in activity.brief.elevation_gain_m (meters)
    const brief = (r.brief && typeof r.brief === 'object' ? r.brief : {}) as Record<string, unknown>;
    const elevM = toFiniteNumber(
      brief.elevation_gain_m ??
      brief.elevation_gain ??
      brief.elevationGain ??
      r.elevationGain ??
      summary.elevationGain ??
      r.elevation_gain_m ??
      summary.elevation_gain_m ??
      r.elevation_gain ??
      summary.elevation_gain ??
      r.totalElevationGain ??
      summary.totalElevationGain ??
      r.totalAscent ??
      summary.totalAscent ??
      r.elevationGainMeters ??
      summary.elevationGainMeters ??
      r.ascent ??
      summary.ascent ??
      r.gain ??
      summary.gain
    );
    const elevFt = toFiniteNumber(
      r.elevation_gain_ft ??
      summary.elevation_gain_ft ??
      r.elevationGainFt ??
      summary.elevationGainFt ??
      r.elevationGainInFeet ??
      summary.elevationGainInFeet ??
      r.totalElevationGainInFeet
    );

    const dateRaw = String(
      r.startTimeLocal ?? summary.startTimeLocal ?? r.start_time_local ?? r.startTimeGMT ?? summary.startTimeGMT ?? r.start_time ?? r.date ?? ''
    );

    const idVal = r.activityId ?? summary.activityId ?? r.activity_id ?? r.garmin_id ?? r.id ?? `gm-${i}-${dateRaw}`;

    const computedElevFt = elevFt != null
      ? Math.round(elevFt)
      : elevM != null
        ? Math.round(elevM * 3.28084)
        : null;

    out.push({
      id: `garmin-${String(idVal).replace(/^garmin-/, '')}`,
      name: String(r.activityName ?? summary.activityName ?? r.activity_name ?? r.name ?? r.title ?? 'Garmin Activity'),
      date: dateRaw ? dateRaw.slice(0, 10) : new Date().toISOString().slice(0, 10),
      activity_type: typeKey,
      distance_m: Math.round(distanceM),
      duration_s: Math.round(durationS),
      avg_hr: toFiniteNumber(r.averageHR ?? summary.averageHR ?? r.average_hr ?? r.avg_hr ?? r.avgHr),
      max_hr: toFiniteNumber(r.maxHR ?? summary.maxHR ?? r.max_hr ?? r.maxHr),
      elevation_gain_ft: computedElevFt ?? 0,
      avg_cadence: toFiniteNumber(
        r.averageRunningCadenceInStepsPerMinute ?? summary.averageRunningCadenceInStepsPerMinute ?? r.avg_cadence ?? r.averageCadence ?? r.cadence
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
  const restingHr7d = findFirstNumberDeep(unwrapped, ['lastSevenDaysAvgRestingHeartRate', 'resting_hr_avg_7d', 'avgRestingHeartRate']);
  const stressAvg = findFirstNumberDeep(unwrapped, ['averageStressLevel', 'stress_avg', 'avgStressLevel']);
  const loadLow = findFirstNumberDeep(unwrapped, ['monthlyLoadAerobicLow', 'load_aerobic_low', 'aerobicLow']);
  const loadHigh = findFirstNumberDeep(unwrapped, ['monthlyLoadAerobicHigh', 'load_aerobic_high', 'aerobicHigh']);
  const loadAnaerobic = findFirstNumberDeep(unwrapped, ['monthlyLoadAnaerobic', 'load_anaerobic', 'anaerobic']);
  const acuteLoad = findFirstNumberDeep(unwrapped, ['dailyTrainingLoadAcute', 'acute_load', 'acuteTrainingLoad']);
  const chronicLoad = findFirstNumberDeep(unwrapped, ['dailyTrainingLoadChronic', 'chronic_load', 'chronicTrainingLoad']);
  const acwrRatio = findFirstNumberDeep(unwrapped, ['dailyAcuteChronicWorkloadRatio', 'acwr_ratio', 'acwr']);

  const bbHighest = findFirstNumberDeep(unwrapped, ['bodyBatteryHighestValue', 'bb_highest']) ?? bodyBattery;
  const bbWake = findFirstNumberDeep(unwrapped, ['bodyBatteryAtWakeTime', 'bb_at_wake']);
  const bbCharged = findFirstNumberDeep(unwrapped, ['bodyBatteryChargedValue', 'bb_charged']);
  const bbDrained = findFirstNumberDeep(unwrapped, ['bodyBatteryDrainedValue', 'bb_drained']);

  const deepS = findFirstNumberDeep(unwrapped, ['deepSleepSeconds', 'deep_sleep_s']);
  const lightS = findFirstNumberDeep(unwrapped, ['lightSleepSeconds', 'light_sleep_s']);
  const remS = findFirstNumberDeep(unwrapped, ['remSleepSeconds', 'rem_sleep_s']);
  const awakeS = findFirstNumberDeep(unwrapped, ['awakeSleepSeconds', 'awake_sleep_s']);

  const totSleepSec = sleepSeconds ?? (sleepHours ? Math.round(sleepHours * 3600) : null);
  const totMin = totSleepSec ? Math.round(totSleepSec / 60) : null;
  const sleepTimeFmt = totMin ? `${Math.floor(totMin / 60)}h ${String(totMin % 60).padStart(2, '0')}m` : undefined;

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
    sleep_seconds: totSleepSec,
    sleep_time_fmt: sleepTimeFmt,
    deep_sleep_s: deepS,
    light_sleep_s: lightS,
    rem_sleep_s: remS,
    awake_sleep_s: awakeS,
    deep_min: deepS ? Math.round(deepS / 60) : undefined,
    light_min: lightS ? Math.round(lightS / 60) : undefined,
    rem_min: remS ? Math.round(remS / 60) : undefined,
    awake_min: awakeS ? Math.round(awakeS / 60) : undefined,
    body_battery: bodyBattery !== null ? Math.round(bodyBattery) : null,
    bb_highest: bbHighest !== null ? Math.round(bbHighest) : null,
    bb_at_wake: bbWake !== null ? Math.round(bbWake) : null,
    bb_charged: bbCharged !== null ? Math.round(bbCharged) : null,
    bb_drained: bbDrained !== null ? Math.round(bbDrained) : null,
    resting_hr: restingHr !== null ? Math.round(restingHr) : null,
    resting_hr_avg_7d: restingHr7d !== null ? Math.round(restingHr7d) : null,
    stress_avg: stressAvg !== null ? Math.round(stressAvg) : null,
    load_anaerobic: loadAnaerobic !== null ? Math.round(loadAnaerobic) : null,
    load_aerobic_low: loadLow !== null ? Math.round(loadLow) : null,
    load_aerobic_high: loadHigh !== null ? Math.round(loadHigh) : null,
    acute_load: acuteLoad !== null ? Math.round(acuteLoad) : null,
    chronic_load: chronicLoad !== null ? Math.round(chronicLoad) : null,
    acwr_ratio: acwrRatio !== null ? Number(acwrRatio.toFixed(2)) : null,
    consecutive_run_days: consecutiveRunDays,
    source: 'garmlink_mcp',
    synced_at: new Date().toISOString(),
  };
}

const GARMIN_PR_DIST_MAP: Record<number, { distance_m: number; label: string }> = {
  1: { distance_m: 1000, label: '1K' },
  2: { distance_m: 1609.344, label: '1 Mile' },
  3: { distance_m: 5000, label: '5K' },
  4: { distance_m: 10000, label: '10K' },
  5: { distance_m: 21097.5, label: 'Half Marathon' },
  6: { distance_m: 42195, label: 'Marathon' },
};

function findPrRows(obj: unknown, depth = 0): unknown[] | null {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  if (Array.isArray(obj)) {
    const isPrArray = obj.some(
      (it) =>
        it &&
        typeof it === 'object' &&
        !Array.isArray(it) &&
        ((it as Record<string, unknown>).typeId !== undefined ||
          (it as Record<string, unknown>).type_id !== undefined)
    );
    if (isPrArray) return obj;
    for (const item of obj) {
      const found = findPrRows(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const val of Object.values(obj as Record<string, unknown>)) {
    if (val && typeof val === 'object') {
      const found = findPrRows(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Garmin "Longest Run" personal record (typeId 7, value in meters) from the latest PR snapshot.
 */
export function extractLongestRunPr(raw: unknown): { distance_m: number; date: string | null } | null {
  const rows = findPrRows(unwrapMcpToolResult(raw)) ?? [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (toFiniteNumber(r.typeId ?? r.type_id) !== 7) continue;
    const meters = toFiniteNumber(r.value ?? r.value_raw ?? r.prValue ?? r.distance_m);
    if (meters && meters > 100) {
      const dateRaw = String(
        r.actStartDateTimeInGMTFormatted ?? r.prStartTimeGmtFormatted ?? r.date_gmt ?? r.date ?? ''
      );
      return { distance_m: meters, date: dateRaw ? dateRaw.slice(0, 10) : null };
    }
  }
  return null;
}

/**
 * Normalize Personal Records returned by Garmlink MCP into RaceKit Effort records.
 */
export function normalizeGarmlinkPrs(raw: unknown): Effort[] {
  const payload = unwrapMcpToolResult(raw);
  // Garmlink returns snapshots (newest first), each holding the PR rows in `data[]`.
  // Depth-first search finds the latest snapshot's rows; flat arrays of PR rows also match.
  let rows: unknown[] = findPrRows(payload) ?? [];
  if (rows.length === 0) {
    if (Array.isArray(payload)) {
      rows = payload;
    } else if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      const candidate = obj.personal_records ?? obj.personalRecords ?? obj.records ?? obj.items ?? obj.data;
      if (Array.isArray(candidate)) rows = candidate;
    }
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
        label = '1 Mile';
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

// ── Extended Garmlink metrics (readiness, SpO2, daily rollup, LT, zones, fitness age) ──

function rowsOf(raw: unknown): Record<string, unknown>[] {
  const payload = unwrapMcpToolResult(raw);
  if (!payload || typeof payload !== 'object') return [];
  const asRows = (arr: unknown[]) =>
    arr.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object' && !Array.isArray(r));
  if (Array.isArray(payload)) return asRows(payload);
  const obj = payload as Record<string, unknown>;
  for (const key of ['days', 'data', 'items', 'rows', 'results', 'records', 'snapshots']) {
    if (Array.isArray(obj[key])) return asRows(obj[key] as unknown[]);
  }
  for (const val of Object.values(obj)) {
    if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === 'object') return asRows(val);
  }
  return [obj];
}

/** First non-null numeric value for any of `keys`, scanning the newest `maxRows` rows. */
function pickNum(rows: Record<string, unknown>[], keys: string[], maxRows = 3): number | null {
  for (const row of rows.slice(0, maxRows)) {
    for (const k of keys) {
      const n = toFiniteNumber(row[k]);
      if (n !== null) return n;
    }
    const deep = findFirstNumberDeep(row, keys);
    if (deep !== null) return deep;
  }
  return null;
}

function pickStr(rows: Record<string, unknown>[], keys: string[], maxRows = 1): string | null {
  for (const row of rows.slice(0, maxRows)) {
    const found = findFirstStringDeep(row, keys);
    if (found) return found;
  }
  return null;
}

interface ZoneCandidate {
  path: string;
  zones: GarminZone[];
  sport: string;
  ftp: number | null;
}

function collectZoneCandidates(obj: unknown, path = '', out: ZoneCandidate[] = [], depth = 0): ZoneCandidate[] {
  if (!obj || typeof obj !== 'object' || depth > 6) return out;
  if (Array.isArray(obj)) {
    // Shape B: [{ zone: 1, low: .., high: .. }, ...]
    const zoneRows = obj.filter(
      (it): it is Record<string, unknown> =>
        Boolean(it) &&
        typeof it === 'object' &&
        toFiniteNumber((it as any).zone ?? (it as any).number ?? (it as any).zoneNumber) !== null
    );
    if (zoneRows.length >= 3 && zoneRows.length === obj.length) {
      const zones = zoneRows
        .map((z) => ({
          zone: Number(z.zone ?? z.number ?? z.zoneNumber),
          low: toFiniteNumber(z.low ?? z.min ?? z.floor ?? z.from ?? z.low_watts ?? z.low_bpm ?? z.zoneLowBoundary),
          high: toFiniteNumber(z.high ?? z.max ?? z.ceiling ?? z.to ?? z.high_watts ?? z.high_bpm ?? z.zoneHighBoundary),
        }))
        .sort((a, b) => a.zone - b.zone);
      out.push({ path, zones, sport: '', ftp: null });
      return out;
    }
    for (const item of obj) collectZoneCandidates(item, path, out, depth + 1);
    return out;
  }
  const rec = obj as Record<string, unknown>;
  // Shape A (raw Garmin): { sport, zone1Floor..zone5Floor, maxHeartRateUsed | functionalThresholdPower }
  const floors = [1, 2, 3, 4, 5].map((i) =>
    toFiniteNumber(rec[`zone${i}Floor`] ?? rec[`zone${i}_floor`] ?? rec[`zone_${i}_floor`])
  );
  if (floors.filter((f) => f !== null).length >= 3) {
    const top = toFiniteNumber(rec.maxHeartRateUsed ?? rec.max_heart_rate_used ?? rec.max_hr);
    const zones: GarminZone[] = floors.map((f, i) => ({
      zone: i + 1,
      low: f,
      high: i < 4 ? (floors[i + 1] !== null ? floors[i + 1]! - 1 : null) : top,
    }));
    const ftp = toFiniteNumber(rec.functionalThresholdPower ?? rec.functional_threshold_power ?? rec.ftp);
    const isPower = ftp !== null || /power/i.test(path);
    out.push({
      path: isPower ? `${path}.power` : `${path}.heart`,
      zones,
      sport: String(rec.sport ?? rec.sport_type ?? ''),
      ftp,
    });
  }
  for (const [key, val] of Object.entries(rec)) {
    if (val && typeof val === 'object') collectZoneCandidates(val, `${path}.${key}`, out, depth + 1);
  }
  return out;
}

function chooseZones(cands: ZoneCandidate[], kind: 'power' | 'heart'): ZoneCandidate | null {
  const pool = cands.filter((c) =>
    kind === 'power' ? /power/i.test(c.path) : /heart|hr/i.test(c.path) && !/power/i.test(c.path)
  );
  const notCycling = pool.filter((c) => !/cycl|bik/i.test(`${c.sport} ${c.path}`));
  return (
    notCycling.find((c) => /run/i.test(`${c.sport} ${c.path}`)) ??
    (kind === 'heart' ? notCycling.find((c) => /default/i.test(c.sport)) : undefined) ??
    notCycling[0] ??
    (kind === 'heart' ? pool[0] : null) ??
    null
  );
}

const inRange = (n: number | null, lo: number, hi: number): number | null =>
  n !== null && n >= lo && n <= hi ? n : null;

/**
 * Normalize the extended Garmlink endpoints into a flat patch that is merged onto HealthSnapshot.
 * Every field stays null/absent when the watch did not report it (no invented values).
 */
export function normalizeGarminExtras(
  payloads: Record<string, unknown>
): GarminExtras & Partial<HealthSnapshot> & { vo2max_running?: number | null } {
  const out: GarminExtras & Partial<HealthSnapshot> & { vo2max_running?: number | null } = {};
  const r1 = (n: number | null) => (n !== null ? Number(n.toFixed(1)) : null);
  const r0 = (n: number | null) => (n !== null ? Math.round(n) : null);

  // Training Readiness (today = newest row)
  const readinessRows = rowsOf(payloads.readinessRaw);
  if (readinessRows.length > 0) {
    const today = readinessRows.slice(0, 1);
    const score = pickNum(today, ['score', 'readiness_score', 'trainingReadinessScore'], 1);
    const recoveryMin = pickNum(today, ['recovery_min', 'recoveryTime', 'recovery_time_min'], 1);
    if (score !== null) {
      out.readiness = {
        date: pickStr(today, ['date', 'calendarDate', 'calendar_date']),
        score: r0(score),
        level: pickStr(today, ['level', 'readiness_level']),
        feedback: pickStr(today, ['feedback', 'feedback_short', 'feedbackShort', 'feedbackLong']),
        recovery_hours: recoveryMin !== null ? r1(recoveryMin / 60) : null,
        factors: {
          sleep_score_pct: r0(pickNum(today, ['sleep_score_pct', 'sleepScoreFactorPercent'], 1)),
          recovery_pct: r0(pickNum(today, ['recovery_pct', 'recoveryTimeFactorPercent'], 1)),
          hrv_pct: r0(pickNum(today, ['hrv_pct', 'hrvFactorPercent'], 1)),
          sleep_history_pct: r0(pickNum(today, ['sleep_history_pct', 'sleepHistoryFactorPercent'], 1)),
          stress_history_pct: r0(pickNum(today, ['stress_history_pct', 'stressHistoryFactorPercent'], 1)),
          acwr_pct: r0(pickNum(today, ['acwr_pct', 'acwrFactorPercent', 'acute_load_pct'], 1)),
        },
      };
    }
  }

  // Garmin race predictions (seconds)
  const rp = unwrapMcpToolResult(payloads.racePredRaw);
  if (rp) {
    const t5 = inRange(findFirstNumberDeep(rp, ['time5K', 'time_5k', 'time_5k_s', 'time5k']), 600, 7200);
    const t10 = inRange(findFirstNumberDeep(rp, ['time10K', 'time_10k', 'time_10k_s', 'time10k']), 1200, 14400);
    const tH = inRange(
      findFirstNumberDeep(rp, ['timeHalfMarathon', 'time_half_marathon', 'time_half_marathon_s', 'time_half']),
      2700,
      28800
    );
    const tM = inRange(findFirstNumberDeep(rp, ['timeMarathon', 'time_marathon', 'time_marathon_s']), 6000, 57600);
    if (t5 !== null || t10 !== null || tH !== null || tM !== null) {
      out.garmin_race_predictions = { time_5k_s: t5, time_10k_s: t10, time_half_s: tH, time_marathon_s: tM };
    }
  }

  // Running VO2max from the dedicated history endpoint (never the cycling value)
  const vo2 = unwrapMcpToolResult(payloads.vo2maxRaw);
  if (vo2) {
    out.vo2max_running = r1(
      inRange(
        findFirstNumberDeep(vo2, [
          'vo2MaxPreciseValue',
          'vo2max_running',
          'vo2_max_running',
          'running_vo2max',
          'vo2max_precise',
          'vo2MaxValue',
          'vo2_max',
          'vo2max',
        ]),
        20,
        90
      )
    );
  }

  // SpO2
  const spo2Rows = rowsOf(payloads.spo2Raw);
  const sleepRows = rowsOf(payloads.sleepRaw);
  const spo2Sleep = inRange(
    pickNum(spo2Rows, ['avg_sleep', 'avgSleepSpo2', 'averageSpO2Value']) ??
      pickNum(sleepRows, ['avg_sleep_spo2', 'avg_spo2', 'averageSpO2Value'], 1),
    50,
    100
  );
  const spo2Avg = inRange(pickNum(spo2Rows, ['avg', 'averageSpo2', 'average_spo2']), 50, 100);
  const spo2Latest = inRange(pickNum(spo2Rows, ['latest', 'latestSpo2', 'latest_spo2']), 50, 100);
  if (spo2Sleep !== null) out.spo2_avg_sleep = r0(spo2Sleep);
  if (spo2Latest !== null) out.spo2_latest = r0(spo2Latest);
  if (spo2Avg !== null || spo2Sleep !== null) out.spo2_avg = r0(spo2Avg ?? spo2Sleep);

  // Daily rollup + dedicated getters
  const dayRows = rowsOf(payloads.summaryRaw);
  const stressRows = rowsOf(payloads.stressRaw);
  const respRows = rowsOf(payloads.respirationRaw);
  const stepRows = rowsOf(payloads.stepsRaw);
  const floorRows = rowsOf(payloads.floorsRaw);
  const imRows = rowsOf(payloads.intensityRaw);

  const stressAvg = inRange(
    pickNum(stressRows, ['avg', 'stress_avg', 'averageStressLevel']) ?? pickNum(dayRows, ['stress_avg', 'averageStressLevel']),
    0,
    100
  );
  const stressMax = inRange(
    pickNum(stressRows, ['max', 'stress_max', 'maxStressLevel']) ?? pickNum(dayRows, ['stress_max', 'maxStressLevel']),
    0,
    100
  );
  if (stressAvg !== null) out.stress_avg = r0(stressAvg);
  if (stressMax !== null) out.stress_max = r0(stressMax);

  const respSleep = inRange(pickNum(respRows, ['avg_sleep', 'avgSleepRespirationValue']), 4, 40);
  const respWake = inRange(pickNum(respRows, ['avg_waking', 'avgWakingRespirationValue']), 4, 40);
  if (respSleep !== null) {
    out.respiration_avg_sleep = r1(respSleep);
    out.respiration_avg = r1(respSleep);
  }
  if (respWake !== null) out.respiration_avg_waking = r1(respWake);

  const steps = pickNum(dayRows, ['steps', 'totalSteps'], 1) ?? pickNum(stepRows, ['steps', 'total', 'totalSteps'], 1);
  const stepGoal = pickNum(dayRows, ['step_goal', 'dailyStepGoal']);
  if (steps !== null) out.steps = r0(steps);
  if (stepGoal !== null) out.step_goal = r0(stepGoal);

  const bmr = pickNum(dayRows, ['bmr_calories', 'bmrKilocalories'], 1);
  const active = pickNum(dayRows, ['active_calories', 'activeKilocalories'], 1);
  const totalCal = pickNum(dayRows, ['calories', 'total_calories', 'totalKilocalories'], 1);
  if (bmr !== null) out.bmr_calories = r0(bmr);
  if (active !== null) out.active_calories = r0(active);
  if (totalCal !== null || (bmr !== null && active !== null)) {
    out.calories_total = r0(totalCal ?? bmr! + active!);
  }

  const floors =
    pickNum(dayRows, ['floors', 'floors_ascended', 'floorsAscended'], 1) ??
    pickNum(floorRows, ['ascended', 'floors_ascended', 'floors', 'floorsAscended'], 1);
  if (floors !== null) out.floors = r0(floors);

  const imTotal = pickNum(imRows, ['weekly_total', 'weeklyTotal']);
  const imGoal = pickNum(imRows, ['week_goal', 'weekGoal']) ?? pickNum(dayRows, ['intensity_minutes_goal']);
  if (imTotal !== null) out.intensity_weekly_total = r0(imTotal);
  if (imGoal !== null) out.intensity_week_goal = r0(imGoal);

  // Sleep stage minutes (Garmlink compact nightly object) — only fills real measured nights
  if (sleepRows.length > 0) {
    const night = sleepRows.slice(0, 1);
    const totalMin = pickNum(night, ['total_min', 'total_sleep_min'], 1);
    if (totalMin !== null && totalMin > 0) {
      out.sleep_seconds = Math.round(totalMin * 60);
      out.sleep_hours = Number((totalMin / 60).toFixed(1));
      out.sleep_time_fmt = `${Math.floor(totalMin / 60)}h ${String(Math.round(totalMin % 60)).padStart(2, '0')}m`;
      for (const k of ['deep_min', 'light_min', 'rem_min', 'awake_min'] as const) {
        const v = pickNum(night, [k], 1);
        if (v !== null) out[k] = Math.round(v);
      }
    }
  }

  // Lactate threshold + running power
  const lt = unwrapMcpToolResult(payloads.lactateRaw);
  if (lt) {
    const lthr = inRange(
      findFirstNumberDeep(lt, [
        'lthr_bpm',
        'lactate_threshold_hr',
        'lactateThresholdHeartRate',
        'heart_rate',
        'heartRate',
        'hr_bpm',
        'hr',
      ]),
      90,
      230
    );
    const ftp = inRange(
      findFirstNumberDeep(lt, ['functionalThresholdPower', 'running_ftp_w', 'ftp_w', 'ftp_watts', 'ftp', 'power_w']),
      50,
      800
    );
    const wkg = inRange(
      findFirstNumberDeep(lt, ['powerToWeight', 'power_to_weight', 'w_per_kg', 'ftp_w_per_kg', 'ftp_wkg', 'wkg']),
      0.5,
      10
    );
    if (lthr !== null) out.lthr_bpm = r0(lthr);
    if (ftp !== null) out.running_ftp_w = r0(ftp);
    if (wkg !== null) out.running_ftp_wkg = Number(wkg.toFixed(2));
  }

  // HR + running power zones
  const zonesPayload = unwrapMcpToolResult(payloads.zonesRaw);
  if (zonesPayload) {
    const cands = collectZoneCandidates(zonesPayload);
    const power = chooseZones(cands, 'power');
    const heart = chooseZones(cands, 'heart');
    if (power) {
      out.power_zones = power.zones;
      if (out.running_ftp_w == null && power.ftp !== null) out.running_ftp_w = Math.round(power.ftp);
    }
    if (heart) out.hr_zones = heart.zones;
  }

  // Fitness age
  const fa = unwrapMcpToolResult(payloads.fitnessAgeRaw);
  if (fa) {
    const age = inRange(findFirstNumberDeep(fa, ['fitnessAge', 'fitness_age']), 10, 100);
    const vig = findFirstNumberDeep(fa, ['vigorousMinutesAvg', 'vigorous_minutes_avg']);
    if (age !== null) out.fitness_age = r1(age);
    if (vig !== null) out.vigorous_minutes_avg = r0(vig);
  }

  // Longest-run PR
  const longest = extractLongestRunPr(payloads.prRaw);
  if (longest) {
    out.longest_run_m = Math.round(longest.distance_m);
    out.longest_run_date = longest.date;
  }

  return out;
}

/** One night/day of live Garmlink history for the 30-day Sleep + HRV charts. */
export interface GarmlinkHistoryDay {
  date: string;
  sleep_score: number | null;
  sleep_seconds: number | null;
  sleep_hours: number | null;
  sleep_time_fmt: string | null;
  deep_sleep_s: number | null;
  light_sleep_s: number | null;
  rem_sleep_s: number | null;
  awake_sleep_s: number | null;
  deep_min: number | null;
  light_min: number | null;
  rem_min: number | null;
  awake_min: number | null;
  spo2_avg: number | null;
  respiration_avg: number | null;
  sleep_stress_avg: number | null;
  hrv_last_night: number | null;
  hrv_weekly_avg: number | null;
  hrv_status: string | null;
  hrv_baseline_low: number | null;
  hrv_baseline_high: number | null;
  resting_hr: number | null;
  source: 'garmlink_mcp';
}

const HISTORY_DATE_KEYS = ['date', 'calendar_date', 'calendarDate', 'day', 'sleep_date'];

function rowDate(row: Record<string, unknown>): string | null {
  for (const k of HISTORY_DATE_KEYS) {
    const v = row[k];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  return null;
}

function rowNum(row: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!row) return null;
  for (const k of keys) {
    const n = toFiniteNumber(row[k]);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Build per-day history from the nightly rows of garmlink_sleep_get / garmlink_hrv_get
 * (+ daily summary for resting HR). Every measured night returned by Garmlink gets a record;
 * unmeasured nights simply have no record / null fields (never invented). Newest first.
 */
export function buildGarmlinkHealthHistory(payloads: {
  sleepRaw?: unknown;
  hrvRaw?: unknown;
  summaryRaw?: unknown;
}): GarmlinkHistoryDay[] {
  const index = (raw: unknown) => {
    const map = new Map<string, Record<string, unknown>>();
    if (raw == null) return map;
    for (const row of rowsOf(raw)) {
      const d = rowDate(row);
      if (d && !map.has(d)) map.set(d, row);
    }
    return map;
  };
  const sleepByDate = index(payloads.sleepRaw);
  const hrvByDate = index(payloads.hrvRaw);
  const dayByDate = index(payloads.summaryRaw);

  const dates = new Set<string>([...sleepByDate.keys(), ...hrvByDate.keys()]);
  const out: GarmlinkHistoryDay[] = [];
  const round = (n: number | null) => (n !== null ? Math.round(n) : null);

  for (const date of dates) {
    const s = sleepByDate.get(date);
    const h = hrvByDate.get(date);
    const d = dayByDate.get(date);

    const totalMinRaw = rowNum(s, ['total_min', 'total_sleep_min']);
    const totalSecRaw = rowNum(s, ['sleep_seconds', 'sleepTimeSeconds', 'total_sleep_s']);
    const totalMin =
      totalMinRaw !== null && totalMinRaw > 0
        ? totalMinRaw
        : totalSecRaw !== null && totalSecRaw > 0
          ? totalSecRaw / 60
          : null;
    const stage = (k: string) => (totalMin !== null ? round(rowNum(s, [k])) : null);
    const deep = stage('deep_min');
    const light = stage('light_min');
    const rem = stage('rem_min');
    const awake = stage('awake_min');

    const hrv = rowNum(h, ['last_night_avg', 'lastNightAvg', 'hrv_last_night']) ?? rowNum(s, ['overnight_hrv']);
    const hrvStatus = (h?.status ?? h?.hrv_status ?? s?.hrv_status ?? null) as unknown;

    if (totalMin === null && hrv === null) continue;

    out.push({
      date,
      sleep_score: totalMin !== null ? round(rowNum(s, ['score', 'sleep_score', 'overall_score', 'sleepScore'])) : null,
      sleep_seconds: totalMin !== null ? Math.round(totalMin * 60) : null,
      sleep_hours: totalMin !== null ? Number((totalMin / 60).toFixed(2)) : null,
      sleep_time_fmt:
        totalMin !== null
          ? `${Math.floor(totalMin / 60)}h ${String(Math.floor(totalMin % 60)).padStart(2, '0')}m`
          : null,
      deep_sleep_s: deep !== null ? deep * 60 : null,
      light_sleep_s: light !== null ? light * 60 : null,
      rem_sleep_s: rem !== null ? rem * 60 : null,
      awake_sleep_s: awake !== null ? awake * 60 : null,
      deep_min: deep,
      light_min: light,
      rem_min: rem,
      awake_min: awake,
      spo2_avg: inRange(rowNum(s, ['avg_sleep_spo2', 'avg_spo2', 'averageSpO2Value']), 50, 100),
      respiration_avg: inRange(rowNum(s, ['avg_respiration', 'averageRespirationValue']), 4, 40),
      sleep_stress_avg: rowNum(s, ['avg_sleep_stress', 'avg_stress', 'avgSleepStress']),
      hrv_last_night: hrv !== null ? Number(hrv.toFixed(1)) : null,
      hrv_weekly_avg: round(rowNum(h, ['weekly_avg', 'weeklyAvg', 'hrv_weekly_avg'])),
      hrv_status: typeof hrvStatus === 'string' && hrvStatus ? hrvStatus.toUpperCase() : null,
      hrv_baseline_low: round(rowNum(h, ['baseline_low', 'balancedLow', 'hrv_baseline_low'])),
      hrv_baseline_high: round(rowNum(h, ['baseline_high', 'balancedUpper', 'hrv_baseline_high'])),
      resting_hr: round(
        rowNum(d, ['resting_hr', 'restingHeartRate', 'rhr']) ?? rowNum(s, ['resting_hr', 'restingHeartRate'])
      ),
      source: 'garmlink_mcp',
    });
  }

  return out.sort((a, b) => b.date.localeCompare(a.date));
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
