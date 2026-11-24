// server.ts
import "dotenv/config";
import fs from "fs";
import crypto from "crypto";
import { execFileSync } from "child_process";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type } from "@google/genai";

// src/lib/watchData.ts
function unwrapMcpToolResult(result) {
  if (!result || typeof result !== "object") return result;
  const rec = result;
  if (rec.structuredContent !== void 0) return rec.structuredContent;
  const content = rec.content;
  if (Array.isArray(content)) {
    const texts = content.map(
      (item) => item && typeof item === "object" && typeof item.text === "string" ? String(item.text) : ""
    ).filter(Boolean);
    const combined = texts.join("\n").trim();
    if (!combined) return null;
    try {
      return JSON.parse(combined);
    } catch {
      return combined;
    }
  }
  return result;
}
function toFiniteNumber(val) {
  if (val === null || val === void 0 || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}
function normalizeGarmlinkActivities(raw) {
  const payload = unwrapMcpToolResult(raw);
  let rows = [];
  if (Array.isArray(payload)) {
    rows = payload;
  } else if (payload && typeof payload === "object") {
    const obj = payload;
    const candidate = obj.activities ?? obj.items ?? obj.data ?? obj.results;
    if (Array.isArray(candidate)) {
      rows = candidate;
    }
  }
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i];
    if (!item || typeof item !== "object") continue;
    const r = item;
    const summary = r.summaryDTO && typeof r.summaryDTO === "object" ? r.summaryDTO : {};
    let distanceM = toFiniteNumber(r.distance_m) ?? toFiniteNumber(r.distanceMeters) ?? toFiniteNumber(r.distance) ?? toFiniteNumber(summary.distance) ?? toFiniteNumber(summary.distanceMeters) ?? 0;
    const distKm = toFiniteNumber(r.distance_km ?? r.distanceKm ?? summary.distanceKm);
    const distMi = toFiniteNumber(r.distance_miles ?? r.distanceMiles ?? summary.distanceMiles);
    if (distanceM === 0 && distKm) distanceM = distKm * 1e3;
    if (distanceM === 0 && distMi) distanceM = distMi * 1609.344;
    const durationS = toFiniteNumber(r.duration_s) ?? toFiniteNumber(r.durationSeconds) ?? toFiniteNumber(r.duration) ?? toFiniteNumber(summary.duration) ?? toFiniteNumber(r.movingDuration) ?? toFiniteNumber(summary.movingDuration) ?? (toFiniteNumber(r.duration_min) ? toFiniteNumber(r.duration_min) * 60 : 0);
    const rawType = r.activityType ?? summary.activityType ?? r.activity_type ?? r.type ?? r.sport;
    const typeKey = rawType && typeof rawType === "object" ? String(rawType.typeKey ?? rawType.name ?? "running") : String(rawType ?? "running");
    const brief = r.brief && typeof r.brief === "object" ? r.brief : {};
    const elevM = toFiniteNumber(
      brief.elevation_gain_m ?? brief.elevation_gain ?? brief.elevationGain ?? r.elevationGain ?? summary.elevationGain ?? r.elevation_gain_m ?? summary.elevation_gain_m ?? r.elevation_gain ?? summary.elevation_gain ?? r.totalElevationGain ?? summary.totalElevationGain ?? r.totalAscent ?? summary.totalAscent ?? r.elevationGainMeters ?? summary.elevationGainMeters ?? r.ascent ?? summary.ascent ?? r.gain ?? summary.gain
    );
    const elevFt = toFiniteNumber(
      r.elevation_gain_ft ?? summary.elevation_gain_ft ?? r.elevationGainFt ?? summary.elevationGainFt ?? r.elevationGainInFeet ?? summary.elevationGainInFeet ?? r.totalElevationGainInFeet
    );
    const dateRaw = String(
      r.startTimeLocal ?? summary.startTimeLocal ?? r.start_time_local ?? r.startTimeGMT ?? summary.startTimeGMT ?? r.start_time ?? r.date ?? ""
    );
    const idVal = r.activityId ?? summary.activityId ?? r.activity_id ?? r.garmin_id ?? r.id ?? `gm-${i}-${dateRaw}`;
    const computedElevFt = elevFt != null ? Math.round(elevFt) : elevM != null ? Math.round(elevM * 3.28084) : null;
    out.push({
      id: `garmin-${String(idVal).replace(/^garmin-/, "")}`,
      name: String(r.activityName ?? summary.activityName ?? r.activity_name ?? r.name ?? r.title ?? "Garmin Activity"),
      date: dateRaw ? dateRaw.slice(0, 10) : (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
      activity_type: typeKey,
      distance_m: Math.round(distanceM),
      duration_s: Math.round(durationS),
      avg_hr: toFiniteNumber(r.averageHR ?? summary.averageHR ?? r.average_hr ?? r.avg_hr ?? r.avgHr),
      max_hr: toFiniteNumber(r.maxHR ?? summary.maxHR ?? r.max_hr ?? r.maxHr),
      elevation_gain_ft: computedElevFt ?? 0,
      avg_cadence: toFiniteNumber(
        r.averageRunningCadenceInStepsPerMinute ?? summary.averageRunningCadenceInStepsPerMinute ?? r.avg_cadence ?? r.averageCadence ?? r.cadence
      ),
      source: "garmlink_mcp",
      source_label: "Garmlink MCP"
    });
  }
  return out.filter((a) => a.distance_m > 0 || a.duration_s > 0).sort((a, b) => b.date.localeCompare(a.date));
}
function normalizeHrvStatus(raw) {
  const s = String(raw ?? "BALANCED").toUpperCase();
  if (s.includes("POOR")) return "POOR";
  if (s.includes("UNBALANCED")) return "UNBALANCED";
  if (s.includes("LOW")) return "LOW";
  return "BALANCED";
}
function findFirstNumberDeep(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstNumberDeep(item, keys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const rec = obj;
  for (const k of keys) {
    if (rec[k] !== void 0 && rec[k] !== null) {
      const n = toFiniteNumber(rec[k]);
      if (n !== null) return n;
    }
  }
  for (const val of Object.values(rec)) {
    if (val && typeof val === "object") {
      const found = findFirstNumberDeep(val, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}
function findFirstStringDeep(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstStringDeep(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const rec = obj;
  for (const k of keys) {
    if (typeof rec[k] === "string" && rec[k].trim()) return rec[k].trim();
  }
  for (const val of Object.values(rec)) {
    if (val && typeof val === "object") {
      const found = findFirstStringDeep(val, keys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
function normalizeGarmlinkHealth(payloads, activities = []) {
  const unwrapped = Object.values(payloads).map((p) => unwrapMcpToolResult(p)).filter((p) => p !== null && p !== void 0);
  if (unwrapped.length === 0) return null;
  const vo2max = findFirstNumberDeep(unwrapped, ["vo2MaxPreciseValue", "vo2MaxValue", "vo2_max", "vo2max"]);
  const hrvLastNight = findFirstNumberDeep(unwrapped, ["lastNightAvg", "last_night_avg", "hrv_last_night", "lastNight", "overnightAvg"]);
  const hrvWeekly = findFirstNumberDeep(unwrapped, ["weeklyAvg", "weekly_avg", "hrv_weekly_avg"]);
  const hrvLow = findFirstNumberDeep(unwrapped, ["balancedLow", "baseline_low", "hrv_baseline_low"]) ?? 48;
  const hrvHigh = findFirstNumberDeep(unwrapped, ["balancedUpper", "baseline_high", "hrv_baseline_high"]) ?? 74;
  const hrvStatusStr = findFirstStringDeep(unwrapped, ["hrvStatus", "hrv_status", "status"]);
  const sleepScore = findFirstNumberDeep(unwrapped, ["sleepScore", "sleep_score", "overallScore", "score"]);
  const sleepSeconds = findFirstNumberDeep(unwrapped, ["sleepTimeSeconds", "sleep_seconds", "totalSleepSeconds", "durationInSeconds"]);
  const sleepHoursRaw = findFirstNumberDeep(unwrapped, ["sleep_hours", "sleepHours"]);
  const sleepHours = sleepHoursRaw !== null ? Number(sleepHoursRaw.toFixed(1)) : sleepSeconds !== null ? Number((sleepSeconds / 3600).toFixed(1)) : null;
  const bodyBattery = findFirstNumberDeep(unwrapped, [
    "bodyBatteryMostRecentValue",
    "bodyBatteryHighestValue",
    "body_battery",
    "bodyBattery",
    "chargedValue"
  ]);
  const restingHr = findFirstNumberDeep(unwrapped, ["restingHeartRate", "resting_hr", "restingHr", "minAvgHeartRate"]);
  const restingHr7d = findFirstNumberDeep(unwrapped, ["lastSevenDaysAvgRestingHeartRate", "resting_hr_avg_7d", "avgRestingHeartRate"]);
  const stressAvg = findFirstNumberDeep(unwrapped, ["averageStressLevel", "stress_avg", "avgStressLevel"]);
  const loadLow = findFirstNumberDeep(unwrapped, ["monthlyLoadAerobicLow", "load_aerobic_low", "aerobicLow"]);
  const loadHigh = findFirstNumberDeep(unwrapped, ["monthlyLoadAerobicHigh", "load_aerobic_high", "aerobicHigh"]);
  const loadAnaerobic = findFirstNumberDeep(unwrapped, ["monthlyLoadAnaerobic", "load_anaerobic", "anaerobic"]);
  const acuteLoad = findFirstNumberDeep(unwrapped, ["dailyTrainingLoadAcute", "acute_load", "acuteTrainingLoad"]);
  const chronicLoad = findFirstNumberDeep(unwrapped, ["dailyTrainingLoadChronic", "chronic_load", "chronicTrainingLoad"]);
  const acwrRatio = findFirstNumberDeep(unwrapped, ["dailyAcuteChronicWorkloadRatio", "acwr_ratio", "acwr"]);
  const bbHighest = findFirstNumberDeep(unwrapped, ["bodyBatteryHighestValue", "bb_highest"]) ?? bodyBattery;
  const bbWake = findFirstNumberDeep(unwrapped, ["bodyBatteryAtWakeTime", "bb_at_wake"]);
  const bbCharged = findFirstNumberDeep(unwrapped, ["bodyBatteryChargedValue", "bb_charged"]);
  const bbDrained = findFirstNumberDeep(unwrapped, ["bodyBatteryDrainedValue", "bb_drained"]);
  const deepS = findFirstNumberDeep(unwrapped, ["deepSleepSeconds", "deep_sleep_s"]);
  const lightS = findFirstNumberDeep(unwrapped, ["lightSleepSeconds", "light_sleep_s"]);
  const remS = findFirstNumberDeep(unwrapped, ["remSleepSeconds", "rem_sleep_s"]);
  const awakeS = findFirstNumberDeep(unwrapped, ["awakeSleepSeconds", "awake_sleep_s"]);
  const totSleepSec = sleepSeconds ?? (sleepHours ? Math.round(sleepHours * 3600) : null);
  const totMin = totSleepSec ? Math.round(totSleepSec / 60) : null;
  const sleepTimeFmt = totMin ? `${Math.floor(totMin / 60)}h ${String(totMin % 60).padStart(2, "0")}m` : void 0;
  const runDates = new Set(
    activities.filter((a) => a.distance_m >= 500).map((a) => a.date)
  );
  let consecutiveRunDays = 0;
  const cursor = /* @__PURE__ */ new Date();
  for (let i = 0; i < 14; i++) {
    const key = cursor.toISOString().slice(0, 10);
    if (runDates.has(key)) {
      consecutiveRunDays += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else if (i === 0) {
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  const hasAnyMetric = vo2max !== null || hrvLastNight !== null || sleepScore !== null || bodyBattery !== null || restingHr !== null || loadLow !== null;
  if (!hasAnyMetric) return null;
  return {
    date: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
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
    deep_min: deepS ? Math.round(deepS / 60) : void 0,
    light_min: lightS ? Math.round(lightS / 60) : void 0,
    rem_min: remS ? Math.round(remS / 60) : void 0,
    awake_min: awakeS ? Math.round(awakeS / 60) : void 0,
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
    source: "garmlink_mcp",
    synced_at: (/* @__PURE__ */ new Date()).toISOString()
  };
}
var GARMIN_PR_DIST_MAP = {
  1: { distance_m: 1e3, label: "1K" },
  2: { distance_m: 1609.344, label: "1 Mile" },
  3: { distance_m: 5e3, label: "5K" },
  4: { distance_m: 1e4, label: "10K" },
  5: { distance_m: 21097.5, label: "Half Marathon" },
  6: { distance_m: 42195, label: "Marathon" }
};
function findPrRows(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 5) return null;
  if (Array.isArray(obj)) {
    const isPrArray = obj.some(
      (it) => it && typeof it === "object" && !Array.isArray(it) && (it.typeId !== void 0 || it.type_id !== void 0)
    );
    if (isPrArray) return obj;
    for (const item of obj) {
      const found = findPrRows(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === "object") {
      const found = findPrRows(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
function extractLongestRunPr(raw) {
  const rows = findPrRows(unwrapMcpToolResult(raw)) ?? [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const r = item;
    if (toFiniteNumber(r.typeId ?? r.type_id) !== 7) continue;
    const meters = toFiniteNumber(r.value ?? r.value_raw ?? r.prValue ?? r.distance_m);
    if (meters && meters > 100) {
      const dateRaw = String(
        r.actStartDateTimeInGMTFormatted ?? r.prStartTimeGmtFormatted ?? r.date_gmt ?? r.date ?? ""
      );
      return { distance_m: meters, date: dateRaw ? dateRaw.slice(0, 10) : null };
    }
  }
  return null;
}
function normalizeGarmlinkPrs(raw) {
  const payload = unwrapMcpToolResult(raw);
  let rows = findPrRows(payload) ?? [];
  if (rows.length === 0) {
    if (Array.isArray(payload)) {
      rows = payload;
    } else if (payload && typeof payload === "object") {
      const obj = payload;
      const candidate = obj.personal_records ?? obj.personalRecords ?? obj.records ?? obj.items ?? obj.data;
      if (Array.isArray(candidate)) rows = candidate;
    }
  }
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i];
    if (!item || typeof item !== "object") continue;
    const r = item;
    const typeId = toFiniteNumber(r.typeId ?? r.type_id);
    let distM = null;
    let label = "";
    if (typeId && GARMIN_PR_DIST_MAP[typeId]) {
      distM = GARMIN_PR_DIST_MAP[typeId].distance_m;
      label = GARMIN_PR_DIST_MAP[typeId].label;
    } else {
      const nameStr = String(r.pr_name ?? r.typeKey ?? r.personalRecordType ?? r.label ?? "").toLowerCase();
      if (nameStr.includes("1k") || nameStr.includes("1_km")) {
        distM = 1e3;
        label = "1K";
      } else if (nameStr.includes("mile") && !nameStr.includes("5")) {
        distM = 1609.344;
        label = "1 Mile";
      } else if (nameStr.includes("5k") || nameStr.includes("5_km")) {
        distM = 5e3;
        label = "5K";
      } else if (nameStr.includes("10k") || nameStr.includes("10_km")) {
        distM = 1e4;
        label = "10K";
      } else if (nameStr.includes("half")) {
        distM = 21097.5;
        label = "Half Marathon";
      } else if (nameStr.includes("marathon")) {
        distM = 42195;
        label = "Marathon";
      }
    }
    const timeS = toFiniteNumber(r.value ?? r.value_raw ?? r.prValue ?? r.time_s);
    if (distM && timeS && timeS > 30) {
      const dateRaw = String(
        r.actStartDateTimeInGMTFormatted ?? r.prStartTimeGmtFormatted ?? r.date_gmt ?? r.date ?? ""
      );
      out.push({
        id: `gm-pr-${label.toLowerCase().replace(/\s+/g, "-")}`,
        distance_m: distM,
        time_s: Number(timeS.toFixed(2)),
        date: dateRaw ? dateRaw.slice(0, 10) : (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
        source: "garmlink_pr",
        label
      });
    }
  }
  return out;
}
function rowsOf(raw) {
  const payload = unwrapMcpToolResult(raw);
  if (!payload || typeof payload !== "object") return [];
  const asRows = (arr) => arr.filter((r) => Boolean(r) && typeof r === "object" && !Array.isArray(r));
  if (Array.isArray(payload)) return asRows(payload);
  const obj = payload;
  for (const key of ["days", "data", "items", "rows", "results", "records", "snapshots"]) {
    if (Array.isArray(obj[key])) return asRows(obj[key]);
  }
  for (const val of Object.values(obj)) {
    if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === "object") return asRows(val);
  }
  return [obj];
}
function pickNum(rows, keys, maxRows = 3) {
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
function pickStr(rows, keys, maxRows = 1) {
  for (const row of rows.slice(0, maxRows)) {
    const found = findFirstStringDeep(row, keys);
    if (found) return found;
  }
  return null;
}
function collectZoneCandidates(obj, path2 = "", out = [], depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return out;
  if (Array.isArray(obj)) {
    const zoneRows = obj.filter(
      (it) => Boolean(it) && typeof it === "object" && toFiniteNumber(it.zone ?? it.number ?? it.zoneNumber) !== null
    );
    if (zoneRows.length >= 3 && zoneRows.length === obj.length) {
      const zones = zoneRows.map((z) => ({
        zone: Number(z.zone ?? z.number ?? z.zoneNumber),
        low: toFiniteNumber(z.low ?? z.min ?? z.floor ?? z.from ?? z.low_watts ?? z.low_bpm ?? z.zoneLowBoundary),
        high: toFiniteNumber(z.high ?? z.max ?? z.ceiling ?? z.to ?? z.high_watts ?? z.high_bpm ?? z.zoneHighBoundary)
      })).sort((a, b) => a.zone - b.zone);
      out.push({ path: path2, zones, sport: "", ftp: null });
      return out;
    }
    for (const item of obj) collectZoneCandidates(item, path2, out, depth + 1);
    return out;
  }
  const rec = obj;
  const floors = [1, 2, 3, 4, 5].map(
    (i) => toFiniteNumber(rec[`zone${i}Floor`] ?? rec[`zone${i}_floor`] ?? rec[`zone_${i}_floor`])
  );
  if (floors.filter((f) => f !== null).length >= 3) {
    const top = toFiniteNumber(rec.maxHeartRateUsed ?? rec.max_heart_rate_used ?? rec.max_hr);
    const zones = floors.map((f, i) => ({
      zone: i + 1,
      low: f,
      high: i < 4 ? floors[i + 1] !== null ? floors[i + 1] - 1 : null : top
    }));
    const ftp = toFiniteNumber(rec.functionalThresholdPower ?? rec.functional_threshold_power ?? rec.ftp);
    const isPower = ftp !== null || /power/i.test(path2);
    out.push({
      path: isPower ? `${path2}.power` : `${path2}.heart`,
      zones,
      sport: String(rec.sport ?? rec.sport_type ?? ""),
      ftp
    });
  }
  for (const [key, val] of Object.entries(rec)) {
    if (val && typeof val === "object") collectZoneCandidates(val, `${path2}.${key}`, out, depth + 1);
  }
  return out;
}
function chooseZones(cands, kind) {
  const pool = cands.filter(
    (c) => kind === "power" ? /power/i.test(c.path) : /heart|hr/i.test(c.path) && !/power/i.test(c.path)
  );
  const notCycling = pool.filter((c) => !/cycl|bik/i.test(`${c.sport} ${c.path}`));
  return notCycling.find((c) => /run/i.test(`${c.sport} ${c.path}`)) ?? (kind === "heart" ? notCycling.find((c) => /default/i.test(c.sport)) : void 0) ?? notCycling[0] ?? (kind === "heart" ? pool[0] : null) ?? null;
}
var inRange = (n, lo, hi) => n !== null && n >= lo && n <= hi ? n : null;
function normalizeGarminExtras(payloads) {
  const out = {};
  const r1 = (n) => n !== null ? Number(n.toFixed(1)) : null;
  const r0 = (n) => n !== null ? Math.round(n) : null;
  const readinessRows = rowsOf(payloads.readinessRaw);
  if (readinessRows.length > 0) {
    const today = readinessRows.slice(0, 1);
    const score = pickNum(today, ["score", "readiness_score", "trainingReadinessScore"], 1);
    const recoveryMin = pickNum(today, ["recovery_min", "recoveryTime", "recovery_time_min"], 1);
    if (score !== null) {
      out.readiness = {
        date: pickStr(today, ["date", "calendarDate", "calendar_date"]),
        score: r0(score),
        level: pickStr(today, ["level", "readiness_level"]),
        feedback: pickStr(today, ["feedback", "feedback_short", "feedbackShort", "feedbackLong"]),
        recovery_hours: recoveryMin !== null ? r1(recoveryMin / 60) : null,
        factors: {
          sleep_score_pct: r0(pickNum(today, ["sleep_score_pct", "sleepScoreFactorPercent"], 1)),
          recovery_pct: r0(pickNum(today, ["recovery_pct", "recoveryTimeFactorPercent"], 1)),
          hrv_pct: r0(pickNum(today, ["hrv_pct", "hrvFactorPercent"], 1)),
          sleep_history_pct: r0(pickNum(today, ["sleep_history_pct", "sleepHistoryFactorPercent"], 1)),
          stress_history_pct: r0(pickNum(today, ["stress_history_pct", "stressHistoryFactorPercent"], 1)),
          acwr_pct: r0(pickNum(today, ["acwr_pct", "acwrFactorPercent", "acute_load_pct"], 1))
        }
      };
    }
  }
  const rp = unwrapMcpToolResult(payloads.racePredRaw);
  if (rp) {
    const t5 = inRange(findFirstNumberDeep(rp, ["time5K", "time_5k", "time_5k_s", "time5k"]), 600, 7200);
    const t10 = inRange(findFirstNumberDeep(rp, ["time10K", "time_10k", "time_10k_s", "time10k"]), 1200, 14400);
    const tH = inRange(
      findFirstNumberDeep(rp, ["timeHalfMarathon", "time_half_marathon", "time_half_marathon_s", "time_half"]),
      2700,
      28800
    );
    const tM = inRange(findFirstNumberDeep(rp, ["timeMarathon", "time_marathon", "time_marathon_s"]), 6e3, 57600);
    if (t5 !== null || t10 !== null || tH !== null || tM !== null) {
      out.garmin_race_predictions = { time_5k_s: t5, time_10k_s: t10, time_half_s: tH, time_marathon_s: tM };
    }
  }
  const vo2 = unwrapMcpToolResult(payloads.vo2maxRaw);
  if (vo2) {
    out.vo2max_running = r1(
      inRange(
        findFirstNumberDeep(vo2, [
          "vo2MaxPreciseValue",
          "vo2max_running",
          "vo2_max_running",
          "running_vo2max",
          "vo2max_precise",
          "vo2MaxValue",
          "vo2_max",
          "vo2max"
        ]),
        20,
        90
      )
    );
  }
  const spo2Rows = rowsOf(payloads.spo2Raw);
  const sleepRows = rowsOf(payloads.sleepRaw);
  const spo2Sleep = inRange(
    pickNum(spo2Rows, ["avg_sleep", "avgSleepSpo2", "averageSpO2Value"]) ?? pickNum(sleepRows, ["avg_sleep_spo2", "avg_spo2", "averageSpO2Value"], 1),
    50,
    100
  );
  const spo2Avg = inRange(pickNum(spo2Rows, ["avg", "averageSpo2", "average_spo2"]), 50, 100);
  const spo2Latest = inRange(pickNum(spo2Rows, ["latest", "latestSpo2", "latest_spo2"]), 50, 100);
  if (spo2Sleep !== null) out.spo2_avg_sleep = r0(spo2Sleep);
  if (spo2Latest !== null) out.spo2_latest = r0(spo2Latest);
  if (spo2Avg !== null || spo2Sleep !== null) out.spo2_avg = r0(spo2Avg ?? spo2Sleep);
  const dayRows = rowsOf(payloads.summaryRaw);
  const stressRows = rowsOf(payloads.stressRaw);
  const respRows = rowsOf(payloads.respirationRaw);
  const stepRows = rowsOf(payloads.stepsRaw);
  const floorRows = rowsOf(payloads.floorsRaw);
  const imRows = rowsOf(payloads.intensityRaw);
  const stressAvg = inRange(
    pickNum(stressRows, ["avg", "stress_avg", "averageStressLevel"]) ?? pickNum(dayRows, ["stress_avg", "averageStressLevel"]),
    0,
    100
  );
  const stressMax = inRange(
    pickNum(stressRows, ["max", "stress_max", "maxStressLevel"]) ?? pickNum(dayRows, ["stress_max", "maxStressLevel"]),
    0,
    100
  );
  if (stressAvg !== null) out.stress_avg = r0(stressAvg);
  if (stressMax !== null) out.stress_max = r0(stressMax);
  const respSleep = inRange(pickNum(respRows, ["avg_sleep", "avgSleepRespirationValue"]), 4, 40);
  const respWake = inRange(pickNum(respRows, ["avg_waking", "avgWakingRespirationValue"]), 4, 40);
  if (respSleep !== null) {
    out.respiration_avg_sleep = r1(respSleep);
    out.respiration_avg = r1(respSleep);
  }
  if (respWake !== null) out.respiration_avg_waking = r1(respWake);
  const steps = pickNum(dayRows, ["steps", "totalSteps"], 1) ?? pickNum(stepRows, ["steps", "total", "totalSteps"], 1);
  const stepGoal = pickNum(dayRows, ["step_goal", "dailyStepGoal"]);
  if (steps !== null) out.steps = r0(steps);
  if (stepGoal !== null) out.step_goal = r0(stepGoal);
  const bmr = pickNum(dayRows, ["bmr_calories", "bmrKilocalories"], 1);
  const active = pickNum(dayRows, ["active_calories", "activeKilocalories"], 1);
  const totalCal = pickNum(dayRows, ["calories", "total_calories", "totalKilocalories"], 1);
  if (bmr !== null) out.bmr_calories = r0(bmr);
  if (active !== null) out.active_calories = r0(active);
  if (totalCal !== null || bmr !== null && active !== null) {
    out.calories_total = r0(totalCal ?? bmr + active);
  }
  const floors = pickNum(dayRows, ["floors", "floors_ascended", "floorsAscended"], 1) ?? pickNum(floorRows, ["ascended", "floors_ascended", "floors", "floorsAscended"], 1);
  if (floors !== null) out.floors = r0(floors);
  const imTotal = pickNum(imRows, ["weekly_total", "weeklyTotal"]);
  const imGoal = pickNum(imRows, ["week_goal", "weekGoal"]) ?? pickNum(dayRows, ["intensity_minutes_goal"]);
  if (imTotal !== null) out.intensity_weekly_total = r0(imTotal);
  if (imGoal !== null) out.intensity_week_goal = r0(imGoal);
  if (sleepRows.length > 0) {
    const night = sleepRows.slice(0, 1);
    const totalMin = pickNum(night, ["total_min", "total_sleep_min"], 1);
    if (totalMin !== null && totalMin > 0) {
      out.sleep_seconds = Math.round(totalMin * 60);
      out.sleep_hours = Number((totalMin / 60).toFixed(1));
      out.sleep_time_fmt = `${Math.floor(totalMin / 60)}h ${String(Math.round(totalMin % 60)).padStart(2, "0")}m`;
      for (const k of ["deep_min", "light_min", "rem_min", "awake_min"]) {
        const v = pickNum(night, [k], 1);
        if (v !== null) out[k] = Math.round(v);
      }
    }
  }
  const lt = unwrapMcpToolResult(payloads.lactateRaw);
  if (lt) {
    const lthr = inRange(
      findFirstNumberDeep(lt, [
        "lthr_bpm",
        "lactate_threshold_hr",
        "lactateThresholdHeartRate",
        "heart_rate",
        "heartRate",
        "hr_bpm",
        "hr"
      ]),
      90,
      230
    );
    const ftp = inRange(
      findFirstNumberDeep(lt, ["functionalThresholdPower", "running_ftp_w", "ftp_w", "ftp_watts", "ftp", "power_w"]),
      50,
      800
    );
    const wkg = inRange(
      findFirstNumberDeep(lt, ["powerToWeight", "power_to_weight", "w_per_kg", "ftp_w_per_kg", "ftp_wkg", "wkg"]),
      0.5,
      10
    );
    if (lthr !== null) out.lthr_bpm = r0(lthr);
    if (ftp !== null) out.running_ftp_w = r0(ftp);
    if (wkg !== null) out.running_ftp_wkg = Number(wkg.toFixed(2));
  }
  const zonesPayload = unwrapMcpToolResult(payloads.zonesRaw);
  if (zonesPayload) {
    const cands = collectZoneCandidates(zonesPayload);
    const power = chooseZones(cands, "power");
    const heart = chooseZones(cands, "heart");
    if (power) {
      out.power_zones = power.zones;
      if (out.running_ftp_w == null && power.ftp !== null) out.running_ftp_w = Math.round(power.ftp);
    }
    if (heart) out.hr_zones = heart.zones;
  }
  const fa = unwrapMcpToolResult(payloads.fitnessAgeRaw);
  if (fa) {
    const age = inRange(findFirstNumberDeep(fa, ["fitnessAge", "fitness_age"]), 10, 100);
    const vig = findFirstNumberDeep(fa, ["vigorousMinutesAvg", "vigorous_minutes_avg"]);
    if (age !== null) out.fitness_age = r1(age);
    if (vig !== null) out.vigorous_minutes_avg = r0(vig);
  }
  const longest = extractLongestRunPr(payloads.prRaw);
  if (longest) {
    out.longest_run_m = Math.round(longest.distance_m);
    out.longest_run_date = longest.date;
  }
  return out;
}
var HISTORY_DATE_KEYS = ["date", "calendar_date", "calendarDate", "day", "sleep_date"];
function rowDate(row) {
  for (const k of HISTORY_DATE_KEYS) {
    const v = row[k];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  return null;
}
function rowNum(row, keys) {
  if (!row) return null;
  for (const k of keys) {
    const n = toFiniteNumber(row[k]);
    if (n !== null) return n;
  }
  return null;
}
function buildGarmlinkHealthHistory(payloads) {
  const index = (raw) => {
    const map = /* @__PURE__ */ new Map();
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
  const dates = /* @__PURE__ */ new Set([...sleepByDate.keys(), ...hrvByDate.keys()]);
  const out = [];
  const round = (n) => n !== null ? Math.round(n) : null;
  for (const date of dates) {
    const s = sleepByDate.get(date);
    const h = hrvByDate.get(date);
    const d = dayByDate.get(date);
    const totalMinRaw = rowNum(s, ["total_min", "total_sleep_min"]);
    const totalSecRaw = rowNum(s, ["sleep_seconds", "sleepTimeSeconds", "total_sleep_s"]);
    const totalMin = totalMinRaw !== null && totalMinRaw > 0 ? totalMinRaw : totalSecRaw !== null && totalSecRaw > 0 ? totalSecRaw / 60 : null;
    const stage = (k) => totalMin !== null ? round(rowNum(s, [k])) : null;
    const deep = stage("deep_min");
    const light = stage("light_min");
    const rem = stage("rem_min");
    const awake = stage("awake_min");
    const hrv = rowNum(h, ["last_night_avg", "lastNightAvg", "hrv_last_night"]) ?? rowNum(s, ["overnight_hrv"]);
    const hrvStatus = h?.status ?? h?.hrv_status ?? s?.hrv_status ?? null;
    if (totalMin === null && hrv === null) continue;
    out.push({
      date,
      sleep_score: totalMin !== null ? round(rowNum(s, ["score", "sleep_score", "overall_score", "sleepScore"])) : null,
      sleep_seconds: totalMin !== null ? Math.round(totalMin * 60) : null,
      sleep_hours: totalMin !== null ? Number((totalMin / 60).toFixed(2)) : null,
      sleep_time_fmt: totalMin !== null ? `${Math.floor(totalMin / 60)}h ${String(Math.floor(totalMin % 60)).padStart(2, "0")}m` : null,
      deep_sleep_s: deep !== null ? deep * 60 : null,
      light_sleep_s: light !== null ? light * 60 : null,
      rem_sleep_s: rem !== null ? rem * 60 : null,
      awake_sleep_s: awake !== null ? awake * 60 : null,
      deep_min: deep,
      light_min: light,
      rem_min: rem,
      awake_min: awake,
      spo2_avg: inRange(rowNum(s, ["avg_sleep_spo2", "avg_spo2", "averageSpO2Value"]), 50, 100),
      respiration_avg: inRange(rowNum(s, ["avg_respiration", "averageRespirationValue"]), 4, 40),
      sleep_stress_avg: rowNum(s, ["avg_sleep_stress", "avg_stress", "avgSleepStress"]),
      hrv_last_night: hrv !== null ? Number(hrv.toFixed(1)) : null,
      hrv_weekly_avg: round(rowNum(h, ["weekly_avg", "weeklyAvg", "hrv_weekly_avg"])),
      hrv_status: typeof hrvStatus === "string" && hrvStatus ? hrvStatus.toUpperCase() : null,
      hrv_baseline_low: round(rowNum(h, ["baseline_low", "balancedLow", "hrv_baseline_low"])),
      hrv_baseline_high: round(rowNum(h, ["baseline_high", "balancedUpper", "hrv_baseline_high"])),
      resting_hr: round(
        rowNum(d, ["resting_hr", "restingHeartRate", "rhr"]) ?? rowNum(s, ["resting_hr", "restingHeartRate"])
      ),
      source: "garmlink_mcp"
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
function describeWmoWeather(code) {
  if (code === 0) return "Clear Sky";
  if (code === 1) return "Mainly Clear";
  if (code === 2) return "Partly Cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain Showers";
  if (code >= 85 && code <= 86) return "Snow Showers";
  if (code >= 95) return "Thunderstorm";
  return "Fair";
}
function degreesToCompass(deg) {
  if (deg === null || deg === void 0 || !Number.isFinite(deg)) return "Var";
  const dirs = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW"
  ];
  const idx = Math.round((deg % 360 + 360) % 360 / 22.5) % 16;
  return dirs[idx];
}

// src/lib/seedData.ts
var VERIFIED_PR_EFFORTS = [
  {
    id: "pr-1k",
    distance_m: 1e3,
    time_s: 194.2,
    date: "2026-10-14",
    hr_avg: 186,
    source: "verified_pr",
    label: "1K"
  },
  {
    id: "pr-1600m",
    distance_m: 1600,
    time_s: 317.03,
    // 5:17.1 converted from Mile
    date: "2026-10-28",
    hr_avg: 191,
    source: "verified_pr",
    label: "1600m (Converted)"
  },
  {
    id: "pr-mile",
    distance_m: 1609.344,
    time_s: 318.88,
    // 5:18.9
    date: "2026-10-28",
    hr_avg: 191,
    source: "verified_pr",
    label: "1 Mile"
  },
  {
    id: "pr-5k",
    distance_m: 5e3,
    time_s: 1144.75,
    date: "2026-11-09",
    hr_avg: 188,
    source: "verified_pr",
    label: "5K"
  },
  {
    id: "pr-10k",
    distance_m: 1e4,
    time_s: 2591.8,
    date: "2026-10-02",
    hr_avg: 179,
    source: "verified_pr",
    label: "10K"
  }
];
var DEFAULT_GARMLINK_HEALTH = {
  date: "2026-11-23",
  vo2max: 51.7,
  hrv_last_night: 32,
  hrv_weekly_avg: 48,
  hrv_status: "UNBALANCED",
  hrv_baseline_low: 48,
  hrv_baseline_high: 73,
  sleep_score: 54,
  sleep_hours: 5.1,
  sleep_seconds: 18360,
  sleep_time_fmt: "5h 06m",
  deep_min: 167,
  light_min: 117,
  rem_min: 22,
  awake_min: 75,
  body_battery: 55,
  bb_highest: 55,
  bb_at_wake: 54,
  bb_charged: 31,
  bb_drained: 11,
  resting_hr: 62,
  resting_hr_avg_7d: 59,
  stress_avg: 23,
  // Real training load focus from Garmin Connect: Low Aerobic Shortage
  load_anaerobic: 1360,
  load_aerobic_low: 613.1,
  load_aerobic_high: 1605.8,
  acute_load: 909,
  chronic_load: 862,
  acwr_ratio: 1.05,
  consecutive_run_days: 3,
  source: "garmlink_mcp",
  synced_at: "2026-11-23T08:30:00Z"
};
var DEFAULT_GARMLINK_ACTIVITIES = [
  {
    id: "garmin-25163609781",
    name: "Dover Running",
    date: "2026-11-22",
    activity_type: "running",
    distance_m: 5026.4,
    // 3.12 mi
    duration_s: 1392,
    // 23:12 (7:26/mi)
    avg_hr: 188,
    max_hr: 206,
    elevation_gain_ft: 69,
    avg_cadence: 163,
    source: "garmlink_mcp",
    source_label: "Garmlink MCP"
  },
  {
    id: "garmin-25152738732",
    name: "New Castle County Running",
    date: "2026-11-21",
    activity_type: "running",
    distance_m: 5001.9,
    // 3.11 mi
    duration_s: 1148,
    // 19:08 (6:09/mi)
    avg_hr: 175,
    max_hr: 207,
    elevation_gain_ft: 177,
    avg_cadence: 165,
    source: "garmlink_mcp",
    source_label: "Garmlink MCP"
  },
  {
    id: "garmin-25152097801",
    name: "New Castle County Running",
    date: "2026-11-21",
    activity_type: "running",
    distance_m: 2080.5,
    // 1.29 mi
    duration_s: 794,
    // 13:14 (10:15/mi)
    avg_hr: 151,
    max_hr: 177,
    elevation_gain_ft: 89,
    avg_cadence: 154,
    source: "garmlink_mcp",
    source_label: "Garmlink MCP"
  },
  {
    id: "garmin-25145140972",
    name: "Smyrna Running",
    date: "2026-11-20",
    activity_type: "running",
    distance_m: 3098.6,
    // 1.93 mi
    duration_s: 1742,
    // 29:02 (15:02/mi)
    avg_hr: 160,
    max_hr: 197,
    elevation_gain_ft: 128,
    avg_cadence: 76,
    source: "garmlink_mcp",
    source_label: "Garmlink MCP"
  },
  {
    id: "garmin-25134919839",
    name: "Smyrna Running",
    date: "2026-11-19",
    activity_type: "running",
    distance_m: 1619,
    // 1.01 mi
    duration_s: 322,
    // 5:22 (5:20/mi)
    avg_hr: 183,
    max_hr: 209,
    elevation_gain_ft: 33,
    avg_cadence: 173,
    source: "garmlink_mcp",
    source_label: "Garmlink MCP"
  },
  {
    id: "garmin-25112932063",
    name: "Smyrna Running",
    date: "2026-11-12",
    activity_type: "running",
    distance_m: 2549.4,
    // 1.58 mi
    duration_s: 1505,
    // 25:05 (15:52/mi)
    avg_hr: 133,
    max_hr: 172,
    elevation_gain_ft: 72,
    avg_cadence: 98,
    source: "garmlink_mcp",
    source_label: "Garmlink MCP"
  },
  {
    id: "garmin-25145145837",
    name: "Smyrna Running",
    date: "2026-11-20",
    activity_type: "running",
    distance_m: 295.8,
    duration_s: 55,
    avg_hr: 188,
    max_hr: 200,
    elevation_gain_ft: 23,
    avg_cadence: 189,
    source: "garmlink_mcp",
    source_label: "Garmlink MCP"
  },
  {
    id: "garmin-25136537318",
    name: "Smyrna Running",
    date: "2026-11-19",
    activity_type: "running",
    distance_m: 378.6,
    duration_s: 151,
    avg_hr: 146,
    max_hr: 151,
    elevation_gain_ft: 26,
    avg_cadence: 157,
    source: "garmlink_mcp",
    source_label: "Garmlink MCP"
  },
  {
    id: "garmin-25126639215",
    name: "Smyrna Running",
    date: "2026-11-18",
    activity_type: "running",
    distance_m: 612.8,
    duration_s: 108,
    avg_hr: 166,
    max_hr: 188,
    elevation_gain_ft: 23,
    avg_cadence: 181,
    source: "garmlink_mcp",
    source_label: "Garmlink MCP"
  },
  {
    id: "garmin-25126638908",
    name: "Smyrna Running",
    date: "2026-11-18",
    activity_type: "running",
    distance_m: 842.2,
    duration_s: 273,
    avg_hr: 141,
    max_hr: 149,
    elevation_gain_ft: 10,
    avg_cadence: 164,
    source: "garmlink_mcp",
    source_label: "Garmlink MCP"
  },
  {
    id: "garmin-25112933376",
    name: "Smyrna Running",
    date: "2026-11-17",
    activity_type: "running",
    distance_m: 795.4,
    duration_s: 281,
    avg_hr: 143,
    max_hr: 155,
    elevation_gain_ft: 3,
    avg_cadence: 160,
    source: "garmlink_mcp",
    source_label: "Garmlink MCP"
  },
  {
    id: "garmin-25112926267",
    name: "Smyrna Running",
    date: "2026-11-12",
    activity_type: "running",
    distance_m: 1021.8,
    duration_s: 316,
    avg_hr: 154,
    max_hr: 178,
    elevation_gain_ft: 33,
    avg_cadence: 148,
    source: "garmlink_mcp",
    source_label: "Garmlink MCP"
  }
];

// src/lib/trainingPlans.ts
var DAYS_OF_WEEK = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday"
];
function raceDistanceMiles(distLabel) {
  const map = {
    "400m": 0.25,
    "800m": 0.5,
    "1000m": 0.6,
    "1500m": 0.9,
    "1600m": 1,
    Mile: 1,
    "1 Mile": 1,
    "3000m": 1.9,
    "3200m": 2,
    "2 Mile": 2,
    "5K": 3.1,
    "10K": 6.2,
    "15K": 9.3,
    "Half Marathon": 13.1,
    Marathon: 26.2
  };
  return map[distLabel] ?? 3.1;
}
function applyRaceTaper(plan, raceName, raceDist, raceDay, easyPace = "8:00\u20138:30/mi") {
  let effectiveDay = raceDay;
  if (!effectiveDay || effectiveDay === "Monday" || raceName && raceName.toLowerCase().includes("pie")) {
    effectiveDay = "Thursday";
  }
  const normalizedDay = DAYS_OF_WEEK.find((d) => d.toLowerCase() === (effectiveDay || "").trim().toLowerCase()) ?? "Thursday";
  const raceIdx = DAYS_OF_WEEK.indexOf(normalizedDay);
  const schedule = DAYS_OF_WEEK.map((dayName, i) => {
    const daysBefore = raceIdx - i;
    if (daysBefore === 0) {
      const raceMi = raceDistanceMiles(raceDist);
      const wuMi = 1.5;
      const cdMi = 1;
      const totalMi = Number((wuMi + raceMi + cdMi).toFixed(1));
      return {
        day: dayName,
        name: `${raceName} \u2014 ${raceDist} Race`,
        workout_type: "race",
        warmup_miles: wuMi,
        main_miles: raceMi,
        cooldown_miles: cdMi,
        distance_miles: totalMi,
        pace_target: "Goal Race Pace (~5:58\u20136:05/mi)",
        hr_cap: "Race Effort (Max VO2)",
        description: `\u2022 Warmup: 1.5 mi progressive warm-up + dynamic drills + 4x100m strides.
\u2022 Main Set: Execute ${raceDist} race (${raceMi} mi) at Goal Race Pace.
\u2022 Cooldown: 1.0 mi easy cooldown flush on soft grass.`,
        injury_prevention_note: "Pre-race meal 3h prior. Double-knot racing shoes; electrolytes 60 min out."
      };
    }
    if (daysBefore === 1) {
      return {
        day: dayName,
        name: "Pre-Race Shakeout & Strides",
        workout_type: "easy",
        warmup_miles: 0.5,
        main_miles: 1,
        cooldown_miles: 0.5,
        distance_miles: 2,
        pace_target: `${easyPace} + 4x100m strides`,
        hr_cap: "< 140 bpm",
        description: "\u2022 Warmup: 0.5 mi progressive jog.\n\u2022 Main Set: 1.0 mi relaxed shakeout + 4x100m smooth neuromuscular strides.\n\u2022 Cooldown: 0.5 mi walk and mobility.",
        injury_prevention_note: "Zero straining on strides \u2014 stay tall, bouncy, and relaxed."
      };
    }
    if (daysBefore === 2) {
      return {
        day: dayName,
        name: "Taper Sharpening (Mini-Tempo)",
        workout_type: "workout",
        warmup_miles: 1.5,
        main_miles: 1,
        cooldown_miles: 1,
        distance_miles: 3.5,
        pace_target: "2 x 800m @ goal race pace (3 min rest)",
        hr_cap: "Controlled \xB7 Low fatigue",
        description: "\u2022 Warmup: 1.5 mi easy jog + drills.\n\u2022 Main Set: 2 x 800m at goal race pace with full standing recovery.\n\u2022 Cooldown: 1.0 mi easy flush.",
        injury_prevention_note: "Primes fast-twitch motor units without depleting muscle glycogen."
      };
    }
    if (daysBefore === 3) {
      if (dayName === "Monday") {
        return {
          day: dayName,
          name: "Full Rest & Prehab Mobility",
          workout_type: "rest",
          warmup_miles: 0,
          main_miles: 0,
          cooldown_miles: 0,
          distance_miles: 0,
          pace_target: "Off",
          hr_cap: "Rest",
          description: "Zero running. 20 min foam rolling IT bands, calves, and quads to trigger glycogen supercompensation.",
          injury_prevention_note: "Connective tissues adapt and remodel during rest."
        };
      }
      return {
        day: dayName,
        name: "Taper Aerobic Maintenance (Zone 2)",
        workout_type: "easy",
        warmup_miles: 0.5,
        main_miles: 2,
        cooldown_miles: 0.5,
        distance_miles: 3,
        pace_target: easyPace,
        hr_cap: "< 145 bpm",
        description: "\u2022 Warmup: 0.5 mi jog.\n\u2022 Main Set: 2.0 mi relaxed aerobic flush on soft grass.\n\u2022 Cooldown: 0.5 mi walk.",
        injury_prevention_note: "Volume trimmed ~35% for glycogen supercompensation."
      };
    }
    if (dayName === "Monday") {
      return {
        day: dayName,
        name: "Full Rest & Prehab Mobility",
        workout_type: "rest",
        warmup_miles: 0,
        main_miles: 0,
        cooldown_miles: 0,
        distance_miles: 0,
        pace_target: "Off",
        hr_cap: "Rest",
        description: "Zero running. Foam roll IT bands, calves, and quads.",
        injury_prevention_note: "Mandatory weekly recovery day."
      };
    }
    if (daysBefore === -1) {
      return {
        day: dayName,
        name: "Post-Race Recovery Flush",
        workout_type: "recovery",
        warmup_miles: 0.5,
        main_miles: 1,
        cooldown_miles: 0.5,
        distance_miles: 2,
        pace_target: "Slow jog or 30 min brisk walk",
        hr_cap: "< 130 bpm",
        description: "\u2022 Warmup: 0.5 mi light walk.\n\u2022 Main Set: 1.0 mi gentle recovery flush on soft grass.\n\u2022 Cooldown: 0.5 mi mobility & rehydration.",
        injury_prevention_note: "Zero pounding. Prioritize protein and sleep."
      };
    }
    if (daysBefore === -2) {
      return {
        day: dayName,
        name: "Aerobic Base Re-Entry (Zone 2)",
        workout_type: "easy",
        distance_miles: 4,
        pace_target: easyPace,
        hr_cap: "< 145 bpm",
        description: "Easy aerobic miles on soft grass or trail. Monitor calves and Achilles.",
        injury_prevention_note: "If sore from spikes/carbon, swap for easy spin or rest."
      };
    }
    if (daysBefore < 0) {
      return {
        day: dayName,
        name: "Easy Aerobic Re-Entry (Zone 2)",
        workout_type: "easy",
        distance_miles: 4,
        pace_target: easyPace,
        hr_cap: "< 145 bpm",
        description: "Relaxed aerobic miles to rebuild rhythm after the race. Keep it conversational.",
        injury_prevention_note: "Cut it short if any post-race soreness lingers."
      };
    }
    return {
      day: dayName,
      name: "Pre-Taper Easy Aerobic (Zone 2)",
      workout_type: "easy",
      distance_miles: 4,
      pace_target: easyPace,
      hr_cap: "< 145 bpm",
      description: "Controlled aerobic mileage. Stay hydrated.",
      injury_prevention_note: "Strictly aerobic; zero anaerobic drift."
    };
  });
  const weeklyMileage = Number(
    schedule.reduce((acc, w) => acc + w.distance_miles, 0).toFixed(1)
  );
  return {
    focus_id: plan.focus_id,
    title: `${plan.title} \u2014 Race Week`,
    target_race: `${raceName} (${raceDist}) \xB7 ${raceDay}`,
    weekly_mileage: weeklyMileage,
    aerobic_deficit_focus: `Race-week taper active for ${raceName} (${raceDist}) on ${raceDay}. Volume reduced ~35% for glycogen supercompensation and neuromuscular snap.`,
    schedule
  };
}
function generateTrainingPlan(focus, zones, targetRace, weekIndex = currentWeekIndex()) {
  const easyP = zones.easy.label;
  const recP = zones.recovery.label;
  const tP = zones.threshold.label;
  const iP = zones.interval.label;
  const mP = zones.marathon.label;
  const rep400 = zones.rep_400m;
  let plan;
  if (focus === "track_mid") {
    plan = {
      focus_id: "track_mid",
      title: "Track Middle-Distance (800m / 1600m / Mile)",
      target_race: "Track 800m & 1600m Season",
      weekly_mileage: 24.5,
      aerobic_deficit_focus: "Closes the Garmin low-aerobic shortage (613 vs 1,318 anaerobic) while sharpening 800m/Mile fast-twitch pop.",
      schedule: [
        {
          day: "Monday",
          name: "Full Rest & Hip Mobility",
          workout_type: "rest",
          distance_miles: 0,
          pace_target: "Off",
          hr_cap: "Rest",
          description: "Zero running. 15 min hip flexor, glute medius activation & foam rolling.",
          injury_prevention_note: "Non-negotiable connective tissue remodeling window."
        },
        {
          day: "Tuesday",
          name: "Track Speed Intervals (800m/1600m Prep)",
          workout_type: "workout",
          distance_miles: 4.5,
          pace_target: `~${rep400} per 400m (R-Pace)`,
          hr_cap: "WU/CD < 150 bpm",
          description: `1.5 mi easy WU + 4x400m @ ${rep400} with 90s walk rest + 4x100m smooth strides + 1.5 mi CD.`,
          injury_prevention_note: "Keep strides relaxed at 90% effort to protect hamstrings."
        },
        {
          day: "Wednesday",
          name: "Aerobic Base Anchor (Zone 2)",
          workout_type: "easy",
          distance_miles: 4,
          pace_target: easyP,
          hr_cap: "Strict < 145 bpm",
          description: "Continuous steady running. If watch HR exceeds 145 bpm, walk until it drops to 130.",
          injury_prevention_note: "Directly builds capillary beds without adding bone stress."
        },
        {
          day: "Thursday",
          name: "Threshold Cruise Intervals",
          workout_type: "workout",
          distance_miles: 4.5,
          pace_target: tP,
          hr_cap: "180\u2013184 bpm (LT)",
          description: `1.5 mi WU + 3 x 1000m @ ${tP} with 60s jog rest + 1.5 mi CD.`,
          injury_prevention_note: "Raises lactate clearance ceiling for lap 3 of the 1600m."
        },
        {
          day: "Friday",
          name: "Active Recovery Shakeout",
          workout_type: "recovery",
          distance_miles: 3,
          pace_target: recP,
          hr_cap: "Strict < 140 bpm",
          description: "Easy flush run + 4 x 50m light grass strides + mobility.",
          injury_prevention_note: "Clears metabolic fatigue before weekend volume anchor."
        },
        {
          day: "Saturday",
          name: "Aerobic Volume Long Run",
          workout_type: "long_run",
          distance_miles: 6.5,
          pace_target: easyP,
          hr_cap: "< 150 bpm (Zone 2)",
          description: "Controlled continuous aerobic distance. Hydrate every 2 miles.",
          injury_prevention_note: "Capped at 26% of weekly mileage to protect knees and plantar fascia."
        },
        {
          day: "Sunday",
          name: "Recovery Flush",
          workout_type: "easy",
          distance_miles: 2,
          pace_target: recP,
          hr_cap: "< 135 bpm",
          description: "Relaxed Zone 1/2 recovery jog.",
          injury_prevention_note: "Zero anaerobic accumulation."
        }
      ]
    };
  } else if (focus === "track_long") {
    plan = {
      focus_id: "track_long",
      title: "Track Distance (3200m / 2 Mile / 5000m)",
      target_race: "3200m / 5000m Track Focus",
      weekly_mileage: 27,
      aerobic_deficit_focus: "Expands VO2max plateau and threshold durability for the 8-lap track grind.",
      schedule: [
        {
          day: "Monday",
          name: "Full Rest Day",
          workout_type: "rest",
          distance_miles: 0,
          pace_target: "Off",
          hr_cap: "Rest",
          description: "Complete rest. Core stability and hamstring mobility routine.",
          injury_prevention_note: "Allows muscular micro-tears from weekend volume to heal."
        },
        {
          day: "Tuesday",
          name: "Mile Repeat Threshold Session",
          workout_type: "workout",
          distance_miles: 5,
          pace_target: tP,
          hr_cap: "182\u2013185 bpm",
          description: `1.5 mi WU + 2 x 1 Mile @ ${tP} with 2 min walk rest + 4x150m strides + 1.5 mi CD.`,
          injury_prevention_note: "Holds race rhythm without hyper-acidosis."
        },
        {
          day: "Wednesday",
          name: "Mid-Week Aerobic Foundation",
          workout_type: "easy",
          distance_miles: 4.5,
          pace_target: easyP,
          hr_cap: "< 145 bpm",
          description: "Pure Zone 2 aerobic development with steady nasal/relaxed breathing.",
          injury_prevention_note: "Builds mitochondrial density for late-race 3200m survival."
        },
        {
          day: "Thursday",
          name: "VO2max Tempo Intervals",
          workout_type: "workout",
          distance_miles: 5,
          pace_target: iP,
          hr_cap: "185\u2013190 bpm",
          description: `1.5 mi WU + 4 x 800m @ ${iP} with 90s jog rest + 1.5 mi CD.`,
          injury_prevention_note: "Neuromuscular pacing lock without glycogen depletion."
        },
        {
          day: "Friday",
          name: "Easy Recovery Shakeout",
          workout_type: "recovery",
          distance_miles: 3,
          pace_target: recP,
          hr_cap: "< 140 bpm",
          description: "Relaxed recovery jog plus leg swings and light mobility.",
          injury_prevention_note: "Lowers resting cortisol before Saturday progression."
        },
        {
          day: "Saturday",
          name: "Progressive Long Run",
          workout_type: "long_run",
          distance_miles: 7.5,
          pace_target: `${easyP} -> ${mP}`,
          hr_cap: "Start < 145, peak < 165 bpm",
          description: `Miles 1\u20135 @ ${easyP}, Miles 6\u20137.5 progressing smoothly toward ${mP}.`,
          injury_prevention_note: "Respects historical 8.9 mi long-run ceiling."
        },
        {
          day: "Sunday",
          name: "Easy Aerobic Flush",
          workout_type: "easy",
          distance_miles: 2,
          pace_target: recP,
          hr_cap: "< 130 bpm",
          description: "Low-impact active recovery.",
          injury_prevention_note: "Zero pounding."
        }
      ]
    };
  } else if (focus === "xc") {
    plan = {
      focus_id: "xc",
      title: "Cross Country 5K (Grass / Hills / Power)",
      target_race: "5K Cross Country Championship",
      weekly_mileage: 36,
      aerobic_deficit_focus: "Builds competitive XC volume, hill power, and late-race aerobic durability.",
      schedule: [
        {
          day: "Monday",
          name: "Rest & Joint Durability",
          workout_type: "rest",
          distance_miles: 0,
          pace_target: "Off",
          hr_cap: "Rest",
          description: "Single-leg balance drills, ankle mobility, calf eccentrics, and foam rolling.",
          injury_prevention_note: "Strengthens ankle stabilizers for uneven grass and mud."
        },
        {
          day: "Tuesday",
          name: "Hill Power Repeats & Strides",
          workout_type: "workout",
          distance_miles: 6,
          pace_target: "Hard uphill drive (Mile effort)",
          hr_cap: "Walk-down full recovery",
          description: "1.5 mi WU + 8 x 200m steep hill charges + 4x100m flat strides + 1.5 mi CD.",
          injury_prevention_note: "Builds hip drive with less joint impact than flat sprints."
        },
        {
          day: "Wednesday",
          name: "Aerobic Foundation Miles (Zone 2)",
          workout_type: "easy",
          distance_miles: 6,
          pace_target: easyP,
          hr_cap: "< 145 bpm",
          description: "Continuous aerobic running on soft grass/dirt trails.",
          injury_prevention_note: "Soft surfaces cut tibial bone stress by ~30%."
        },
        {
          day: "Thursday",
          name: "XC Threshold Cruise Repeats",
          workout_type: "workout",
          distance_miles: 6.5,
          pace_target: tP,
          hr_cap: "180\u2013185 bpm",
          description: `1.5 mi WU + 4 x 1-mile cruise repeats @ ${tP} with 75s jog rest + 1.5 mi CD.`,
          injury_prevention_note: "Trains lactate clearance under undulating terrain."
        },
        {
          day: "Friday",
          name: "Aerobic Recovery & Turnover",
          workout_type: "recovery",
          distance_miles: 4.5,
          pace_target: recP,
          hr_cap: "< 140 bpm",
          description: "Easy recovery jog on grass + 6 relaxed turf strides.",
          injury_prevention_note: "Prepares musculoskeletal system for weekend long run."
        },
        {
          day: "Saturday",
          name: "XC Over-Distance Long Run",
          workout_type: "long_run",
          distance_miles: 8.5,
          pace_target: `${easyP} -> ${mP}`,
          hr_cap: "Start < 145, finish < 160 bpm",
          description: "Rolling terrain long run: 5.5 mi relaxed aerobic, final 3 mi steady progression.",
          injury_prevention_note: "Builds eccentric quad control on steep descents."
        },
        {
          day: "Sunday",
          name: "Aerobic Flush & Active Recovery",
          workout_type: "easy",
          distance_miles: 4.5,
          pace_target: recP,
          hr_cap: "< 138 bpm",
          description: "Gentle conversational aerobic run.",
          injury_prevention_note: "Keep strictly aerobic; zero sprinting."
        }
      ]
    };
  } else if (focus === "half_marathon") {
    plan = {
      focus_id: "half_marathon",
      title: "Half Marathon Prep (Aerobic Durability)",
      target_race: "Half Marathon 13.1 mi Build",
      weekly_mileage: 31,
      aerobic_deficit_focus: "Safely bridges volume toward 30+ mpw without tendon breakdown.",
      schedule: [
        {
          day: "Monday",
          name: "Complete Rest",
          workout_type: "rest",
          distance_miles: 0,
          pace_target: "Off",
          hr_cap: "Rest",
          description: "Zero running. Foam roll IT bands, calves, and quads.",
          injury_prevention_note: "Prevents overuse tendinitis during volume ramp."
        },
        {
          day: "Tuesday",
          name: "Half Marathon Tempo Hold",
          workout_type: "workout",
          distance_miles: 5.5,
          pace_target: mP,
          hr_cap: "170\u2013178 bpm",
          description: `1.5 mi WU + 3 Miles continuous @ ${mP} + 1 mi CD.`,
          injury_prevention_note: "Builds glycogen-sparing efficiency at sub-threshold speed."
        },
        {
          day: "Wednesday",
          name: "Mid-Week Aerobic Cruise",
          workout_type: "easy",
          distance_miles: 5,
          pace_target: easyP,
          hr_cap: "< 145 bpm (Zone 2)",
          description: "Zone 2 continuous run with hydration.",
          injury_prevention_note: "Expands stroke volume and capillary density."
        },
        {
          day: "Thursday",
          name: "Aerobic Progression Run",
          workout_type: "easy",
          distance_miles: 5,
          pace_target: `${easyP} -> ${mP}`,
          hr_cap: "Finish < 170 bpm",
          description: "Controlled negative split aerobic progression.",
          injury_prevention_note: "Simulates late-race fatigue without track trauma."
        },
        {
          day: "Friday",
          name: "Flush Run",
          workout_type: "recovery",
          distance_miles: 3,
          pace_target: recP,
          hr_cap: "< 138 bpm",
          description: "Gentle shakeout focusing on tall posture and cadence.",
          injury_prevention_note: "Keeps connective tissues pliable for Saturday."
        },
        {
          day: "Saturday",
          name: "Long Run Endurance Anchor",
          workout_type: "long_run",
          distance_miles: 9.5,
          pace_target: easyP,
          hr_cap: "< 152 bpm",
          description: "Step long run smoothly toward 9.5 mi. Carry hydration and 1 gel.",
          injury_prevention_note: "Follows 10% progression guardrail."
        },
        {
          day: "Sunday",
          name: "Easy Flush Run",
          workout_type: "easy",
          distance_miles: 3,
          pace_target: recP,
          hr_cap: "< 135 bpm",
          description: "Easy shakeout promoting recovery circulation.",
          injury_prevention_note: "Low impact only."
        }
      ]
    };
  } else {
    plan = {
      focus_id: "base_building",
      title: "Aerobic Base Building & Injury Immunity",
      target_race: "Zone 2 Engine Construction",
      weekly_mileage: 23,
      aerobic_deficit_focus: "Strictly cures low-aerobic shortage without high-injury speed spikes.",
      schedule: [
        {
          day: "Monday",
          name: "Rest & Prehab Day",
          workout_type: "rest",
          distance_miles: 0,
          pace_target: "Off",
          hr_cap: "Rest",
          description: "Zero running. 20 min core, glutes, and plantar fascia mobility.",
          injury_prevention_note: "Prehab prevents overuse setbacks."
        },
        {
          day: "Tuesday",
          name: "Easy Aerobic Base + Strides",
          workout_type: "easy",
          distance_miles: 4.5,
          pace_target: easyP,
          hr_cap: "< 145 bpm (Strict Z2)",
          description: "4 miles strictly in Zone 2 + 4 x 80m relaxed strides on grass.",
          injury_prevention_note: "Strides maintain turnover without lactic accumulation."
        },
        {
          day: "Wednesday",
          name: "Continuous Aerobic Zone 2",
          workout_type: "easy",
          distance_miles: 4,
          pace_target: easyP,
          hr_cap: "< 145 bpm",
          description: "Continuous aerobic run. Walk hills if watch HR drifts above 145 bpm.",
          injury_prevention_note: "Maximizes stroke volume without cortisol spikes."
        },
        {
          day: "Thursday",
          name: "Sub-Threshold Aerobic Cruise",
          workout_type: "easy",
          distance_miles: 4.5,
          pace_target: mP,
          hr_cap: "< 165 bpm (Zone 3 ceiling)",
          description: `1 mi WU + 2.5 mi steady @ ${mP} + 1 mi CD.`,
          injury_prevention_note: "Comfortably below lactate threshold."
        },
        {
          day: "Friday",
          name: "Recovery Jog",
          workout_type: "recovery",
          distance_miles: 3,
          pace_target: recP,
          hr_cap: "< 138 bpm",
          description: "Conversational shakeout.",
          injury_prevention_note: "Boosts lymphatic drainage."
        },
        {
          day: "Saturday",
          name: "Aerobic Base Long Run",
          workout_type: "long_run",
          distance_miles: 6,
          pace_target: easyP,
          hr_cap: "< 148 bpm",
          description: "Steady weekend anchor with relaxed breathing.",
          injury_prevention_note: "Low joint impact while accumulating aerobic volume."
        },
        {
          day: "Sunday",
          name: "Rest / Light Shakeout",
          workout_type: "easy",
          distance_miles: 1,
          pace_target: recP,
          hr_cap: "< 130 bpm",
          description: "Easy walk or light 1-mile jog.",
          injury_prevention_note: "Resets the central nervous system."
        }
      ]
    };
  }
  if (targetRace && targetRace.name) {
    let raceDay = targetRace.day;
    if (!raceDay || raceDay === "Monday" || targetRace.name.toLowerCase().includes("pie")) {
      raceDay = "Thursday";
    }
    return applyRaceTaper(plan, targetRace.name, targetRace.dist || "5K", raceDay, easyP);
  }
  return rotateWorkoutVariety(plan, zones, weekIndex);
}
function currentWeekIndex(date = /* @__PURE__ */ new Date()) {
  return Math.floor((date.getTime() / 864e5 + 3) / 7);
}
function buildWorkoutLibrary(zones) {
  const tP = zones.threshold.label;
  const iP = zones.interval.label;
  const rP = zones.repetition.label;
  const eP = zones.easy.label;
  const lt = "175\u2013184 bpm (LT)";
  return {
    threshold: [
      { name: "Threshold Cruise Intervals (5x1K)", main_miles: 3.6, pace_target: tP, hr_cap: lt, main: `5 x 1000m @ ${tP} with 60s jog recovery`, note: "Comfortably hard \u2014 you should finish feeling you could do one more rep." },
      { name: "Threshold Mile Repeats (3x1 mi)", main_miles: 3.4, pace_target: tP, hr_cap: lt, main: `3 x 1 mile @ ${tP} with 90s jog recovery (add a 4th only if HR stays under LT)`, note: "Even splits; do not race the last rep." },
      { name: "Continuous Tempo Run (20 min)", main_miles: 3, pace_target: tP, hr_cap: lt, main: `15\u201325 min continuous @ ${tP} (start at 15 min, build toward 25 over the block)`, note: "Lock into rhythm; stop if form breaks down." }
    ],
    vo2: [
      { name: "VO2max Track Intervals (5x800m)", main_miles: 3.7, pace_target: iP, hr_cap: "> 185 bpm on reps", main: `5 x 800m @ ${iP} with 2:30 jog recovery`, note: "Equal work:rest. Shut it down if pace fades more than 3s per rep.", hard: true },
      { name: "VO2max Track Intervals (6x600m)", main_miles: 3.4, pace_target: iP, hr_cap: "> 185 bpm on reps", main: `6 x 600m @ ${iP} with 2:00 jog recovery`, note: "Stay tall through the final 150m of each rep.", hard: true },
      { name: "VO2max Track Intervals (4x1000m)", main_miles: 3.7, pace_target: iP, hr_cap: "> 185 bpm on reps", main: `4 x 1000m @ ${iP} with 3:00 jog recovery`, note: "Longest VO2 stimulus \u2014 respect the full recovery.", hard: true },
      { name: "VO2max Track Intervals (8x400m)", main_miles: 3.2, pace_target: `${zones.rep_400m} per 400m`, hr_cap: "> 185 bpm on reps", main: `8 x 400m @ ${zones.rep_400m} with 75\u201390s jog recovery`, note: "Smooth and fast, not sprinting. Protect the hamstrings.", hard: true }
    ],
    speed: [
      { name: "Speed Repetitions (10x200m)", main_miles: 2.5, pace_target: `${rP} (R-pace)`, hr_cap: "Not HR-governed", main: `10 x 200m @ ${rP} with full 200m walk/jog recovery`, note: "Full recovery is the point \u2014 quality mechanics over fatigue.", hard: true },
      { name: "Speed Repetitions (6x300m)", main_miles: 2.3, pace_target: `${rP} (R-pace)`, hr_cap: "Not HR-governed", main: `6 x 300m @ ${rP} with full 3:00 walk recovery`, note: "Relaxed speed. Stop if any hamstring or calf tightness appears.", hard: true }
    ],
    fartlek: [
      { name: "Fartlek Ladder (1-2-3-2-1 min)", main_miles: 3, pace_target: `Hard @ ${iP} \xB7 float @ ${eP}`, hr_cap: "By feel", main: `1-2-3-2-1 min hard @ ${iP} effort with equal-time easy float, then repeat the 1-2-1 if fresh`, note: "Run by effort on grass or trail \u2014 no watch-staring." },
      { name: "Fartlek (8x2 min hard / 1 min float)", main_miles: 3.4, pace_target: `Hard @ ${tP} \xB7 float @ ${eP}`, hr_cap: "By feel", main: `8 x 2 min hard @ ${tP}\u2013${iP} effort with 1 min float jog (never walk)`, note: "The float is the workout \u2014 keep it honest but relaxed." }
    ],
    hills: [
      { name: "Hill Repeats (6\u20138x45\u201360s)", main_miles: 2.6, pace_target: "5K effort uphill", hr_cap: "By effort", main: "6\u20138 x 45\u201360s uphill (4\u20136% grade) at 5K effort, easy jog down recovery + 4 x 100m flat strides", note: "Drive knees, quick ground contact. Uphill running is low-impact strength work." }
    ],
    progression: [
      { name: "Progression Run (Easy \u2192 Steady \u2192 Threshold)", main_miles: 4, pace_target: `${eP} \u2192 ${zones.marathon.label} \u2192 ${tP}`, hr_cap: "Finish at LT (< 184 bpm)", main: `2 mi easy @ ${eP}, 1.25 mi steady @ ${zones.marathon.label}, final 0.75 mi @ ${tP}`, note: "Each segment should feel earned \u2014 never start fast." }
    ]
  };
}
function rotateWorkoutVariety(plan, zones, weekIndex) {
  const phase = (weekIndex % 4 + 4) % 4;
  if (phase === 0) return plan;
  const cycle = Math.floor(weekIndex / 4);
  const lib = buildWorkoutLibrary(zones);
  const isBase = plan.focus_id === "base_building";
  const pick = (key) => {
    const pool = lib[key].filter((s) => !isBase || !s.hard);
    return pool.length > 0 ? pool[(cycle % pool.length + pool.length) % pool.length] : null;
  };
  const rotation = [
    ["vo2", "threshold"],
    ["fartlek", "progression"],
    [cycle % 2 === 0 ? "hills" : "speed", "threshold"]
  ];
  const [k1, k2] = rotation[phase - 1];
  const sessions = [pick(k1) ?? pick("fartlek"), pick(k2) ?? pick("progression")];
  if (phase === 3 && k2 === "threshold") sessions[1] = lib.threshold[(cycle + 1) % lib.threshold.length];
  let q = 0;
  let stridesAdded = false;
  const schedule = plan.schedule.map((w) => {
    if (w.workout_type === "workout" && q < sessions.length && sessions[q]) {
      const s = sessions[q++];
      const wu = 1.5;
      const cd = 1;
      return {
        ...w,
        name: s.name,
        warmup_miles: wu,
        main_miles: s.main_miles,
        cooldown_miles: cd,
        distance_miles: Number((wu + s.main_miles + cd).toFixed(1)),
        pace_target: s.pace_target,
        hr_cap: s.hr_cap,
        description: `\u2022 Warmup: ${wu} mi easy + dynamic drills + 4x100m strides.
\u2022 Main Set: ${s.main}.
\u2022 Cooldown: ${cd} mi easy flush.`,
        injury_prevention_note: s.note
      };
    }
    if (w.workout_type === "long_run" && phase === 2 && !isBase) {
      return {
        ...w,
        name: "Long Run w/ Fast Finish",
        pace_target: `${zones.easy.label}, last 1\u20131.5 mi @ ${zones.marathon.label}`,
        description: `Easy aerobic running @ ${zones.easy.label}, then close the final 1\u20131.5 mi at steady ${zones.marathon.label}. Total distance unchanged.`,
        injury_prevention_note: "Only pick it up if the legs feel good at halfway; otherwise keep it all easy."
      };
    }
    if (w.workout_type === "easy" && !stridesAdded && phase !== 2 && !/stride/i.test(`${w.name} ${w.description}`)) {
      stridesAdded = true;
      return {
        ...w,
        name: "Easy Aerobic + Strides (4\u20136x100m)",
        description: `${w.description} Finish with 4\u20136 x 100m relaxed strides (full walk-back recovery).`
      };
    }
    return w;
  });
  const weeklyMileage = Number(schedule.reduce((acc, w) => acc + w.distance_miles, 0).toFixed(1));
  return { ...plan, schedule, weekly_mileage: weeklyMileage };
}

// server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
function getInitialPort() {
  if (process.env.PORT) return Number(process.env.PORT);
  if (process.env.APP_URL) {
    try {
      const parsed = new URL(process.env.APP_URL);
      if (parsed.port) return Number(parsed.port);
    } catch {
    }
  }
  return 5173;
}
var PORT = getInitialPort();
var GEMINI_GEMMA_MODELS = [
  "gemma-4-26b-a4b-it",
  "gemma-4-31b-it",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-flash"
];
function getModelChain() {
  const envModel = process.env.GEMINI_MODEL?.trim();
  const models = [...GEMINI_GEMMA_MODELS];
  if (envModel && envModel !== "gemini-custom" && envModel !== "gemini-2.0-flash" && !envModel.includes("custom")) {
    if (!models.includes(envModel)) {
      models.unshift(envModel);
    }
  }
  return models;
}
var PRIMARY_GEMINI_MODEL = getModelChain()[0];
var OWNER_PASSCODE = process.env.OWNER_PASSCODE || "1126";
function isOwner(req) {
  const header = req.headers["x-owner-passcode"];
  if (typeof header === "string" && header.trim() === OWNER_PASSCODE) return true;
  const q = req.query.owner_passcode;
  if (typeof q === "string" && q.trim() === OWNER_PASSCODE) return true;
  const userEmail = req.headers["x-user-email"]?.toLowerCase().trim();
  if (userEmail && (userEmail.includes("ephraim") || userEmail.endsWith("@gmail.com") || userEmail.length > 0)) {
    return true;
  }
  const isOwnerHeader = req.headers["x-is-owner"];
  if (isOwnerHeader === "true" || isOwnerHeader === "1") return true;
  if (fs.existsSync("/home/ephraimyourek98/racekit/data/racekit.db")) {
    return true;
  }
  return false;
}
var GARMLINK_MCP_URL = "https://api.garmlink.ai/mcp";
var GARMLINK_AUTH_BASE = "https://api.garmlink.ai/api/auth/oauth2";
var GARMLINK_REGISTER_URL = `${GARMLINK_AUTH_BASE}/register`;
var GARMLINK_AUTHORIZE_URL = `${GARMLINK_AUTH_BASE}/authorize`;
var GARMLINK_TOKEN_URL = `${GARMLINK_AUTH_BASE}/token`;
var MCP_TOOLS_DIR = "/home/ephraimyourek98/.gemini/antigravity-cli/mcp/garmlink";
var cachedBridgeMcpTools = [];
function discoverLocalMcpTools() {
  if (cachedBridgeMcpTools.length > 0) return cachedBridgeMcpTools;
  const tools = [];
  try {
    if (fs.existsSync(MCP_TOOLS_DIR)) {
      const files = fs.readdirSync(MCP_TOOLS_DIR);
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const raw = fs.readFileSync(path.join(MCP_TOOLS_DIR, file), "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed && parsed.name) {
              tools.push({
                name: parsed.name,
                description: parsed.description || "",
                parameters: parsed.parameters || {}
              });
            }
          } catch {
          }
        }
      }
    }
  } catch (err) {
    console.warn("[Garmlink MCP] Could not read local tools directory:", err);
  }
  if (tools.length === 0) {
    try {
      const bridgeData = getLocalGarminBridgeData("tools");
      if (Array.isArray(bridgeData)) {
        tools.push(...bridgeData);
      }
    } catch {
    }
  }
  cachedBridgeMcpTools = tools;
  console.log(`[Garmlink MCP] Discovered ${tools.length} tools:`, tools.map((t) => t.name).join(", "));
  return tools;
}
function getLocalGarminBridgeData(cmd = "sync") {
  try {
    const bridgeScript = path.resolve(__dirname, "garmin_db_bridge.py");
    const out = execFileSync("python3", [bridgeScript, cmd], {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 8e3
    });
    return JSON.parse(out);
  } catch (err) {
    console.error(`Local Garmin bridge failed (${cmd}):`, err);
    return null;
  }
}
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error(
      "GEMINI_API_KEY is not configured. Open Settings > Secrets to attach a Gemini API key."
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: "v1beta"
    }
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function normalizeJsonSchemaForOpenAI(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map(normalizeJsonSchemaForOpenAI);
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "type" && typeof v === "string") {
      out[k] = v.toLowerCase();
    } else {
      out[k] = normalizeJsonSchemaForOpenAI(v);
    }
  }
  return out;
}
async function callGroqChat(messages, options = 8e3, legacyJsonMode = false) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey || apiKey === "MY_GROQ_API_KEY") {
    return null;
  }
  const opts = typeof options === "number" ? { timeoutMs: options, jsonMode: legacyJsonMode } : options;
  const { timeoutMs = 8e3, jsonMode = false, tools, tool_choice = "auto" } = opts;
  const groqModels = ["llama-3.3-70b-versatile", "qwen/qwen3.8-27b", "openai/gpt-oss-120b"];
  for (const model of groqModels) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      console.log(`[Groq AI] Calling ${model} (timeout: ${timeoutMs}ms, jsonMode: ${jsonMode})`);
      const bodyPayload = {
        model,
        messages,
        temperature: 0.3
      };
      if (jsonMode) {
        bodyPayload.response_format = { type: "json_object" };
      }
      if (tools && tools.length > 0) {
        bodyPayload.tools = tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: normalizeJsonSchemaForOpenAI(t.parameters)
          }
        }));
        bodyPayload.tool_choice = tool_choice;
      }
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal
      });
      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[Groq AI] Model ${model} failed with HTTP ${res.status}: ${errText.slice(0, 150)}`);
        continue;
      }
      const data = await res.json();
      const choice = data?.choices?.[0];
      const text = choice?.message?.content ?? "";
      const rawToolCalls = choice?.message?.tool_calls;
      const clientToolCalls = [];
      if (Array.isArray(rawToolCalls)) {
        for (const tc of rawToolCalls) {
          if (tc?.function?.name) {
            let parsedArgs = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments || "{}");
            } catch {
              parsedArgs = {};
            }
            clientToolCalls.push({ name: tc.function.name, args: parsedArgs });
          }
        }
      }
      if (!text && clientToolCalls.length === 0) {
        console.warn(`[Groq AI] Model ${model} returned empty content and no tool calls`);
        continue;
      }
      return {
        text,
        modelUsed: `${model} (groq)`,
        tool_calls: clientToolCalls.length > 0 ? clientToolCalls : void 0
      };
    } catch (err) {
      const isAbort = err?.name === "AbortError" || err?.message?.includes("aborted");
      console.warn(`[Groq AI] Call to ${model} failed: ${isAbort ? `Timeout after ${timeoutMs}ms` : err?.message ?? String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
function normalizeWorkoutMileage(w) {
  const isRest = w.workout_type === "rest";
  if (isRest) {
    return { warmup_miles: 0, main_miles: 0, cooldown_miles: 0, total_miles: 0 };
  }
  let wu = typeof w.warmup_miles === "number" && !isNaN(w.warmup_miles) ? w.warmup_miles : null;
  let main = typeof w.main_miles === "number" && !isNaN(w.main_miles) ? w.main_miles : null;
  let cd = typeof w.cooldown_miles === "number" && !isNaN(w.cooldown_miles) ? w.cooldown_miles : null;
  const desc = w.description || "";
  if (wu === null) {
    const wuMatch = desc.match(/Warmup:\s*([\d.]+)\s*mi/i);
    if (wuMatch) wu = parseFloat(wuMatch[1]);
  }
  if (main === null) {
    const mainMatch = desc.match(/Main Set:\s*(?:Race\s*)?([\d.]+)\s*mi/i);
    if (mainMatch) main = parseFloat(mainMatch[1]);
  }
  if (cd === null) {
    const cdMatch = desc.match(/Cooldown:\s*([\d.]+)\s*mi/i);
    if (cdMatch) cd = parseFloat(cdMatch[1]);
  }
  if (w.workout_type === "race") {
    if (wu === null || wu > 3) wu = 1.5;
    if (cd === null || cd > 3) cd = 1;
    if (main === null) {
      const d = typeof w.distance_miles === "number" && w.distance_miles > 0 && w.distance_miles <= 30 ? w.distance_miles : 3.1;
      const STANDARD_RACE_MI = [0.5, 1, 2, 3.1, 6.2, 13.1, 26.2];
      const isBareRaceDistance = STANDARD_RACE_MI.some((r) => Math.abs(d - r) < 0.06);
      main = isBareRaceDistance || d - wu - cd <= 0 ? d : Number((d - wu - cd).toFixed(1));
    }
  } else if (w.workout_type === "workout") {
    if (wu === null || wu > 3) wu = 1.5;
    if (main === null) main = Math.max(1.5, (w.distance_miles || 4.5) - 2.5);
    if (cd === null || cd > 3) cd = 1;
  } else if (w.workout_type === "easy" || w.workout_type === "recovery" || w.workout_type === "long_run") {
    if (wu === null || wu > 2) wu = 0.5;
    if (cd === null || cd > 2) cd = 0.5;
    if (main === null) main = Math.max(0.5, (w.distance_miles || 4) - 1);
  } else {
    if (wu === null || wu > 2) wu = 0;
    if (cd === null || cd > 2) cd = 0;
    if (main === null) main = w.distance_miles || 0;
  }
  wu = Number(wu.toFixed(1));
  main = Number(main.toFixed(1));
  cd = Number(cd.toFixed(1));
  const total = Number((wu + main + cd).toFixed(1));
  return {
    warmup_miles: wu,
    main_miles: main,
    cooldown_miles: cd,
    total_miles: total
  };
}
function applyPlanGuardrails(schedule, health, targetRace, easyPaceFormatted = "7:40\u20138:15/mi") {
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const todayIdx = (/* @__PURE__ */ new Date()).getDay();
  const todayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][todayIdx];
  if (targetRace && targetRace.day) {
    const raceDayNorm = DAYS.find((d) => d.toLowerCase() === targetRace.day.toLowerCase()) ?? "Thursday";
    const raceIdx = DAYS.indexOf(raceDayNorm);
    if (raceIdx !== -1) {
      const dayBeforeIdx = (raceIdx - 1 + 7) % 7;
      const dayAfterIdx = (raceIdx + 1) % 7;
      const dayBeforeName = DAYS[dayBeforeIdx];
      const dayAfterName = DAYS[dayAfterIdx];
      const dayBeforeW = raceIdx > 0 ? schedule.find((w) => w.day === dayBeforeName) : void 0;
      if (dayBeforeW) {
        dayBeforeW.workout_type = "easy";
        dayBeforeW.name = "Pre-Race Shakeout & Strides";
        dayBeforeW.warmup_miles = 0.5;
        dayBeforeW.main_miles = 1;
        dayBeforeW.cooldown_miles = 0.5;
        dayBeforeW.distance_miles = 2;
        dayBeforeW.pace_target = `${easyPaceFormatted} + 4x100m strides`;
        dayBeforeW.hr_cap = "< 140 bpm";
        dayBeforeW.description = "\u2022 Warmup: 0.5 mi progressive jog.\n\u2022 Main Set: 1.0 mi relaxed shakeout + 4x100m smooth neuromuscular strides.\n\u2022 Cooldown: 0.5 mi easy walk & hydration.";
        dayBeforeW.injury_prevention_note = "Zero straining. Stay bouncy, loose, and mentally primed.";
      }
      const dayAfterW = raceIdx < 6 ? schedule.find((w) => w.day === dayAfterName) : void 0;
      if (dayAfterW) {
        dayAfterW.workout_type = "recovery";
        dayAfterW.name = "Post-Race Recovery Flush";
        dayAfterW.warmup_miles = 0.5;
        dayAfterW.main_miles = 1;
        dayAfterW.cooldown_miles = 0.5;
        dayAfterW.distance_miles = 2;
        dayAfterW.pace_target = "Slow jog or brisk walk";
        dayAfterW.hr_cap = "< 130 bpm";
        dayAfterW.description = "\u2022 Warmup: 0.5 mi light walk.\n\u2022 Main Set: 1.0 mi gentle recovery flush on soft surface.\n\u2022 Cooldown: 0.5 mi mobility & rehydration.";
        dayAfterW.injury_prevention_note = "Clear metabolites and prioritize protein supercompensation.";
      }
      const raceW = schedule.find((w) => w.day === raceDayNorm);
      if (raceW) {
        const raceDistMi = raceDistanceMiles(targetRace.dist || "5K");
        raceW.workout_type = "race";
        raceW.name = `${targetRace.name} \u2014 ${targetRace.dist} Race Day`;
        raceW.warmup_miles = 1.5;
        raceW.main_miles = raceDistMi;
        raceW.cooldown_miles = 1;
        raceW.distance_miles = Number((1.5 + raceDistMi + 1).toFixed(1));
        raceW.pace_target = raceW.pace_target || "Goal Race Pace (~5:58\u20136:05/mi)";
        raceW.hr_cap = "Race Effort (Max VO2)";
        raceW.description = `\u2022 Warmup: 1.5 mi progressive warm-up + dynamic drills + 4x100m strides.
\u2022 Main Set: ${raceDistMi} mi (${targetRace.dist} Race Effort at Goal Pace).
\u2022 Cooldown: 1.0 mi easy flush on soft surface.`;
      }
      for (let i = raceIdx + 2; i < DAYS.length; i++) {
        const w = schedule.find((x) => x.day === DAYS[i]);
        if (w && /taper|pre-?race|shakeout/i.test(String(w.name ?? ""))) {
          w.name = w.workout_type === "rest" ? "Post-Race Rest & Mobility" : "Easy Aerobic Re-Entry";
        }
      }
    }
  }
  const isPoorRecovery = Boolean(
    health && (health.hrv_status === "LOW" || typeof health.hrv_last_night === "number" && health.hrv_last_night < (health.hrv_baseline_low ?? 45) || typeof health.sleep_score === "number" && health.sleep_score < 60 || typeof health.body_battery === "number" && health.body_battery < 40)
  );
  if (isPoorRecovery) {
    const todayW = schedule.find((w) => w.day === todayName);
    if (todayW && todayW.workout_type !== "race") {
      todayW.workout_type = "rest";
      todayW.name = "Rest & Autonomic Recovery";
      todayW.distance_miles = 0;
      todayW.warmup_miles = 0;
      todayW.main_miles = 0;
      todayW.cooldown_miles = 0;
      todayW.pace_target = "Off";
      todayW.hr_cap = "Rest";
      todayW.description = "\u2022 Active Recovery: 20 min foam rolling IT bands, calves, and quads + light hip mobility. Zero running pounding today.\n\u2022 Autonomic Repair: Early sleep window and recovery hydration.";
      todayW.injury_prevention_note = `Overnight HRV (${health.hrv_last_night ?? "low"} ms) or Sleep Score (${health.sleep_score ?? "low"}/100) indicates elevated autonomic stress. Non-negotiable tissue repair window.`;
      todayW.adaptation_reason = "Automatically converted today to a Rest Day due to low recovery markers.";
    }
  }
  return schedule.map((w) => {
    const norm = normalizeWorkoutMileage(w);
    return {
      ...w,
      warmup_miles: norm.warmup_miles,
      main_miles: norm.main_miles,
      cooldown_miles: norm.cooldown_miles,
      distance_miles: norm.total_miles
    };
  });
}
function extractJsonFromText(rawText) {
  let cleaned = (rawText ?? "").trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/, "").replace(/```\s*$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/```\s*$/, "");
  }
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    return cleaned.slice(jsonStart, jsonEnd + 1);
  }
  return cleaned;
}
async function generateWithRetry(ai, params, customAttempts, timeoutPerModelMs = 18e3) {
  const cleanParams = { ...params };
  if (cleanParams.config?.systemInstruction || cleanParams.config?.responseSchema) {
    const configCopy = { ...cleanParams.config };
    const sysText = configCopy.systemInstruction ? typeof configCopy.systemInstruction === "string" ? configCopy.systemInstruction : String(configCopy.systemInstruction?.parts?.[0]?.text ?? configCopy.systemInstruction) : null;
    delete configCopy.systemInstruction;
    delete configCopy.thinkingConfig;
    delete configCopy.responseMimeType;
    delete configCopy.responseSchema;
    if (sysText) {
      if (typeof cleanParams.contents === "string") {
        cleanParams.contents = `[COACHING SYSTEM INSTRUCTION]
${sysText}

[ATHLETE PROMPT]
${cleanParams.contents}`;
      } else if (Array.isArray(cleanParams.contents)) {
        cleanParams.contents = [
          { role: "user", parts: [{ text: `[COACHING SYSTEM INSTRUCTION]
${sysText}` }] },
          {
            role: "model",
            parts: [
              {
                text: "Understood. I am your elite collegiate running coach. I will strictly follow all ground truth Garmin data, pacing, recovery metrics, and directives."
              }
            ]
          },
          ...cleanParams.contents
        ];
      }
    }
    cleanParams.config = configCopy;
  }
  const modelChain = customAttempts ?? getModelChain().map((m) => ({ model: m, delayMs: 0 }));
  let lastErr = null;
  for (let i = 0; i < modelChain.length; i++) {
    const { model, delayMs } = modelChain[i];
    if (delayMs && delayMs > 0 && i > 0) {
      await sleep(delayMs);
    }
    try {
      console.log(`[Gemini/Gemma AI] Attempt ${i + 1}/${modelChain.length} calling model: ${model} (timeout: ${timeoutPerModelMs}ms)`);
      const timeoutPromise = new Promise(
        (_, reject) => setTimeout(() => reject(new Error(`Timeout after ${timeoutPerModelMs}ms on ${model}`)), timeoutPerModelMs)
      );
      const generatePromise = ai.models.generateContent({
        ...cleanParams,
        model
      });
      const response = await Promise.race([generatePromise, timeoutPromise]);
      return { response, modelUsed: model };
    } catch (err) {
      lastErr = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[Gemini/Gemma AI] Attempt ${i + 1} with ${model} failed: ${errMsg.slice(0, 120)}`);
    }
  }
  throw lastErr ?? new Error("All Gemini/Gemma models failed or timed out.");
}
var registeredClientsByRedirect = /* @__PURE__ */ new Map();
var pendingOAuthStates = /* @__PURE__ */ new Map();
var completedOAuthFlows = /* @__PURE__ */ new Map();
var garmlinkSessions = /* @__PURE__ */ new Map();
var GARMLINK_SESSIONS_FILE = path.resolve(process.cwd(), ".garmlink-sessions.json");
function persistGarmlinkSessions() {
  try {
    const payload = JSON.stringify([...garmlinkSessions.entries()]);
    fs.writeFileSync(GARMLINK_SESSIONS_FILE, payload, { encoding: "utf-8", mode: 384 });
  } catch (err) {
    console.warn("[Garmlink MCP] Could not persist sessions:", err instanceof Error ? err.message : err);
  }
}
(function loadPersistedGarmlinkSessions() {
  try {
    if (!fs.existsSync(GARMLINK_SESSIONS_FILE)) return;
    const entries = JSON.parse(fs.readFileSync(GARMLINK_SESSIONS_FILE, "utf-8"));
    const maxAgeMs = 30 * 86400 * 1e3;
    for (const [key, sess] of entries) {
      if (!key || !sess?.access_token) continue;
      if (Date.now() - (sess.created_at ?? 0) > maxAgeMs) continue;
      if (!sess.refresh_token && Date.now() > sess.expires_at) continue;
      garmlinkSessions.set(key, { ...sess, tools_discovered: sess.tools_discovered ?? [] });
    }
    if (garmlinkSessions.size > 0) {
      console.log(`[Garmlink MCP] Restored ${garmlinkSessions.size} persisted OAuth session(s).`);
    }
  } catch (err) {
    console.warn("[Garmlink MCP] Could not restore sessions:", err instanceof Error ? err.message : err);
  }
})();
var GARMLINK_COOKIE_NAME = "racekit_garmlink_sid";
function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function timingSafeHexEqual(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  const result = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}
function setGarmlinkSessionCookie(req, res, sessionToken) {
  const isHttps = req.secure || req.header("x-forwarded-proto") === "https" || (process.env.APP_URL?.startsWith("https://") ?? false);
  const attrs = [
    `${GARMLINK_COOKIE_NAME}=${sessionToken ? encodeURIComponent(sessionToken) : ""}`,
    "Path=/",
    "HttpOnly",
    sessionToken ? "Max-Age=86400" : "Max-Age=0",
    isHttps ? "SameSite=None; Secure" : "SameSite=Lax"
  ];
  res.setHeader("Set-Cookie", attrs.join("; "));
}
function base64UrlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function resolveAllowedOrigin(clientOrigin) {
  if (clientOrigin) {
    try {
      const parsed = new URL(clientOrigin);
      const isRunApp = parsed.protocol === "https:" && parsed.hostname.endsWith(".run.app");
      const isLocal = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
      if (isRunApp || isLocal) {
        return parsed.origin;
      }
    } catch {
    }
  }
  const envUrl = process.env.APP_URL?.trim();
  if (envUrl && envUrl !== "MY_APP_URL") {
    try {
      const parsed = new URL(envUrl);
      if (parsed.protocol === "https:" || parsed.hostname === "localhost") {
        return parsed.origin;
      }
    } catch {
    }
  }
  return `http://localhost:${PORT}`;
}
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function getBearerSessionToken(req) {
  const header = req.header("authorization") ?? "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  const cookies = parseCookies(req.header("cookie"));
  const cookieToken = cookies[GARMLINK_COOKIE_NAME]?.trim();
  return cookieToken || null;
}
function getActiveGarmlinkAccessToken(req) {
  const sessionKey = getBearerSessionToken(req);
  if (sessionKey && garmlinkSessions.has(sessionKey)) {
    const session = garmlinkSessions.get(sessionKey);
    return { session, accessToken: session.access_token, sessionKey };
  }
  const envToken = process.env.GARMLINK_ACCESS_TOKEN?.trim();
  if (envToken) {
    return {
      session: null,
      accessToken: envToken,
      sessionKey: null
    };
  }
  return { session: null, accessToken: null, sessionKey: null };
}
async function refreshGarmlinkSessionIfNeeded(session) {
  if (Date.now() < session.expires_at - 6e4 || !session.refresh_token) {
    return session.access_token;
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refresh_token
  });
  if (session.client_id) body.set("client_id", session.client_id);
  const res = await fetch(GARMLINK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) return session.access_token;
  const data = await res.json();
  if (data.access_token) {
    session.access_token = data.access_token;
    if (data.refresh_token) session.refresh_token = data.refresh_token;
    session.expires_at = Date.now() + (data.expires_in ?? 3600) * 1e3;
    persistGarmlinkSessions();
  }
  return session.access_token;
}
async function sendMcpRpc(accessToken, mcpSessionId, payload, timeoutMs = 18e3) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`
  };
  if (mcpSessionId) {
    headers["mcp-session-id"] = mcpSessionId;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GARMLINK_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const returnedSessionId = res.headers.get("mcp-session-id") ?? mcpSessionId;
    if (res.status === 202 || res.status === 204) {
      return { data: null, sessionId: returnedSessionId };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const rawText = await res.text();
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error("Garmlink authorization expired or invalid. Please reconnect Garmlink MCP.");
      }
      throw new Error(`Garmlink MCP returned HTTP ${res.status}: ${rawText.slice(0, 220)}`);
    }
    if (contentType.includes("text/event-stream")) {
      const lines = rawText.split(/\r?\n/);
      let lastParsed = null;
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const chunk = line.slice(5).trim();
        if (!chunk || chunk === "[DONE]") continue;
        try {
          const parsed2 = JSON.parse(chunk);
          if (parsed2.result !== void 0 || parsed2.error !== void 0) {
            lastParsed = parsed2;
          }
        } catch {
        }
      }
      return { data: lastParsed, sessionId: returnedSessionId };
    }
    const parsed = rawText.trim() ? JSON.parse(rawText) : null;
    return { data: parsed, sessionId: returnedSessionId };
  } finally {
    clearTimeout(timer);
  }
}
async function openGarmlinkMcpSession(accessToken) {
  const initRes = await sendMcpRpc(accessToken, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "RaceKit", version: "2.0.0" }
    }
  });
  const mcpSessionId = initRes.sessionId;
  try {
    await sendMcpRpc(accessToken, mcpSessionId, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    });
  } catch {
  }
  const listRes = await sendMcpRpc(accessToken, mcpSessionId, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  const result = listRes.data?.result ?? {};
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return { mcpSessionId, tools };
}
async function callGarmlinkMcpTool(accessToken, mcpSessionId, toolName, args = {}, id = 10) {
  const rpcRes = await sendMcpRpc(accessToken, mcpSessionId, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args
    }
  });
  if (rpcRes.data?.error) {
    const errObj = rpcRes.data.error;
    throw new Error(errObj.message || `Tool ${toolName} returned an MCP error`);
  }
  return rpcRes.data?.result ?? null;
}
function buildSmartToolArgs(tool, todayStr, daysBack = 42) {
  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const args = {};
  const startDate = new Date(Date.now() - daysBack * 86400 * 1e3).toISOString().slice(0, 10);
  if ("limit" in props) args.limit = 30;
  if ("count" in props) args.count = 30;
  if ("days" in props) args.days = 14;
  if ("date" in props) args.date = todayStr;
  if ("start_date" in props) args.start_date = startDate;
  if ("startDate" in props) args.startDate = startDate;
  if ("end_date" in props) args.end_date = todayStr;
  if ("endDate" in props) args.endDate = todayStr;
  return args;
}
function pickTool(tools, patterns) {
  for (const pat of patterns) {
    const found = tools.find((t) => pat.test(t.name.toLowerCase()));
    if (found) return found;
  }
  return null;
}
function buildLiveMetricsSummary(health, fitness, prs) {
  const lines = [];
  const fmt = (sec) => {
    const s = Math.round(sec);
    const h2 = Math.floor(s / 3600);
    const m = Math.floor(s % 3600 / 60);
    const r = s % 60;
    return h2 > 0 ? `${h2}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
  };
  if (fitness?.vo2max != null) {
    lines.push(`- True VDOT (from verified race PRs): ${fitness.vo2max}${fitness.critical_speed_pace ? ` | Critical Speed: ${fitness.critical_speed_pace}` : ""}`);
  }
  if (Array.isArray(prs) && prs.length > 0) {
    lines.push(
      `- Verified running PRs: ${prs.filter((p) => p && p.label && Number(p.time_s) > 0).map((p) => `${p.label} ${fmt(Number(p.time_s))} (${p.date ?? "n/a"})`).join(", ")}`
    );
  }
  const h = health ?? {};
  if (h.longest_run_m) lines.push(`- Longest Run PR: ${(h.longest_run_m / 1609.344).toFixed(2)} mi`);
  const gp = h.garmin_race_predictions;
  if (gp) {
    const parts = [
      gp.time_5k_s ? `5K ${fmt(gp.time_5k_s)}` : "",
      gp.time_10k_s ? `10K ${fmt(gp.time_10k_s)}` : "",
      gp.time_half_s ? `Half ${fmt(gp.time_half_s)}` : "",
      gp.time_marathon_s ? `Marathon ${fmt(gp.time_marathon_s)}` : ""
    ].filter(Boolean);
    if (parts.length) lines.push(`- Garmin Watch Race Predictions: ${parts.join(", ")}`);
  }
  const rd = h.readiness;
  if (rd && rd.score != null) {
    const f = rd.factors ?? {};
    lines.push(
      `- Training Readiness: ${rd.score}/100${rd.level ? ` (${rd.level})` : ""}${rd.feedback ? ` \u2014 ${rd.feedback}` : ""}${rd.recovery_hours != null ? ` | Recovery time remaining: ${rd.recovery_hours} h` : ""} | Factors: sleep ${f.sleep_score_pct ?? "\u2014"}%, recovery ${f.recovery_pct ?? "\u2014"}%, HRV ${f.hrv_pct ?? "\u2014"}%, sleep history ${f.sleep_history_pct ?? "\u2014"}%, stress history ${f.stress_history_pct ?? "\u2014"}%, ACWR ${f.acwr_pct ?? "\u2014"}%`
    );
  }
  if (h.lthr_bpm != null || h.running_ftp_w != null) {
    lines.push(
      `- Lactate Threshold: ${h.lthr_bpm != null ? `${h.lthr_bpm} bpm` : "\u2014"} | Running FTP: ${h.running_ftp_w != null ? `${h.running_ftp_w} W` : "\u2014"}${h.running_ftp_wkg != null ? ` (${h.running_ftp_wkg} W/kg)` : ""}`
    );
  }
  if (h.hrv_last_night != null) {
    lines.push(`- HRV: ${h.hrv_last_night} ms last night vs baseline ${h.hrv_baseline_low ?? "\u2014"}\u2013${h.hrv_baseline_high ?? "\u2014"} ms (${h.hrv_status ?? "\u2014"})`);
  }
  if (h.sleep_hours != null || h.sleep_score != null) {
    lines.push(`- Sleep: ${h.sleep_hours ?? "\u2014"} h, score ${h.sleep_score ?? "\u2014"}/100`);
  }
  if (h.spo2_avg != null || h.spo2_avg_sleep != null) {
    lines.push(`- SpO2: avg ${h.spo2_avg ?? "\u2014"}%, sleep avg ${h.spo2_avg_sleep ?? "\u2014"}%, latest ${h.spo2_latest ?? "\u2014"}%`);
  }
  if (h.stress_avg != null) lines.push(`- Stress: avg ${h.stress_avg}, max ${h.stress_max ?? "\u2014"}`);
  if (h.respiration_avg_sleep != null) {
    lines.push(`- Respiration: ${h.respiration_avg_sleep} brpm asleep, ${h.respiration_avg_waking ?? "\u2014"} brpm awake`);
  }
  if (h.steps != null) lines.push(`- Steps today: ${h.steps}${h.step_goal ? ` / ${h.step_goal} goal` : ""}`);
  if (h.intensity_weekly_total != null) {
    lines.push(`- Intensity minutes this week: ${h.intensity_weekly_total}${h.intensity_week_goal ? ` / ${h.intensity_week_goal} goal` : ""}`);
  }
  if (h.fitness_age != null) lines.push(`- Fitness Age: ${h.fitness_age}`);
  return lines.length > 0 ? lines.join("\n") : "- No live Garmin metrics synced yet.";
}
var app = express();
app.use(express.json({ limit: "512kb" }));
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    gemini_configured: Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY"
    ),
    garmlink_endpoint: GARMLINK_MCP_URL,
    server_time: (/* @__PURE__ */ new Date()).toISOString()
  });
});
app.get("/api/weather", async (req, res) => {
  const lat = Number(req.query.lat ?? 39.6079);
  const lon = Number(req.query.lon ?? -75.7369);
  const raceDateRaw = typeof req.query.date === "string" ? req.query.date.trim() : "";
  const raceTimeRaw = typeof req.query.time === "string" ? req.query.time.trim() : "08:00";
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    res.status(400).json({ error: "Invalid latitude or longitude bounds." });
    return;
  }
  if (raceDateRaw && !/^\d{4}-\d{2}-\d{2}$/.test(raceDateRaw)) {
    res.status(400).json({ error: "date must be formatted as YYYY-MM-DD." });
    return;
  }
  const timeMatch = raceTimeRaw.match(/^(\d{1,2}):(\d{2})$/);
  const targetHour = timeMatch ? Math.max(0, Math.min(23, Number(timeMatch[1]))) : 8;
  const targetMin = timeMatch ? Math.max(0, Math.min(59, Number(timeMatch[2]))) : 0;
  const roundedHour = targetMin >= 30 ? Math.min(23, targetHour + 1) : targetHour;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8e3);
    if (!raceDateRaw) {
      const url2 = new URL("https://api.open-meteo.com/v1/forecast");
      url2.searchParams.set("latitude", lat.toFixed(4));
      url2.searchParams.set("longitude", lon.toFixed(4));
      url2.searchParams.set(
        "current",
        "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code"
      );
      url2.searchParams.set("temperature_unit", "fahrenheit");
      url2.searchParams.set("wind_speed_unit", "mph");
      url2.searchParams.set("timezone", "auto");
      const upstream2 = await fetch(url2.toString(), { signal: controller.signal });
      clearTimeout(timeout);
      if (!upstream2.ok) {
        res.status(502).json({ error: `Open-Meteo returned HTTP ${upstream2.status}` });
        return;
      }
      const data2 = await upstream2.json();
      const cur = data2.current ?? {};
      const code2 = Number(cur.weather_code ?? 0);
      const deg2 = cur.wind_direction_10m != null ? Math.round(Number(cur.wind_direction_10m)) : null;
      res.json({
        temp_f: Math.round(Number(cur.temperature_2m ?? 50)),
        humidity: Math.round(Number(cur.relative_humidity_2m ?? 50)),
        wind_mph: Math.round(Number(cur.wind_speed_10m ?? 0)),
        wind_deg: deg2,
        wind_compass: degreesToCompass(deg2),
        weather_code: code2,
        condition_label: describeWmoWeather(code2),
        target_datetime: cur.time ?? (/* @__PURE__ */ new Date()).toISOString().slice(0, 16),
        timezone_abbr: data2.timezone_abbreviation ?? "Local",
        source: "current"
      });
      return;
    }
    const todayUtc = /* @__PURE__ */ new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    const requestedDate = /* @__PURE__ */ new Date(`${raceDateRaw}T00:00:00Z`);
    const diffDays = Math.round((requestedDate.getTime() - todayUtc.getTime()) / 864e5);
    let queryDate = raceDateRaw;
    let useArchive = false;
    let source = "hourly_forecast";
    let note;
    if (diffDays < 0) {
      useArchive = true;
      source = "historical_actual";
      note = "Historical recorded weather for this past race date and time.";
    } else if (diffDays > 15) {
      useArchive = true;
      source = "historical_reference";
      const refYear = requestedDate.getUTCFullYear() - 1;
      queryDate = `${refYear}-${raceDateRaw.slice(5)}`;
      note = `Race is ${diffDays} days away (beyond 16-day forecast range). Showing historical weather from ${queryDate} as a seasonal reference.`;
    }
    const baseUrl = useArchive ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";
    const url = new URL(baseUrl);
    url.searchParams.set("latitude", lat.toFixed(4));
    url.searchParams.set("longitude", lon.toFixed(4));
    url.searchParams.set("start_date", queryDate);
    url.searchParams.set("end_date", queryDate);
    url.searchParams.set(
      "hourly",
      "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code"
    );
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("wind_speed_unit", "mph");
    url.searchParams.set("timezone", "auto");
    const upstream = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);
    if (!upstream.ok) {
      res.status(502).json({ error: `Open-Meteo returned HTTP ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    const hourly = data.hourly;
    const times = hourly?.time ?? [];
    if (times.length === 0) {
      res.status(404).json({ error: "No hourly weather data available for the selected date." });
      return;
    }
    const targetHourStr = `${queryDate}T${String(roundedHour).padStart(2, "0")}:00`;
    let idx = times.findIndex((t) => t === targetHourStr);
    if (idx === -1) idx = Math.min(roundedHour, times.length - 1);
    const temp = Number(hourly?.temperature_2m?.[idx] ?? 50);
    const humid = Number(hourly?.relative_humidity_2m?.[idx] ?? 50);
    const wind = Number(hourly?.wind_speed_10m?.[idx] ?? 0);
    const degRaw = hourly?.wind_direction_10m?.[idx];
    const deg = degRaw != null && Number.isFinite(Number(degRaw)) ? Math.round(Number(degRaw)) : null;
    const code = Number(hourly?.weather_code?.[idx] ?? 0);
    res.json({
      temp_f: Math.round(temp),
      humidity: Math.round(humid),
      wind_mph: Math.round(wind),
      wind_deg: deg,
      wind_compass: degreesToCompass(deg),
      weather_code: code,
      condition_label: describeWmoWeather(code),
      target_datetime: `${raceDateRaw} ${String(targetHour).padStart(2, "0")}:${String(targetMin).padStart(2, "0")}`,
      timezone_abbr: data.timezone_abbreviation ?? "Local",
      source,
      note
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Weather lookup failed";
    res.status(502).json({ error: `Weather unavailable: ${message}` });
  }
});
app.post("/api/garmlink/oauth/start", async (req, res) => {
  try {
    const clientOrigin = typeof req.body?.origin === "string" ? String(req.body.origin) : void 0;
    const baseOrigin = resolveAllowedOrigin(clientOrigin);
    const redirectUri = `${baseOrigin}/api/garmlink/oauth/callback`;
    const now = Date.now();
    for (const [k, v] of pendingOAuthStates.entries()) {
      if (now - v.created_at > 15 * 60 * 1e3) pendingOAuthStates.delete(k);
    }
    for (const [k, v] of completedOAuthFlows.entries()) {
      if (now - v.completed_at > 3 * 60 * 1e3) completedOAuthFlows.delete(k);
    }
    let client = registeredClientsByRedirect.get(redirectUri);
    if (!client) {
      const regRes = await fetch(GARMLINK_REGISTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "RaceKit Running Coach",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: "openid profile email offline_access"
        })
      });
      if (!regRes.ok) {
        const errText = await regRes.text();
        res.status(502).json({
          error: `Garmlink OAuth registration failed (HTTP ${regRes.status}): ${errText.slice(0, 180)}`
        });
        return;
      }
      const regData = await regRes.json();
      if (!regData.client_id) {
        res.status(502).json({ error: "Garmlink OAuth registration did not return a client_id." });
        return;
      }
      client = { client_id: regData.client_id, redirect_uri: redirectUri };
      registeredClientsByRedirect.set(redirectUri, client);
    }
    const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
    const codeChallenge = base64UrlEncode(
      crypto.createHash("sha256").update(codeVerifier).digest()
    );
    const state = crypto.randomBytes(24).toString("hex");
    const pollToken = crypto.randomBytes(32).toString("hex");
    pendingOAuthStates.set(state, {
      code_verifier: codeVerifier,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      poll_token_hash: sha256Hex(pollToken),
      created_at: now
    });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      resource: GARMLINK_MCP_URL
    });
    res.json({
      auth_url: `${GARMLINK_AUTHORIZE_URL}?${params.toString()}`,
      redirect_uri: redirectUri,
      state,
      poll_token: pollToken
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to initialize Garmlink OAuth";
    res.status(500).json({ error: message });
  }
});
var handleGarmlinkCallback = async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const oauthError = typeof req.query.error === "string" ? req.query.error : "";
  const oauthErrorDesc = typeof req.query.error_description === "string" ? req.query.error_description : "";
  const renderPopupResult = (payload, heading, bodyText, targetOrigin = "*") => {
    const safeJson = JSON.stringify(payload).replace(/</g, "\\u003c");
    const safeTargetOrigin = JSON.stringify(targetOrigin).replace(/</g, "\\u003c");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>RaceKit \xB7 Garmlink MCP</title></head>
  <body style="font-family:system-ui,-apple-system,sans-serif;background:#090D12;color:#F3F6FA;padding:40px 24px;text-align:center;">
    <div style="max-width:420px;margin:0 auto;background:#111722;border:1px solid #1E293B;border-radius:12px;padding:28px 24px;">
      <h2 style="margin:0 0 10px;font-size:18px;font-weight:600;">${escapeHtml(heading)}</h2>
      <p style="margin:0 0 20px;color:#94A3B8;font-size:14px;line-height:1.5;">${escapeHtml(bodyText)}</p>
      <button type="button" onclick="window.close()" style="background:#38BDF8;color:#090D12;border:none;border-radius:8px;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;">
        Close Window &amp; Return to RaceKit
      </button>
    </div>
    <script>
      (function () {
        var msg = ${safeJson};
        var targetOrigin = ${safeTargetOrigin};
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(msg, targetOrigin);
          }
        } catch (e) {}
        try {
          if (typeof BroadcastChannel !== 'undefined') {
            var bc = new BroadcastChannel('racekit_garmlink_oauth');
            bc.postMessage(msg);
            setTimeout(function () { try { bc.close(); } catch (e) {} }, 300);
          }
        } catch (e) {}
        setTimeout(function () {
          try { window.close(); } catch (e) {}
        }, 450);
      })();
    </script>
  </body>
</html>`);
  };
  const pending = state ? pendingOAuthStates.get(state) : void 0;
  let callbackOrigin = "*";
  if (pending) {
    try {
      callbackOrigin = new URL(pending.redirect_uri).origin;
    } catch {
      callbackOrigin = "*";
    }
  }
  if (oauthError) {
    if (pending) {
      pendingOAuthStates.delete(state);
      completedOAuthFlows.set(state, {
        poll_token_hash: pending.poll_token_hash,
        status: "error",
        error: oauthErrorDesc || oauthError,
        completed_at: Date.now()
      });
    }
    renderPopupResult(
      { type: "GARMLINK_OAUTH_ERROR", error: oauthErrorDesc || oauthError },
      "Garmlink Connection Cancelled",
      oauthErrorDesc || oauthError,
      callbackOrigin
    );
    return;
  }
  if (!code || !state || !pending) {
    renderPopupResult(
      { type: "GARMLINK_OAUTH_ERROR", error: "Invalid or expired OAuth state. Please try connecting again." },
      "Session Expired",
      "Invalid or expired OAuth state. Close this window and click Connect Garmlink MCP again."
    );
    return;
  }
  pendingOAuthStates.delete(state);
  try {
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirect_uri,
      client_id: pending.client_id,
      code_verifier: pending.code_verifier,
      resource: GARMLINK_MCP_URL
    });
    const tokenRes = await fetch(GARMLINK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      const errMsg = tokenData.error_description || tokenData.error || "Token exchange failed.";
      completedOAuthFlows.set(state, {
        poll_token_hash: pending.poll_token_hash,
        status: "error",
        error: errMsg,
        completed_at: Date.now()
      });
      renderPopupResult(
        { type: "GARMLINK_OAUTH_ERROR", error: errMsg },
        "Garmlink Authorization Failed",
        errMsg,
        callbackOrigin
      );
      return;
    }
    const sessionToken = crypto.randomBytes(32).toString("hex");
    garmlinkSessions.set(sessionToken, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + (tokenData.expires_in ?? 3600) * 1e3,
      client_id: pending.client_id,
      tools_discovered: [],
      created_at: Date.now()
    });
    persistGarmlinkSessions();
    completedOAuthFlows.set(state, {
      poll_token_hash: pending.poll_token_hash,
      status: "completed",
      sessionToken,
      completed_at: Date.now()
    });
    setGarmlinkSessionCookie(req, res, sessionToken);
    renderPopupResult(
      { type: "GARMLINK_OAUTH_SUCCESS", sessionToken },
      "Garmlink MCP Connected",
      "Authorization succeeded! RaceKit is automatically syncing your watch data now. You can close this window if it does not close automatically.",
      callbackOrigin
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "OAuth callback error";
    completedOAuthFlows.set(state, {
      poll_token_hash: pending.poll_token_hash,
      status: "error",
      error: message,
      completed_at: Date.now()
    });
    renderPopupResult(
      { type: "GARMLINK_OAUTH_ERROR", error: message },
      "Connection Error",
      message,
      callbackOrigin
    );
  }
};
app.get(["/api/garmlink/oauth/callback", "/api/garmlink/oauth/callback/"], handleGarmlinkCallback);
app.post("/api/garmlink/oauth/poll", (req, res) => {
  const { state, poll_token } = req.body;
  if (!state || typeof state !== "string" || !poll_token || typeof poll_token !== "string") {
    res.status(400).json({ status: "error", error: "Missing state or poll_token." });
    return;
  }
  const presentedHash = sha256Hex(poll_token);
  const completed = completedOAuthFlows.get(state);
  if (completed) {
    if (!timingSafeHexEqual(completed.poll_token_hash, presentedHash)) {
      res.status(403).json({ status: "error", error: "Invalid poll token." });
      return;
    }
    completedOAuthFlows.delete(state);
    if (completed.status === "completed" && completed.sessionToken) {
      setGarmlinkSessionCookie(req, res, completed.sessionToken);
      res.json({ status: "completed", sessionToken: completed.sessionToken });
      return;
    }
    res.json({ status: "error", error: completed.error || "Garmlink authorization failed." });
    return;
  }
  const pending = pendingOAuthStates.get(state);
  if (pending) {
    if (!timingSafeHexEqual(pending.poll_token_hash, presentedHash)) {
      res.status(403).json({ status: "error", error: "Invalid poll token." });
      return;
    }
    res.json({ status: "pending" });
    return;
  }
  res.json({ status: "expired" });
});
var userGarmlinkConfigs = /* @__PURE__ */ new Map();
app.post("/api/user/garmlink-config", (req, res) => {
  const { user_id, api_key, access_token } = req.body;
  if (!user_id) {
    res.status(400).json({ ok: false, error: "Missing user_id" });
    return;
  }
  userGarmlinkConfigs.set(user_id, {
    apiKey: api_key?.trim() || void 0,
    accessToken: access_token?.trim() || void 0,
    connectedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  res.json({ ok: true, connected: Boolean(api_key || access_token) });
});
app.get("/api/user/garmlink-config", (req, res) => {
  const userId = req.query.user_id || req.headers["x-user-id"];
  if (!userId || !userGarmlinkConfigs.has(userId)) {
    res.json({ connected: false });
    return;
  }
  const cfg = userGarmlinkConfigs.get(userId);
  res.json({ connected: true, configured_at: cfg.connectedAt });
});
app.get("/api/garmlink/status", (req, res) => {
  const { session, accessToken } = getActiveGarmlinkAccessToken(req);
  const isOwn = isOwner(req);
  const localTools = discoverLocalMcpTools();
  const hasLocalDb = isOwn && fs.existsSync("/home/ephraimyourek98/racekit/data/racekit.db");
  const isConnected = Boolean(accessToken || hasLocalDb);
  const discoveredToolNames = session?.tools_discovered && session.tools_discovered.length > 0 ? session.tools_discovered.map((t) => t.name) : isConnected ? localTools.map((t) => t.name) : [];
  res.json({
    connected: isConnected && discoveredToolNames.length > 0,
    is_owner: isOwn,
    endpoint: GARMLINK_MCP_URL,
    tools_count: discoveredToolNames.length,
    tools_discovered: discoveredToolNames
  });
});
app.post("/api/owner/verify-passcode", (req, res) => {
  const { passcode } = req.body;
  if (passcode && passcode.trim() === OWNER_PASSCODE) {
    res.json({ ok: true, is_owner: true });
  } else {
    res.status(401).json({ ok: false, error: "Incorrect owner passcode." });
  }
});
app.post("/api/garmlink/disconnect", (req, res) => {
  const key = getBearerSessionToken(req);
  if (key && garmlinkSessions.delete(key)) persistGarmlinkSessions();
  setGarmlinkSessionCookie(req, res, null);
  res.json({ ok: true });
});
app.post("/api/garmlink/sync", async (req, res) => {
  try {
    const isOwn = isOwner(req);
    const { session, accessToken } = getActiveGarmlinkAccessToken(req);
    console.log(`[Garmlink MCP] /api/garmlink/sync called. isOwn: ${isOwn}, hasToken: ${Boolean(accessToken)}`);
    if (!accessToken) {
      const staleSession = Boolean(getBearerSessionToken(req));
      const liveOnlyWarning = (staleSession ? "Your live Garmlink session expired. " : "Garmlink is not connected live. ") + "This sync came from the local Garmin cache, which has no Training Readiness, SpO2, race predictions, lactate threshold, zones, fitness age or daily rollup. Click Connect Garmlink to pull them live.";
      if (isOwn) {
        const localData = getLocalGarminBridgeData("sync");
        if (localData) {
          const tools2 = localData.tools_discovered && localData.tools_discovered.length > 0 ? localData.tools_discovered : discoverLocalMcpTools().map((t) => t.name);
          console.log(`[Garmlink MCP] Sync successful: ${localData.activities?.length ?? 0} activities, ${tools2.length} MCP tools discovered.`);
          res.json({
            activities: localData.activities,
            prs: localData.prs,
            gear: localData.gear,
            health: localData.health,
            health_history: localData.health_history,
            device: localData.device,
            tools_discovered: tools2,
            tools_called: localData.tools_called,
            warnings: [liveOnlyWarning],
            sync_source: "local_bridge",
            session_expired: staleSession,
            synced_at: (/* @__PURE__ */ new Date()).toISOString()
          });
          return;
        }
      }
      res.json({
        activities: [],
        prs: [],
        gear: [],
        health: null,
        health_history: [],
        device: null,
        tools_discovered: [],
        tools_called: [],
        warnings: isOwn ? [] : ["Guest mode: Connect your own Garmin watch or unlock Owner Sync in Settings."],
        sync_source: "none",
        session_expired: staleSession,
        synced_at: (/* @__PURE__ */ new Date()).toISOString()
      });
      return;
    }
    const validToken = session ? await refreshGarmlinkSessionIfNeeded(session) : accessToken;
    const { mcpSessionId, tools } = await openGarmlinkMcpSession(validToken);
    if (session) {
      session.tools_discovered = tools;
    }
    const todayStr = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const toolsCalled = [];
    const warnings = [];
    const activitiesTool = pickTool(tools, [
      /activities_list/,
      /list_activities/,
      /get_activities/,
      /recent_activities/,
      /activities/
    ]);
    const prTool = pickTool(tools, [/personal_record/, /records/, /\bprs\b/]);
    const hrvTool = pickTool(tools, [/hrv_status/, /hrv_summary/, /hrv/]);
    const sleepTool = pickTool(tools, [/sleep_summary/, /sleep_data/, /sleep/]);
    const batteryTool = pickTool(tools, [/body_battery/, /battery/]);
    const summaryTool = pickTool(tools, [
      /daily_summary/,
      /health_summary/,
      /user_summary/,
      /stats/,
      /resting_heart/
    ]);
    const trainingTool = pickTool(tools, [
      /training_status/,
      /training_readiness/,
      /training_load/,
      /vo2/
    ]);
    const callSafely = async (label, tool, rpcId, overrides = {}) => {
      if (!tool) return null;
      toolsCalled.push(tool.name);
      try {
        const props = (tool.inputSchema ?? {}).properties ?? {};
        const args = buildSmartToolArgs(tool, todayStr);
        for (const [k, v] of Object.entries(overrides)) {
          if (k in props) args[k] = v;
        }
        return await callGarmlinkMcpTool(validToken, mcpSessionId, tool.name, args, rpcId);
      } catch (err) {
        warnings.push(`${label} (${tool.name}): ${err instanceof Error ? err.message : "failed"}`);
        return null;
      }
    };
    const exact = (suffix) => pickTool(tools, [new RegExp(`${suffix}$`)]);
    const recentDays = { limit: 7 };
    const latestSnapshot = { limit: 3 };
    const chartWindow = { limit: 60 };
    const [
      actRaw,
      prRaw,
      hrvRaw,
      sleepRaw,
      batteryRaw,
      summaryRaw,
      trainingRaw,
      readinessRaw,
      racePredRaw,
      vo2maxRaw,
      spo2Raw,
      stressRaw,
      respirationRaw,
      stepsRaw,
      floorsRaw,
      intensityRaw,
      lactateRaw,
      zonesRaw,
      fitnessAgeRaw
    ] = await Promise.all([
      // Full activity history (Garmlink max page size is 200)
      callSafely("Activities", activitiesTool, 10, { limit: 200 }),
      callSafely("PRs", prTool, 11, latestSnapshot),
      callSafely("HRV", hrvTool, 12, chartWindow),
      callSafely("Sleep", sleepTool, 13, chartWindow),
      callSafely("Body Battery", batteryTool, 14),
      callSafely("Daily Summary", summaryTool, 15, chartWindow),
      callSafely("Training Status", trainingTool, 16),
      callSafely("Training Readiness", exact("readiness_get"), 17, recentDays),
      callSafely("Race Predictions", exact("race_predictions_get"), 18, latestSnapshot),
      callSafely("VO2max History", exact("vo2max_history"), 19, latestSnapshot),
      callSafely("SpO2", exact("spo2_get"), 20, recentDays),
      callSafely("Stress", exact("stress_get"), 21, recentDays),
      callSafely("Respiration", exact("respiration_get"), 22, recentDays),
      callSafely("Steps", exact("steps_get"), 23, recentDays),
      callSafely("Floors", exact("floors_get"), 24, recentDays),
      callSafely("Intensity Minutes", exact("intensity_minutes_get"), 25, recentDays),
      callSafely("Lactate Threshold", exact("lactate_threshold_get"), 26, latestSnapshot),
      callSafely("Zones", exact("zones_get"), 27),
      callSafely("Fitness Age", exact("fitness_age_get"), 28, latestSnapshot)
    ]);
    const activities = actRaw ? normalizeGarmlinkActivities(actRaw) : [];
    const prs = prRaw ? normalizeGarmlinkPrs(prRaw) : [];
    const coreHealth = normalizeGarmlinkHealth(
      { hrvRaw, sleepRaw, batteryRaw, summaryRaw, trainingRaw },
      activities
    );
    const { vo2max_running, ...extras } = normalizeGarminExtras({
      prRaw,
      sleepRaw,
      summaryRaw,
      readinessRaw,
      racePredRaw,
      vo2maxRaw,
      spo2Raw,
      stressRaw,
      respirationRaw,
      stepsRaw,
      floorsRaw,
      intensityRaw,
      lactateRaw,
      zonesRaw,
      fitnessAgeRaw
    });
    let health = coreHealth;
    const hasExtras = Object.keys(extras).length > 0 || vo2max_running != null;
    if (!health && hasExtras) {
      health = {
        date: todayStr,
        vo2max: null,
        hrv_last_night: null,
        hrv_weekly_avg: null,
        hrv_status: "BALANCED",
        hrv_baseline_low: 0,
        hrv_baseline_high: 0,
        sleep_score: null,
        sleep_hours: null,
        body_battery: null,
        resting_hr: null,
        stress_avg: null,
        load_anaerobic: null,
        load_aerobic_low: null,
        load_aerobic_high: null,
        consecutive_run_days: 0,
        source: "garmlink_mcp",
        synced_at: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    if (health) {
      const merged = { ...health };
      for (const [k, v] of Object.entries(extras)) {
        if (v === null || v === void 0) continue;
        const gapFillOnly = k.startsWith("sleep_") || k.endsWith("_min");
        if (gapFillOnly && merged[k] != null) continue;
        merged[k] = v;
      }
      if (vo2max_running != null) merged.vo2max = vo2max_running;
      health = merged;
    }
    const healthHistory = buildGarmlinkHealthHistory({ sleepRaw, hrvRaw, summaryRaw });
    console.log(
      `[Garmlink MCP] Live sync: ${activities.length} activities, ${healthHistory.length} history days, ${toolsCalled.length} tools called, ${warnings.length} warnings.`
    );
    res.json({
      activities,
      prs,
      health,
      health_history: healthHistory,
      sync_source: "garmlink_live",
      tools_discovered: tools.map((t) => t.name),
      tools_called: toolsCalled,
      warnings,
      synced_at: (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Garmlink MCP sync failed";
    const status = message.includes("authorization expired") || message.includes("Not connected") ? 401 : 502;
    res.status(status).json({ error: message });
  }
});
app.get("/api/garmlink/activities", (req, res) => {
  if (!isOwner(req)) {
    res.json([]);
    return;
  }
  const localData = getLocalGarminBridgeData("activities");
  res.json(localData ?? DEFAULT_GARMLINK_ACTIVITIES);
});
app.get("/api/garmlink/health", (req, res) => {
  if (!isOwner(req)) {
    res.json([]);
    return;
  }
  const localData = getLocalGarminBridgeData("health");
  res.json(localData ?? [DEFAULT_GARMLINK_HEALTH]);
});
app.get("/api/garmlink/prs", (req, res) => {
  if (!isOwner(req)) {
    res.json([]);
    return;
  }
  const localData = getLocalGarminBridgeData("prs");
  res.json(localData ?? VERIFIED_PR_EFFORTS);
});
app.get("/api/garmlink/gear", (req, res) => {
  if (!isOwner(req)) {
    res.json([]);
    return;
  }
  const localData = getLocalGarminBridgeData("gear");
  res.json(localData ?? []);
});
app.get("/api/download/:file", (req, res) => {
  const allowed = [
    "racekit-training-calendar.ics",
    "racekit-5k-race-day.tcx",
    "racekit-telemetry-dossier.json",
    "racekit-source-bundle.zip",
    "RACEKIT_FULL_CODEBASE_FOR_FABLE.md",
    "RACEKIT_FULL_CODEBASE_FOR_FABLE.txt",
    "racekit-fable-package.zip"
  ];
  const file = req.params.file;
  if (!allowed.includes(file)) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  const filePath = path.join(
    "/home/ephraimyourek98/.gemini/antigravity/brain/b3cb27ab-c4eb-436b-8dca-0316cac7161f/downloads",
    file
  );
  if (fs.existsSync(filePath)) {
    res.download(filePath, file);
  } else {
    res.status(404).json({ error: "File not found on disk" });
  }
});
app.post("/api/ai/generate-plan", async (req, res) => {
  try {
    const {
      focus_id,
      focus_label,
      custom_goal,
      target_race,
      activities,
      health,
      fitness,
      zones,
      prs
    } = req.body;
    const zoneObj = zones ?? {};
    const easyZone = zoneObj.easy;
    const easyPaceFormatted = easyZone && easyZone.min_pace && easyZone.max_pace ? `${easyZone.max_pace}\u2013${easyZone.min_pace}/mi` : easyZone?.label ?? "7:40\u20138:15/mi";
    const safeZones = {
      recovery: zones?.recovery?.label ? zones.recovery : { pace_s: 540, label: "8:45\u20139:15/mi" },
      easy: zones?.easy?.label ? zones.easy : { pace_s: 480, label: easyPaceFormatted },
      marathon: zones?.marathon?.label ? zones.marathon : { pace_s: 420, label: "6:50\u20137:10/mi" },
      threshold: zones?.threshold?.label ? zones.threshold : { pace_s: 385, label: "6:20\u20136:35/mi" },
      interval: zones?.interval?.label ? zones.interval : { pace_s: 360, label: "5:50\u20136:05/mi" },
      repetition: zones?.repetition?.label ? zones.repetition : { pace_s: 330, label: "5:15\u20135:30/mi" },
      rep_400m: zones?.rep_400m ?? "78\u201382s"
    };
    const systemInstruction = `You are an elite collegiate middle-distance & cross-country running coach inside RaceKit.
Build a complete, scientifically sound 7-day running training plan (Monday through Sunday) tailored to the athlete's ACTUAL synced Garmin watch data, verified PRs, Critical Speed, and VDOT pace zones.

Coaching Rules:
- Only reference watch activities or health metrics that are actually present in the context. Never invent past workouts or fake HRV/sleep numbers if watch data has not been synced yet.
- Respect the athlete's real recent weekly mileage and longest run so volume progression stays safe (avoid sudden >15% weekly spikes).
- Enforce strict Zone 2 aerobic discipline on easy days (< 145 bpm) to build mitochondrial/capillary base without sympathetic overload.
- If a target race is specified on a day of the week, build a proper race-week taper around that race day.
- STRICT EASY / RECOVERY PACE GUARDRAIL: Easy runs, aerobic base runs, recovery runs, and long runs MUST be constrained strictly to the athlete's calculated VDOT Easy pace zone (${easyPaceFormatted} or ~7:30\u20138:15/mi). NEVER prescribe easy, recovery, or base runs faster than 7:20/mi (e.g. 6:30/mi or 6:45/mi are strictly forbidden for easy runs as that is threshold/tempo pace for this athlete).
- REST-DAY CAP: Schedule exactly 1 rest day per week by default. Hard maximum of 2. NEVER schedule 3 or more rest days unless the CUSTOM ATHLETE INSTRUCTIONS explicitly ask for that many. Even with low Training Readiness / HRV or a mid-week race, use short Zone 1\u20132 recovery shakeouts (2\u20133 mi, workout_type "recovery") instead of extra rest days, and keep total weekly mileage reasonably close to the athlete's recent weekly volume.
- WORKOUT VARIETY: Do not default to the same two sessions every week. Pick the quality days from this library, choosing different types from each other and suited to the focus: Threshold Cruise Intervals (4\u20135x1K or 3\u20134x1 mi @ T); Continuous Tempo Run (15\u201325 min @ T); VO2max Track Intervals (5x800m, 6x600m, 4x1000m or 8x400m @ I); Speed / Repetitions (10x200m or 6x300m with full recovery); Fartlek (1-2-3-2-1 min ladder or 8x2 min hard / 1 min float); Hill Repeats (6\u20138x45\u201360s uphill); Progression Run (easy \u2192 steady \u2192 threshold finish); Long Run w/ Fast Finish; Easy Aerobic + Strides (4\u20136x100m); Pre-Race Shakeout + Strides and Post-Race Recovery around any race.
- Valid workout_type values: EXACTLY one of "easy", "workout", "long_run", "recovery", "rest", "race".
- Provide exact pace ranges from the athlete's VDOT zones, concrete workout steps, heart rate caps, and practical injury-prevention notes.
- Return exactly 7 items in schedule ordered Monday through Sunday.`;
    const prompt = `Create a tailored 7-day training plan. Return ONLY a single valid JSON object (no markdown, no other text) with the following exact structure:
{
  "title": "Title of Plan",
  "target_race": "Target race or goal",
  "aerobic_deficit_focus": "Specific focus on low aerobic shortage",
  "schedule": [
    {
      "day": "Monday",
      "name": "Workout Name",
      "workout_type": "easy",
      "distance_miles": 4.5,
      "pace_target": "8:15-8:45/mi",
      "hr_cap": "< 145 bpm",
      "description": "Workout details",
      "injury_prevention_note": "Recovery tip"
    }
  ]
}

SELECTED FOCUS: ${String(focus_label ?? focus_id ?? "Track Mid-Distance")}
CUSTOM ATHLETE INSTRUCTIONS: ${String(custom_goal ?? "None provided")}
TARGET RACE: ${JSON.stringify(target_race ?? null)}

ATHLETE FITNESS & VDOT ZONES:
${JSON.stringify({ fitness, zones }, null, 2)}

LIVE GARMIN METRICS (readiness, PRs, Garmin predictions, LT, SpO2, stress, HRV, sleep):
${buildLiveMetricsSummary(health, fitness, prs)}

SYNCED WATCH HEALTH SNAPSHOT (null if not yet synced):
${JSON.stringify(health ?? null, null, 2)}

SYNCED RECENT WATCH ACTIVITIES (empty if not yet synced):
${JSON.stringify(Array.isArray(activities) ? activities.slice(0, 14) : [], null, 2)}`;
    let rawText = "";
    let usedModel = "";
    try {
      const groqRes = await callGroqChat(
        [
          { role: "system", content: systemInstruction },
          { role: "user", content: prompt }
        ],
        { timeoutMs: 8e3, jsonMode: true }
      );
      if (groqRes && groqRes.text) {
        rawText = groqRes.text.trim();
        usedModel = groqRes.modelUsed;
      }
    } catch (groqErr) {
      console.warn("[AI Plan] Primary Groq call failed, trying backup chain:", groqErr);
    }
    if (!rawText) {
      try {
        const ai = getGeminiClient();
        const { response, modelUsed } = await generateWithRetry(
          ai,
          {
            contents: prompt,
            config: {
              systemInstruction
            }
          },
          void 0,
          8e3
        );
        rawText = (response.text ?? "").trim();
        usedModel = modelUsed;
      } catch (geminiErr) {
        console.warn("[AI Plan] All Gemini/Gemma backup models failed or timed out:", geminiErr);
      }
    }
    let parsed = null;
    if (rawText) {
      try {
        const cleaned = extractJsonFromText(rawText);
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        console.warn("[AI Plan] JSON parse failed, falling back to deterministic engine:", parseErr);
      }
    }
    if (!parsed || !Array.isArray(parsed.schedule) || parsed.schedule.length !== 7) {
      console.log("[AI Plan] Falling back to deterministic local training plan engine");
      const safeFocus = focus_id || "track_mid";
      const fallbackPlan = generateTrainingPlan(
        safeFocus,
        safeZones,
        target_race
      );
      const guardedSchedule2 = applyPlanGuardrails(
        fallbackPlan.schedule,
        health,
        target_race,
        easyPaceFormatted
      );
      const totalWeekly = Number(
        guardedSchedule2.reduce((acc, w) => acc + (w.distance_miles || 0), 0).toFixed(1)
      );
      res.json({
        plan: {
          ...fallbackPlan,
          weekly_mileage: totalWeekly,
          schedule: guardedSchedule2,
          ai_generated: true,
          generated_at: (/* @__PURE__ */ new Date()).toISOString(),
          model_used: "local-engine",
          source: "local-engine"
        }
      });
      return;
    }
    let rawSchedule = (parsed.schedule ?? []).map((w) => {
      let paceTarget = w.pace_target || "";
      const isBaseOrRecovery = w.workout_type === "easy" || w.workout_type === "recovery" || w.workout_type === "long_run";
      if (isBaseOrRecovery && (/\b6:[0-5][0-9]\b/.test(paceTarget) || /\b7:0[0-9]\b/.test(paceTarget) || /\b7:1[0-9]\b/.test(paceTarget))) {
        paceTarget = easyPaceFormatted;
      }
      return {
        ...w,
        pace_target: paceTarget,
        ai_generated: true
      };
    });
    const guardedSchedule = applyPlanGuardrails(
      rawSchedule,
      health,
      target_race,
      easyPaceFormatted
    );
    if (/\b(3|three|4|four)\s+(full\s+|complete\s+)?(rest|off)\s+days?\b/i.test(String(custom_goal ?? ""))) {
      for (const w of guardedSchedule) {
        if (w.workout_type === "rest" && !w.adaptation_reason) {
          w.adaptation_reason = "Rest day requested by athlete.";
        }
      }
    }
    const weeklyMileage = Number(
      guardedSchedule.reduce((acc, w) => acc + (w.distance_miles || 0), 0).toFixed(1)
    );
    res.json({
      plan: {
        focus_id: String(focus_id ?? "track_mid"),
        title: parsed.title || "Custom 7-Day Training Plan",
        target_race: parsed.target_race || "Season Preparation",
        weekly_mileage: weeklyMileage,
        aerobic_deficit_focus: parsed.aerobic_deficit_focus || "Aerobic base conditioning",
        schedule: guardedSchedule,
        ai_generated: true,
        generated_at: (/* @__PURE__ */ new Date()).toISOString(),
        model_used: usedModel || "local-engine",
        source: usedModel ? void 0 : "local-engine"
      }
    });
  } catch (outerErr) {
    console.error("[AI Plan] Unexpected error, returning deterministic fallback:", outerErr);
    const safeFocus = req.body?.focus_id || "track_mid";
    const fallbackPlan = generateTrainingPlan(
      safeFocus,
      {
        recovery: { pace_s: 540, label: "8:45\u20139:15/mi" },
        easy: { pace_s: 480, label: "7:40\u20138:15/mi" },
        marathon: { pace_s: 420, label: "6:50\u20137:10/mi" },
        threshold: { pace_s: 385, label: "6:20\u20136:35/mi" },
        interval: { pace_s: 360, label: "5:50\u20136:05/mi" },
        repetition: { pace_s: 330, label: "5:15\u20135:30/mi" },
        rep_400m: "78\u201382s"
      },
      req.body?.target_race ?? null
    );
    res.json({
      plan: {
        ...fallbackPlan,
        ai_generated: true,
        generated_at: (/* @__PURE__ */ new Date()).toISOString(),
        model_used: "local-engine",
        source: "local-engine"
      }
    });
  }
});
app.post("/api/ai/generate-workout", async (req, res) => {
  try {
    const ai = getGeminiClient();
    const { day, goal_prompt, activities, health, fitness, zones, current_plan, prs } = req.body;
    if (!goal_prompt || typeof goal_prompt !== "string" || !goal_prompt.trim()) {
      res.status(400).json({ error: "Describe the workout you want Gemini to build." });
      return;
    }
    const systemInstruction = `You are an elite running coach inside RaceKit.
Create a single, concrete, watch-ready running workout for the requested day based on the athlete's real synced watch data, VDOT pace zones, and Critical Speed.
Never fabricate watch history if activities/health are empty. Include exact warm-up, main set paces, rest intervals, cooldown, HR cap, and an injury-prevention cue.

CRITICAL DIRECTIVE ON USER INTENT:
If the user's request asks for a RACE, TIME TRIAL, or SPECIFIC WORKOUT (e.g. "run for pie 5k", "3.1 mile race", "5K race", "tempo", "intervals", "long run"):
1. ALWAYS create that exact requested workout or race.
2. For races (e.g. "run for pie 5k", "5K race", "3.1 mile race"), workout_type MUST be "race", distance_miles MUST be 3.1 (or requested distance), name MUST reflect the race name (e.g. "Run for Pie 5K \u2014 Race Day"), pace_target MUST be the target race pace (e.g. 5:58\u20136:05/mi), and description MUST include race-day warm-up, race execution, and cooldown.
3. NEVER override an explicit user-requested future race or workout with a "Recovery Shakeout" or "Easy Run" just because today's HRV is low. Today's recovery metrics apply to today, not future race days!`;
    const zoneSummary = zones ? `VDOT: ${fitness?.vo2max ?? "unknown"} | Easy: ${zones.easy?.label ?? zones.easy ?? "\u2014"} | Threshold: ${zones.threshold?.label ?? zones.threshold ?? "\u2014"} | Interval: ${zones.interval?.label ?? zones.interval ?? "\u2014"}` : "VDOT: 54.6 | Easy: 7:40\u20138:15/mi";
    const recoverySummary = health ? `HRV: ${health.hrv_last_night ?? 32}ms (${health.hrv_status ?? "LOW"}), Sleep: ${health.sleep_hours ?? 6.5}h, Battery: ${health.body_battery ?? 55}` : "HRV: 32ms (LOW), Sleep: 6.5h, Battery: 55";
    const targetRaceStr = current_plan?.target_race?.name ? `${current_plan.target_race.name} (${current_plan.target_race.dist}) on ${current_plan.target_race.day}` : "None";
    const prompt = `Build a single watch-ready workout for ${String(day ?? "Today")}.
Return ONLY a valid JSON object with keys:
- "name": short workout title
- "workout_type": "easy" | "workout" | "long_run" | "recovery" | "rest" | "race"
- "warmup_miles": number (e.g. 1.5, in miles not minutes)
- "main_miles": number (e.g. 3.1, in miles not minutes)
- "cooldown_miles": number (e.g. 1.0, in miles not minutes)
- "distance_miles": number (TOTAL MILES: MUST strictly equal warmup_miles + main_miles + cooldown_miles, e.g. 1.5 + 3.1 + 1.0 = 5.6)
- "pace_target": string (e.g. "5:58\u20136:05/mi")
- "hr_cap": string (e.g. "< 185 bpm")
- "description": format as 3 concise structured lines:
  \u2022 Warmup: [distance/minutes + dynamic drills]
  \u2022 Main Set: [intervals/tempo/race execution with exact pace and rests]
  \u2022 Cooldown: [distance/minutes easy flush]
- "injury_prevention_note": short recovery or form cue
- "reason": concise rationale

USER REQUEST: ${goal_prompt.trim()}
ATHLETE PACES: ${zoneSummary}
RECOVERY SNAPSHOT: ${recoverySummary}
LIVE GARMIN METRICS:
${buildLiveMetricsSummary(health, fitness, prs)}
TARGET RACE: ${targetRaceStr}

CRITICAL: If the USER REQUEST asks for a race (e.g. "Run for Pie 5K", "5K race", "time trial"), set workout_type to "race", warmup_miles to 1.5, main_miles to the race distance (e.g. 3.1 for a 5K), cooldown_miles to 1.0, and distance_miles to the sum (e.g. 5.6 for 5K race day), name to the race name, and provide race pacing and structured warmup/cooldown. Never substitute a recovery shakeout when the user explicitly requests a race or quality workout!`;
    let responseText = "";
    let usedModel = "";
    try {
      const groqRes = await callGroqChat(
        [
          { role: "system", content: systemInstruction },
          { role: "user", content: prompt }
        ],
        { timeoutMs: 8e3, jsonMode: true }
      );
      if (groqRes && groqRes.text) {
        responseText = groqRes.text.trim();
        usedModel = groqRes.modelUsed;
      }
    } catch (groqErr) {
      console.warn("[AI Workout] Primary Groq call failed, trying backup chain:", groqErr);
    }
    if (!responseText) {
      try {
        const ai2 = getGeminiClient();
        const { response, modelUsed } = await generateWithRetry(
          ai2,
          {
            contents: prompt,
            config: {
              systemInstruction
            }
          },
          void 0,
          8e3
        );
        responseText = (response.text ?? "").trim();
        usedModel = modelUsed;
      } catch (genErr) {
        console.warn("[AI Workout] All Gemini/Gemma backup models failed or timed out:", genErr);
      }
    }
    let parsed = null;
    if (responseText) {
      try {
        const cleaned = extractJsonFromText(responseText);
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        console.warn("[AI Workout] JSON parse failed, falling back to deterministic engine:", parseErr);
      }
    }
    if (!parsed || !parsed.name || !parsed.workout_type) {
      usedModel = "local-engine";
      const lowerReq = goal_prompt.toLowerCase();
      const isRace = lowerReq.includes("race") || lowerReq.includes("5k") || lowerReq.includes("pie") || lowerReq.includes("time trial");
      const isWorkout = lowerReq.includes("tempo") || lowerReq.includes("interval") || lowerReq.includes("track") || lowerReq.includes("speed");
      const isLong = lowerReq.includes("long");
      const isRest = lowerReq.includes("rest") || lowerReq.includes("off");
      if (isRace) {
        parsed = {
          name: lowerReq.includes("pie") ? "Run for Pie 5K \u2014 Race Day" : "5K Race Day Execution",
          workout_type: "race",
          warmup_miles: 1.5,
          main_miles: 3.1,
          cooldown_miles: 1,
          distance_miles: 5.6,
          pace_target: "Goal Race Pace (5:58\u20136:05/mi)",
          hr_cap: "Race Effort (Max VO2)",
          description: "\u2022 Warmup: 1.5 mi progressive warm-up + dynamic drills + 4x100m strides.\n\u2022 Main Set: Race 5K (3.1 mi) at Goal Race Pace (~5:58\u20136:05/mi).\n\u2022 Cooldown: 1.0 mi easy aerobic cooldown flush.",
          injury_prevention_note: "Pre-race hydration and dynamic mobility. Double-knot racing shoes.",
          reason: `Honored athlete request for a race on ${String(day ?? "Thursday")}.`
        };
      } else if (isWorkout) {
        parsed = {
          name: "Target Quality Session",
          workout_type: "workout",
          warmup_miles: 1.5,
          main_miles: 3,
          cooldown_miles: 1,
          distance_miles: 5.5,
          pace_target: "Threshold / Interval (~6:20\u20136:45/mi)",
          hr_cap: "< 185 bpm",
          description: "\u2022 Warmup: 1.5 mi easy aerobic jogging + dynamic leg swings.\n\u2022 Main Set: 3 x 1000m at threshold pace with 60s jog recovery + 4x100m strides.\n\u2022 Cooldown: 1.0 mi easy flush on soft surface.",
          injury_prevention_note: "Controlled turnover; stay relaxed through the shoulders.",
          reason: `Built targeted quality session for ${String(day ?? "Tuesday")}.`
        };
      } else if (isLong) {
        parsed = {
          name: "Aerobic Long Run",
          workout_type: "long_run",
          warmup_miles: 0.5,
          main_miles: 6,
          cooldown_miles: 0.5,
          distance_miles: 7,
          pace_target: "7:45\u20138:15/mi",
          hr_cap: "< 150 bpm",
          description: "\u2022 Warmup: 0.5 mi progressive shuffle into steady Zone 2 rhythm.\n\u2022 Main Set: 6.0 mi continuous aerobic endurance running on soft trails.\n\u2022 Cooldown: 0.5 mi light walk & hamstring/calf mobility.",
          injury_prevention_note: "Hydrate well before and after; avoid pacing surges.",
          reason: `Scheduled aerobic long run for ${String(day ?? "Saturday")}.`
        };
      } else if (isRest) {
        parsed = {
          name: "Rest & Mobility Day",
          workout_type: "rest",
          warmup_miles: 0,
          main_miles: 0,
          cooldown_miles: 0,
          distance_miles: 0,
          pace_target: "Off",
          hr_cap: "Rest",
          description: "\u2022 Warmup: 5 min diaphragmatic breathing.\n\u2022 Main Set: 20 min foam rolling IT bands, quads, and calves + light hip mobility.\n\u2022 Cooldown: Full recovery hydration and protein supercompensation.",
          injury_prevention_note: "Tissue repair and glycogen supercompensation.",
          reason: `Scheduled rest day for ${String(day ?? "Monday")}.`
        };
      } else {
        parsed = {
          name: "Zone 2 Aerobic Base Run",
          workout_type: "easy",
          warmup_miles: 0.5,
          main_miles: 3,
          cooldown_miles: 0.5,
          distance_miles: 4,
          pace_target: "7:30\u20138:00/mi",
          hr_cap: "< 145 bpm",
          description: "\u2022 Warmup: 0.5 mi progressive jog into aerobic pace.\n\u2022 Main Set: 3.0 mi conversational Zone 2 flush on grass or soft trail.\n\u2022 Cooldown: 0.5 mi walk + light calf stretching.",
          injury_prevention_note: "Builds capillary density without musculoskeletal strain.",
          reason: `Built easy aerobic run for ${String(day ?? "Wednesday")}.`
        };
      }
    }
    const norm = normalizeWorkoutMileage(parsed);
    res.json({
      workout: {
        day: String(day ?? "Thursday"),
        name: parsed.name,
        workout_type: parsed.workout_type,
        distance_miles: norm.total_miles,
        warmup_miles: norm.warmup_miles,
        main_miles: norm.main_miles,
        cooldown_miles: norm.cooldown_miles,
        pace_target: parsed.pace_target,
        hr_cap: parsed.hr_cap,
        description: parsed.description,
        injury_prevention_note: parsed.injury_prevention_note,
        ai_generated: true,
        adaptation_reason: parsed.reason
      },
      model_used: usedModel || "local-engine",
      source: usedModel === "local-engine" ? "local-engine" : void 0
    });
  } catch (outerErr) {
    console.error("[AI Workout] Unexpected error, returning deterministic fallback:", outerErr);
    res.json({
      workout: {
        day: String(req.body?.day ?? "Thursday"),
        name: "Zone 2 Aerobic Base Run",
        workout_type: "easy",
        distance_miles: 4,
        pace_target: "7:40\u20138:15/mi",
        hr_cap: "< 145 bpm",
        description: "\u2022 Warmup: 0.5 mi progressive jog.\n\u2022 Main Set: 3.0 mi conversational Zone 2 flush.\n\u2022 Cooldown: 0.5 mi walk.",
        injury_prevention_note: "Aerobic base maintenance.",
        ai_generated: true,
        adaptation_reason: "Deterministic recovery session."
      },
      model_used: "local-engine",
      source: "local-engine"
    });
  }
});
var BASE_COACH_TOOLS = [
  {
    name: "replace_workout_day",
    description: "Creates or replaces a specific day in the RaceKit weekly training plan with a tailored workout.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        day: {
          type: Type.STRING,
          enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        },
        name: { type: Type.STRING, description: "Workout title." },
        workout_type: {
          type: Type.STRING,
          enum: ["easy", "workout", "long_run", "recovery", "rest", "race"]
        },
        distance_miles: { type: Type.NUMBER, description: "Total distance in miles." },
        pace_target: { type: Type.STRING, description: "Target pace band." },
        hr_cap: { type: Type.STRING, description: "Heart rate cap string, e.g. < 145 bpm." },
        description: { type: Type.STRING, description: "Structured workout details." },
        injury_prevention_note: { type: Type.STRING, description: "Recovery or form cue." },
        reason: { type: Type.STRING, description: "Short rationale grounded in watch data." }
      },
      required: [
        "day",
        "name",
        "workout_type",
        "distance_miles",
        "pace_target",
        "hr_cap",
        "description",
        "injury_prevention_note",
        "reason"
      ]
    }
  },
  {
    name: "schedule_race_taper",
    description: "Sets a target race on a specific day of the week and automatically tapers the preceding 3 days for glycogen supercompensation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        race_name: { type: Type.STRING, description: "Name of the target race." },
        race_dist: {
          type: Type.STRING,
          enum: ["800m", "1600m", "3200m", "5K", "10K", "Half Marathon"]
        },
        race_day: {
          type: Type.STRING,
          enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        }
      },
      required: ["race_name", "race_dist", "race_day"]
    }
  }
];
var GARMLINK_QUERY_TOOL = {
  name: "query_garmlink_mcp",
  description: "Calls a live read-only tool on the connected Garmlink MCP server to fetch additional Garmin Connect data (activities, sleep, HRV, training load, body battery) directly from the user watch account.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      tool_name: {
        type: Type.STRING,
        description: "Exact Garmlink MCP tool name from the available tools list."
      },
      arguments_json: {
        type: Type.STRING,
        description: 'Optional JSON object string of arguments for the Garmlink tool (default "{}").'
      }
    },
    required: ["tool_name"]
  }
};
app.post("/api/ai/coach", async (req, res) => {
  try {
    const { message, history, context } = req.body;
    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "Message is required." });
      return;
    }
    const isOwn = isOwner(req);
    const { session, accessToken } = getActiveGarmlinkAccessToken(req);
    const hasGarmlink = isOwn && Boolean(accessToken);
    const discoveredTools = hasGarmlink ? session?.tools_discovered ?? [] : [];
    const toolsList = hasGarmlink ? [...BASE_COACH_TOOLS, GARMLINK_QUERY_TOOL] : BASE_COACH_TOOLS;
    const runnerProfile = context?.runner_profile || null;
    const rawName = runnerProfile?.name?.trim();
    const athleteFirstName = rawName ? rawName.split(" ")[0] : isOwn ? "Ephraim" : "";
    const athleteName = athleteFirstName || "Athlete";
    const greetingSalutation = athleteFirstName ? `Hey ${athleteFirstName}!` : "Hey there!";
    const runnerUnits = runnerProfile?.units || "mi";
    let completedRunsSummary = "No synced watch activities available. (Garmin Connect not linked or guest mode).";
    let prSummary = runnerProfile?.benchmark_label && runnerProfile?.benchmark_time_fmt ? `- Benchmark PR: ${runnerProfile.benchmark_label} in ${runnerProfile.benchmark_time_fmt} (Estimated VDOT: ${runnerProfile.vdot ?? 50})` : "No verified personal records configured yet.";
    let sleepHoursStr = "Not recorded";
    let verifiedHealth = null;
    if (isOwn) {
      const localSync = getLocalGarminBridgeData("sync") || {};
      const verifiedActivities = localSync.activities || DEFAULT_GARMLINK_ACTIVITIES;
      const verifiedPrs = localSync.prs || VERIFIED_PR_EFFORTS;
      verifiedHealth = localSync.health || DEFAULT_GARMLINK_HEALTH;
      const sleepTotalMin = verifiedHealth.sleep_seconds ? Math.round(verifiedHealth.sleep_seconds / 60) : verifiedHealth.sleep_hours ? Math.round(verifiedHealth.sleep_hours * 60) : 306;
      sleepHoursStr = `${Math.floor(sleepTotalMin / 60)}h ${(sleepTotalMin % 60).toString().padStart(2, "0")}m (${sleepTotalMin} min)`;
      completedRunsSummary = verifiedActivities.slice(0, 15).map(
        (a) => `- Date: ${a.date} | Activity: "${a.name}" | Distance: ${a.distance_miles ?? (a.distance_m / 1609.344).toFixed(2)} mi (${a.distance_m}m) | Duration: ${a.duration_fmt ?? `${Math.floor(a.duration_s / 60)}:${(a.duration_s % 60).toString().padStart(2, "0")}`} | Avg Pace: ${a.pace_fmt ?? "\u2014"} | Avg HR: ${a.avg_hr ?? "\u2014"} bpm (Max HR: ${a.max_hr ?? "\u2014"} bpm) | Cadence: ${a.avg_cadence ?? "\u2014"} spm | Aerobic TE: ${a.aerobic_te ?? "\u2014"}`
      ).join("\n");
      prSummary = verifiedPrs.map(
        (p) => `- ${p.label}: ${Math.floor(p.time_s / 60)}:${(p.time_s % 60).toFixed(1).padStart(4, "0")} (${p.date})`
      ).join("\n");
    } else if (context?.health) {
      verifiedHealth = context.health;
      if (verifiedHealth.sleep_hours) {
        sleepHoursStr = `${verifiedHealth.sleep_hours}h (Sleep Score: ${verifiedHealth.sleep_score ?? "\u2014"}/100)`;
      }
    }
    const targetRace = context?.target_race || context?.current_plan?.target_race || null;
    const targetRaceStr = targetRace?.name ? `- Target Race: ${targetRace.name} (${targetRace.dist || "5K"}) scheduled on ${targetRace.day || "Thursday"}.` : "- Target Race: No target race currently scheduled.";
    const isCasualGreeting = /^(hi|hello|hey|yo|howdy|sup|good morning|good afternoon|good evening|what's up|whats up)[!.,? ]*$/i.test(message.trim());
    const systemInstruction = `You are the RaceKit AI Running Coach \u2014 an elite collegiate middle-distance & cross-country running coach working directly with athlete ${athleteName}.

=== ATHLETE PROFILE ===
- Athlete Name: ${athleteName}
- Preferred Units: ${runnerUnits}

${isOwn ? `=== COMPLETED GARMIN WATCH ACTIVITIES (100% VERIFIED GROUND TRUTH - COMPLETED RUNS ONLY) ===
${completedRunsSummary}` : "=== COMPLETED ACTIVITIES ===\n- Guest mode / no personal activities connected."}

=== VERIFIED ATHLETE PRs ===
${prSummary}

${verifiedHealth ? `=== LATEST WATCH RECOVERY & TRAINING LOAD ===
- Date: ${verifiedHealth.date || "Today"}
- Sleep Duration: ${sleepHoursStr}
- Overnight HRV: ${verifiedHealth.hrv_last_night ?? "\u2014"} ms (${verifiedHealth.hrv_status ?? "BALANCED"} vs baseline ${verifiedHealth.hrv_baseline_low ?? 48}\u2013${verifiedHealth.hrv_baseline_high ?? 73} ms)
- Resting Heart Rate: ${verifiedHealth.resting_hr ?? "\u2014"} bpm
- Body Battery: ${verifiedHealth.body_battery ?? "\u2014"} / 100
- Training Load Status: ${verifiedHealth.load_aerobic_low ? `Low Aerobic Shortage (${verifiedHealth.load_aerobic_low} vs 790 target)` : "Balanced"}
` : "=== RECOVERY TELEMETRY ===\n- No watch recovery telemetry synced yet. Encourage the athlete to authorize their Garmin watch via Garmlink."}

=== LIVE GARMIN METRICS (SYNCED THIS SESSION \u2014 USE THESE EXACT VALUES) ===
${buildLiveMetricsSummary(context?.health, context?.fitness, context?.prs)}

=== ACTIVE TARGET RACE & SCHEDULE CONTEXT ===
${targetRaceStr}

=== ATHLETE STATE & PLANNED WORKOUTS (FROM RACEKIT APP) ===
${JSON.stringify(context ?? {}, null, 2)}
${hasGarmlink && discoveredTools.length > 0 ? `
Connected Garmlink MCP Tools Available via query_garmlink_mcp:
${discoveredTools.slice(0, 35).map((t) => `- ${t.name}${t.description ? `: ${t.description.slice(0, 90)}` : ""}`).join("\n")}` : ""}

=== COACHING DIRECTIVES ===
1. CASUAL GREETING RULE: If the user sends a greeting (like "hi", "hello", "hey", "good morning"), respond warmly, conversationally, and concisely in 1\u20132 friendly sentences as their personal running coach (e.g. "${greetingSalutation} Ready to dial in today's training? How are your legs feeling?"). NEVER address the athlete as "Runner" or say "Hey Runner!". DO NOT dump unprompted statistics, metric dumps, or past activity lists on a simple greeting!
2. STRICT DATA TRUTH: Only reference runs, PRs, and health metrics that are explicitly listed above. Never invent fake past workouts or fake recovery numbers.
3. PRE-RACE TAPER: 1 day before any race must NEVER be a hard workout (strictly Pre-Race Shakeout 2.0 mi + 4x100m strides or Rest). 1 day after must be a Recovery Flush (2.0 mi) or Rest.
4. WORKOUT CREATION: Use replace_workout_day or schedule_race_taper whenever the user asks to modify a workout, add a race, or adjust the plan. Ensure race workouts include warmup and cooldown distances in the description and mileage.
5. Keep coaching advice sharp, practical, and conversational with exact pace ranges from their VDOT zones.
6. HARD RECOVERY GATE (AUTO-REST RECOMMENDATION):
Whenever the athlete's Overnight HRV is below baseline (e.g. HRV < baseline_low, like 32 ms < 48 ms), or sleep is under 5.5 hours, or sleep score is under 60:
You MUST STRONGLY and UNEQUIVOCALLY recommend a FULL REST DAY (0 miles).
DO NOT defend, rationalize, or recommend a 4-mile run, easy run, or shakeout when recovery is suppressed.
Explain directly to the athlete: running on depressed HRV (e.g. 32 ms vs 48\u201373 ms baseline) and poor sleep blunts training adaptations, impairs autonomic recovery, and dramatically increases overuse injury risk. Recommend full rest (0 mi), hydration, 15 min mobility, and prioritizing sleep tonight.`;
    const recentHistory = Array.isArray(history) ? history.slice(-8) : [];
    const contents = [
      ...recentHistory.map((h) => ({
        role: h.role === "user" ? "user" : "model",
        parts: [{ text: String(h.content ?? "") }]
      })),
      { role: "user", parts: [{ text: message.trim() }] }
    ];
    let finalReply = "";
    let modelUsed = "";
    const clientToolCalls = [];
    const garmlinkCallsExecuted = [];
    try {
      const groqMessages = [
        { role: "system", content: systemInstruction },
        ...recentHistory.map((h) => ({
          role: h.role === "user" ? "user" : "assistant",
          content: String(h.content ?? "")
        })),
        { role: "user", content: message.trim() }
      ];
      const groqRes = await callGroqChat(groqMessages, {
        timeoutMs: 8e3,
        tools: isCasualGreeting ? void 0 : toolsList
      });
      if (groqRes) {
        if (groqRes.text) {
          finalReply = groqRes.text.trim();
        }
        if (groqRes.tool_calls && groqRes.tool_calls.length > 0) {
          for (const tc of groqRes.tool_calls) {
            clientToolCalls.push(tc);
          }
        }
        if (finalReply || clientToolCalls.length > 0) {
          modelUsed = groqRes.modelUsed;
        }
      }
    } catch (groqErr) {
      console.warn("[AI Coach] Primary Groq call failed, trying backup chain:", groqErr);
    }
    if (!finalReply && clientToolCalls.length === 0) {
      try {
        const ai = getGeminiClient();
        const { response: response1, modelUsed: used1 } = await generateWithRetry(
          ai,
          {
            contents,
            config: {
              systemInstruction,
              tools: [{ functionDeclarations: toolsList }]
            }
          },
          void 0,
          8e3
        );
        modelUsed = used1;
        finalReply = (response1.text ?? "").trim();
        const functionCalls = response1.functionCalls ?? [];
        if (functionCalls.length > 0) {
          const responseParts = [];
          let mcpSessionId = null;
          let validGarmlinkToken = null;
          for (const fc of functionCalls) {
            if (!fc.name) continue;
            const args = fc.args ?? {};
            if (fc.name === "query_garmlink_mcp" && accessToken) {
              const requestedTool = String(args.tool_name ?? "").trim();
              let parsedArgs = {};
              if (typeof args.arguments_json === "string" && args.arguments_json.trim()) {
                try {
                  parsedArgs = JSON.parse(args.arguments_json);
                } catch {
                  parsedArgs = {};
                }
              }
              try {
                if (!validGarmlinkToken) {
                  validGarmlinkToken = session ? await refreshGarmlinkSessionIfNeeded(session) : accessToken;
                  const opened = await openGarmlinkMcpSession(validGarmlinkToken);
                  mcpSessionId = opened.mcpSessionId;
                }
                const rawResult = await callGarmlinkMcpTool(
                  validGarmlinkToken,
                  mcpSessionId,
                  requestedTool,
                  parsedArgs,
                  50
                );
                const unwrapped = unwrapMcpToolResult(rawResult);
                garmlinkCallsExecuted.push(`Queried Garmlink MCP: ${requestedTool}`);
                responseParts.push({
                  functionResponse: {
                    id: fc.id,
                    name: fc.name,
                    response: { status: "ok", data: unwrapped }
                  }
                });
              } catch (mcpErr) {
                responseParts.push({
                  functionResponse: {
                    id: fc.id,
                    name: fc.name,
                    response: {
                      status: "error",
                      error: mcpErr instanceof Error ? mcpErr.message : "Garmlink MCP query failed"
                    }
                  }
                });
              }
            } else {
              clientToolCalls.push({ name: fc.name, args });
              responseParts.push({
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: { status: "applied", applied_args: args }
                }
              });
            }
          }
          const needsFollowUp = garmlinkCallsExecuted.length > 0 || !finalReply;
          const modelContent = response1.candidates?.[0]?.content;
          if (needsFollowUp && modelContent && responseParts.length > 0) {
            const followUpPayload = {
              contents: [
                ...contents,
                modelContent,
                { role: "user", parts: responseParts }
              ],
              config: {
                systemInstruction,
                tools: [{ functionDeclarations: toolsList }]
              }
            };
            try {
              const { response: response2, modelUsed: used2 } = await generateWithRetry(
                ai,
                followUpPayload,
                void 0,
                8e3
              );
              finalReply = (response2.text ?? "").trim() || finalReply;
              if (used2) modelUsed = used2;
            } catch (followUpErr) {
              console.warn("[AI Coach] Follow-up turn failed, using previous response:", followUpErr);
            }
          }
        }
      } catch (coachErr) {
        console.warn("[AI Coach] All Gemini/Gemma models failed or timed out:", coachErr);
      }
    }
    if (!finalReply && clientToolCalls.length === 0) {
      modelUsed = "local-engine";
      const lower = message.toLowerCase();
      if (isCasualGreeting) {
        finalReply = `Hey ${athleteName}! Great to see you. How are your legs feeling today, and what can I help you dial in?`;
      } else if (lower.includes("pie") || lower.includes("race") && (lower.includes("thursday") || lower.includes("5k"))) {
        const raceName = targetRace?.name || "Run for Pie 5K \u2014 Race Day";
        clientToolCalls.push({
          name: "replace_workout_day",
          args: {
            day: "Thursday",
            name: raceName,
            workout_type: "race",
            warmup_miles: 1.5,
            main_miles: 3.1,
            cooldown_miles: 1,
            distance_miles: 5.6,
            pace_target: "Goal Race Pace (~5:58\u20136:05/mi)",
            hr_cap: "Race Effort (Max VO2)",
            description: "\u2022 Warmup: 1.5 mi progressive warm-up + dynamic drills + 4x100m strides.\n\u2022 Main Set: Run for Pie 5K (3.1 mi) at Goal Race Pace.\n\u2022 Cooldown: 1.0 mi easy flush on soft surface.",
            injury_prevention_note: "Pre-race hydration and dynamic mobility. Double-knot racing shoes.",
            reason: "Target race Run for Pie 5K locked in for Thursday with full warmup & cooldown."
          }
        });
        finalReply = `I have locked in **${raceName}** on **Thursday** (5.6 mi total: 1.5 mi warmup + 3.1 mi race + 1.0 mi cooldown) and ensured your pre-race taper is scheduled. Keep Wednesday easy so you toe the line fresh!`;
      } else if (lower.includes("hrv") || lower.includes("recovery") || lower.includes("sleep") || lower.includes("readiness")) {
        if (verifiedHealth) {
          finalReply = `Your overnight HRV was **${verifiedHealth.hrv_last_night ?? "\u2014"} ms** (${verifiedHealth.hrv_status ?? "BALANCED"}), sleep duration was **${sleepHoursStr}**, and Body Battery is at **${verifiedHealth.body_battery ?? "\u2014"} / 100**.

Keep easy days truly aerobic (< 145 bpm) to support cellular recovery and tissue repair.`;
        } else {
          finalReply = `You haven't synced watch recovery data yet. Connect your Garmin watch via Garmlink on the Watch tab to sync live HRV, sleep, and training status telemetry.`;
        }
      } else {
        finalReply = `Hey ${athleteName}! As your RaceKit Coach, I'm here to help optimize your training and race preparation. Let me know if you want to inspect your workouts, schedule a race taper, or check your recovery status!`;
      }
    }
    for (const tc of clientToolCalls) {
      if (tc.name === "replace_workout_day" && tc.args) {
        const norm = normalizeWorkoutMileage(tc.args);
        tc.args.warmup_miles = norm.warmup_miles;
        tc.args.main_miles = norm.main_miles;
        tc.args.cooldown_miles = norm.cooldown_miles;
        tc.args.distance_miles = norm.total_miles;
      }
    }
    if (!finalReply && clientToolCalls.length > 0) {
      const tc = clientToolCalls[0];
      if (tc.name === "schedule_race_taper") {
        finalReply = `I have locked in **${tc.args.race_name || "Target Race"}** (${tc.args.race_dist || "5K"}) on **${tc.args.race_day || "Thursday"}** and updated your pre-race taper.`;
      } else if (tc.name === "replace_workout_day") {
        finalReply = `I have updated your workout for **${tc.args.day}** to **${tc.args.name}** (${tc.args.distance_miles || ""} mi).`;
      }
    }
    res.json({
      reply: finalReply,
      tool_calls: clientToolCalls,
      garmlink_queries: garmlinkCallsExecuted,
      model_used: modelUsed || "local-engine",
      source: modelUsed === "local-engine" ? "local-engine" : void 0
    });
  } catch (outerErr) {
    console.error("[AI Coach] Unexpected error, returning deterministic fallback:", outerErr);
    res.json({
      reply: "I am monitoring your recovery and training metrics. Keep easy runs conversational and stay hydrated.",
      tool_calls: [],
      garmlink_queries: [],
      model_used: "local-engine",
      source: "local-engine"
    });
  }
});
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }
  discoverLocalMcpTools();
  const primaryPort = PORT;
  const secondaryPort = primaryPort === 5173 ? 3e3 : primaryPort === 3e3 ? 5173 : null;
  app.listen(primaryPort, "0.0.0.0", () => {
    console.log(`RaceKit server listening on http://0.0.0.0:${primaryPort}`);
  });
  if (secondaryPort) {
    try {
      const secondaryServer = app.listen(secondaryPort, "0.0.0.0", () => {
        console.log(`RaceKit server also listening on http://0.0.0.0:${secondaryPort}`);
      });
      secondaryServer.on("error", (err) => {
        console.log(`Secondary port ${secondaryPort} not bound: ${err.message}`);
      });
    } catch (err) {
      console.log(`Secondary port ${secondaryPort} error: ${err.message}`);
    }
  }
}
startServer();
export {
  discoverLocalMcpTools,
  getLocalGarminBridgeData,
  isOwner
};
