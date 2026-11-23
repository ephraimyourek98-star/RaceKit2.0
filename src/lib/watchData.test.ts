import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGarminWorkoutJson,
  buildGarminWorkoutTcx,
  computeVolumeFromActivities,
  degreesToCompass,
  describeWmoWeather,
  normalizeGarmlinkActivities,
  normalizeGarmlinkHealth,
  normalizeGarmlinkPrs,
  parseWatchActivityFile,
} from './watchData';

test('normalizeGarmlinkActivities parses MCP text JSON tool payloads cleanly', () => {
  const mcpResult = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          activities: [
            {
              activityId: 987654,
              activityName: 'Newark Easy Base Run',
              activityType: { typeKey: 'running' },
              startTimeLocal: '2026-11-21 08:15:00',
              distance: 8046.7,
              duration: 2410,
              averageHR: 141,
              maxHR: 150,
              elevationGain: 32,
              averageRunningCadenceInStepsPerMinute: 176,
            },
          ],
        }),
      },
    ],
  };

  const acts = normalizeGarmlinkActivities(mcpResult);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].name, 'Newark Easy Base Run');
  assert.equal(acts[0].date, '2026-11-21');
  assert.equal(acts[0].avg_hr, 141);
  assert.equal(acts[0].elevation_gain_ft, 105);
  assert.equal(acts[0].source, 'garmlink_mcp');
});

test('normalizeGarmlinkHealth extracts real HRV, sleep, Body Battery, VO2max, and load from MCP payloads', () => {
  const health = normalizeGarmlinkHealth({
    hrv: {
      content: [{ type: 'text', text: JSON.stringify({ lastNightAvg: 61, weeklyAvg: 57, status: 'BALANCED', balancedLow: 48, balancedUpper: 74 }) }],
    },
    sleep: {
      content: [{ type: 'text', text: JSON.stringify({ sleepScore: 84, sleepTimeSeconds: 28080 }) }],
    },
    daily: {
      content: [{ type: 'text', text: JSON.stringify({ bodyBatteryMostRecentValue: 79, restingHeartRate: 53, vo2MaxPreciseValue: 54.6 }) }],
    },
  });

  assert.ok(health);
  assert.equal(health.hrv_last_night, 61);
  assert.equal(health.sleep_score, 84);
  assert.equal(health.sleep_hours, 7.8);
  assert.equal(health.body_battery, 79);
  assert.equal(health.resting_hr, 53);
  assert.equal(health.vo2max, 54.6);
  assert.equal(health.source, 'garmlink_mcp');
});

test('normalizeGarmlinkHealth returns null when no real watch metrics exist', () => {
  assert.equal(normalizeGarmlinkHealth({}), null);
  assert.equal(normalizeGarmlinkHealth({ empty: { content: [{ type: 'text', text: '{}' }] } }), null);
});

test('normalizeGarmlinkPrs maps Garmin PR typeIds into RaceKit efforts', () => {
  const prs = normalizeGarmlinkPrs({
    content: [
      {
        type: 'text',
        text: JSON.stringify([
          { typeId: 2, value: 318.88, prStartTimeGmtFormatted: '2026-10-28T10:00:00Z' },
          { typeId: 3, value: 1144.75, prStartTimeGmtFormatted: '2026-11-09T09:00:00Z' },
        ]),
      },
    ],
  });
  assert.equal(prs.length, 2);
  assert.equal(prs[0].label, 'Mile');
  assert.equal(prs[1].label, '5K');
  assert.equal(prs[1].time_s, 1144.75);
});

test('computeVolumeFromActivities calculates real longest run and weekly mileage', () => {
  const today = new Date().toISOString().slice(0, 10);
  const vol = computeVolumeFromActivities([
    {
      id: 'a1',
      name: 'Long Run',
      date: today,
      activity_type: 'running',
      distance_m: 16093.44,
      duration_s: 4800,
      avg_hr: 150,
      max_hr: 168,
      elevation_gain_ft: 200,
      avg_cadence: 174,
      source: 'garmlink_mcp',
      source_label: 'Garmlink MCP',
    },
    {
      id: 'a2',
      name: 'Easy Run',
      date: today,
      activity_type: 'running',
      distance_m: 8046.72,
      duration_s: 2400,
      avg_hr: 140,
      max_hr: 148,
      elevation_gain_ft: 50,
      avg_cadence: 175,
      source: 'garmlink_mcp',
      source_label: 'Garmlink MCP',
    },
  ]);
  assert.ok(vol);
  assert.equal(vol.longest_run_miles, 10);
  assert.equal(vol.avg_weekly_miles, 15);
});

test('parseWatchActivityFile parses GPX trackpoints with HR & elevation', () => {
  const sampleGpx = `<?xml version="1.0"?>
  <gpx><trk><name>Glasgow Park Loop</name><trkseg>
    <trkpt lat="39.6079" lon="-75.7369"><ele>20</ele><time>2026-11-22T12:00:00Z</time><extensions><gpxtpx:hr>140</gpxtpx:hr></extensions></trkpt>
    <trkpt lat="39.6124" lon="-75.7369"><ele>26</ele><time>2026-11-22T12:02:30Z</time><extensions><gpxtpx:hr>146</gpxtpx:hr></extensions></trkpt>
  </trkseg></trk></gpx>`;
  const act = parseWatchActivityFile(sampleGpx, 'glasgow.gpx');
  assert.equal(act.name, 'Glasgow Park Loop');
  assert.ok(act.distance_m > 450 && act.distance_m < 550);
  assert.equal(act.duration_s, 150);
  assert.equal(act.avg_hr, 143);
});

test('buildGarminWorkoutJson and buildGarminWorkoutTcx embed HR guardrails', () => {
  const workout = {
    day: 'Tuesday',
    name: 'Zone 2 Aerobic Base',
    workout_type: 'easy' as const,
    distance_miles: 4.5,
    pace_target: '8:00/mi',
    hr_cap: 'Strict < 144 bpm',
    description: 'Easy relaxed base run.',
    injury_prevention_note: 'Stay tall and light.',
  };
  const json = JSON.parse(buildGarminWorkoutJson(workout));
  assert.equal(json.workoutSegments[0].workoutSteps[0].targetValueTwo, 144);
  const tcx = buildGarminWorkoutTcx(workout);
  assert.ok(tcx.includes('<Value>144</Value>'));
  assert.ok(tcx.includes('RaceKit - Zone 2 Aerobic Base'));
});

test('weather helpers map WMO codes and compass headings accurately', () => {
  assert.equal(describeWmoWeather(0), 'Clear Sky');
  assert.equal(describeWmoWeather(61), 'Rain');
  assert.equal(degreesToCompass(0), 'N');
  assert.equal(degreesToCompass(292), 'WNW');
  assert.equal(degreesToCompass(null), 'Var');
});
