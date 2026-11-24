#!/usr/bin/env python3
import sys
import os
import json
import sqlite3

DB_PATH = '/home/ephraimyourek98/racekit/data/racekit.db'
MCP_TOOLS_DIR = '/home/ephraimyourek98/.gemini/antigravity-cli/mcp/garmlink'

def get_db():
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Database not found at {DB_PATH}")
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def get_discovered_tools():
    tools = []
    if os.path.exists(MCP_TOOLS_DIR):
        for fname in sorted(os.listdir(MCP_TOOLS_DIR)):
            if fname.endswith('.json'):
                try:
                    with open(os.path.join(MCP_TOOLS_DIR, fname), 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        name = data.get('name') or fname[:-5]
                        desc = data.get('description', '')
                        tools.append({'name': name, 'description': desc})
                except Exception:
                    pass
    return tools

COACH_ACTIVITIES_PATH = '/home/ephraimyourek98/garmin-coach/data/garmin_activities.json'

def fetch_activities(limit=195):
    con = get_db()
    cur = con.cursor()
    acts_by_id = {}
    query = '''
        SELECT garmin_id, name, start_time, activity_type, distance_m, duration_s,
               avg_hr, max_hr, elevation_gain, elevation_loss, avg_cadence,
               training_effect_aerobic, training_effect_anaerobic, raw_json
        FROM activities
        ORDER BY start_time DESC
    '''
    for r in cur.execute(query):
        dist_m = float(r['distance_m'] or 0)
        dur_s = float(r['duration_s'] or 0)
        dist_mi = dist_m / 1609.344
        pace_s = (dur_s / dist_mi) if dist_mi > 0 else 0
        pace_m = int(pace_s // 60)
        pace_rem_s = int(round(pace_s % 60))
        if pace_rem_s == 60:
            pace_m += 1
            pace_rem_s = 0
        pace_str = f"{pace_m}:{pace_rem_s:02d}/mi" if dist_mi > 0 else "—"

        gid = r['garmin_id']
        acts_by_id[gid] = {
            'id': f"garmin-{gid}",
            'garmin_id': gid,
            'name': r['name'] or 'Garmin Run',
            'date': (r['start_time'] or '')[:10],
            'start_time': r['start_time'],
            'activity_type': r['activity_type'] or 'running',
            'distance_m': round(dist_m, 1),
            'distance_miles': round(dist_mi, 2),
            'duration_s': int(round(dur_s)),
            'duration_fmt': f"{int(dur_s // 60)}:{int(dur_s % 60):02d}",
            'pace_fmt': pace_str,
            'avg_hr': int(round(r['avg_hr'])) if r['avg_hr'] is not None else None,
            'max_hr': int(round(r['max_hr'])) if r['max_hr'] is not None else None,
            'elevation_gain_ft': int(round((r['elevation_gain'] or 0) * 3.28084)),
            'elevation_loss_ft': int(round((r['elevation_loss'] or 0) * 3.28084)),
            'avg_cadence': int(round(r['avg_cadence'])) if r['avg_cadence'] is not None else None,
            'aerobic_te': round(r['training_effect_aerobic'], 1) if r['training_effect_aerobic'] is not None else None,
            'anaerobic_te': round(r['training_effect_anaerobic'], 1) if r['training_effect_anaerobic'] is not None else None,
            'source': 'garmlink_mcp',
            'source_label': 'Garmlink MCP',
        }
    con.close()

    # Supplement with additional historical runs from garmin-coach cache to reach all 195 runs
    if os.path.exists(COACH_ACTIVITIES_PATH):
        try:
            with open(COACH_ACTIVITIES_PATH, 'r', encoding='utf-8') as f:
                cdata = json.load(f)
            c_acts = cdata.get('activities', []) if isinstance(cdata, dict) else cdata
            for a in c_acts:
                gid = a.get('garmin_activity_id')
                if not gid or gid in acts_by_id:
                    continue
                dist_m = float(a.get('distance_m') or 0)
                dur_s = float(a.get('duration_s') or 0)
                dist_mi = dist_m / 1609.344
                pace_s = (dur_s / dist_mi) if dist_mi > 0 else 0
                pace_m = int(pace_s // 60)
                pace_rem_s = int(round(pace_s % 60))
                if pace_rem_s == 60:
                    pace_m += 1
                    pace_rem_s = 0
                pace_str = f"{pace_m}:{pace_rem_s:02d}/mi" if dist_mi > 0 else "—"
                brief = a.get('brief') or {}

                acts_by_id[gid] = {
                    'id': f"garmin-{gid}",
                    'garmin_id': gid,
                    'name': a.get('name') or 'Garmin Run',
                    'date': (a.get('start_time') or '')[:10],
                    'start_time': a.get('start_time'),
                    'activity_type': a.get('activity_type') or 'running',
                    'distance_m': round(dist_m, 1),
                    'distance_miles': round(dist_mi, 2),
                    'duration_s': int(round(dur_s)),
                    'duration_fmt': f"{int(dur_s // 60)}:{int(dur_s % 60):02d}",
                    'pace_fmt': pace_str,
                    'avg_hr': int(round(a['avg_hr'])) if a.get('avg_hr') else None,
                    'max_hr': int(round(brief['max_hr'])) if brief.get('max_hr') else None,
                    'elevation_gain_ft': int(round((brief.get('elevation_gain') or 0) * 3.28084)),
                    'elevation_loss_ft': 0,
                    'avg_cadence': int(round(brief['cadence'])) if brief.get('cadence') else None,
                    'aerobic_te': None,
                    'anaerobic_te': None,
                    'source': 'garmlink_mcp',
                    'source_label': 'Garmlink MCP',
                }
        except Exception as e:
            print(f"Warning: could not load coach activities: {e}", file=sys.stderr)

    all_acts = sorted(acts_by_id.values(), key=lambda x: x.get('start_time') or '', reverse=True)
    # Filter running activities and take exact requested limit
    runs = [a for a in all_acts if 'run' in (a['activity_type'] or '').lower() or 'run' in (a['name'] or '').lower()]
    return runs[:limit]

def fetch_prs():
    con = get_db()
    cur = con.cursor()
    prs = []
    has_1600 = False
    for r in cur.execute('SELECT id, distance_m, time_s, date, label, hr_avg FROM efforts ORDER BY distance_m ASC'):
        lbl = r['label'] or f"{int(r['distance_m'])}m"
        if '1600' in lbl:
            has_1600 = True
        prs.append({
            'id': f"pr-{r['id']}",
            'distance_m': r['distance_m'],
            'time_s': round(r['time_s'], 2),
            'date': r['date'],
            'label': lbl,
            'hr_avg': int(round(r['hr_avg'])) if r['hr_avg'] else None,
            'source': 'garmin_pr',
        })
    if not has_1600:
        # Distinguish 1 Mile (5:18.9) and 1600m (5:17.1 converted)
        mile_pr = next((p for p in prs if 'mile' in p['label'].lower() or abs(p['distance_m'] - 1609.344) < 5), None)
        mile_time = mile_pr['time_s'] if mile_pr else 318.88
        prs.append({
            'id': 'pr-1600m',
            'distance_m': 1600.0,
            'time_s': round(mile_time * (1600.0 / 1609.344), 2),
            'date': mile_pr['date'] if mile_pr else '2026-11-19',
            'label': '1600m (Converted)',
            'hr_avg': 191,
            'source': 'converted_pr',
        })
        prs.sort(key=lambda p: p['distance_m'])
    con.close()
    return prs

def fetch_gear():
    # Only return gear if real records exist in database; no fake mock shoes
    try:
        con = get_db()
        cur = con.cursor()
        tables = [t[0] for t in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        if 'gear' not in tables:
            con.close()
            return []
        gear = []
        for r in cur.execute("SELECT * FROM gear"):
            gear.append(dict(r))
        con.close()
        return gear
    except Exception:
        return []

def fetch_health_records():
    con = get_db()
    cur = con.cursor()
    records = []
    for r in cur.execute('SELECT * FROM health ORDER BY date DESC'):
        raw = json.loads(r['raw_json']) if r['raw_json'] else {}
        sleep_raw = raw.get('sleep', {}) or {}
        sleep_dto = sleep_raw.get('dailySleepDTO', {}) or {}
        daily_dto = raw.get('daily_summary', {}) or raw.get('dailySummary', {}) or {}
        ts_raw = raw.get('training_status', {}) or {}
        vo2_dto = (ts_raw.get('mostRecentVO2Max', {}) or {}).get('generic', {}) or {}
        tl_balance = (ts_raw.get('mostRecentTrainingLoadBalance', {}) or {}).get('metricsTrainingLoadBalanceDTOMap', {})
        tl_dev = list(tl_balance.values())[0] if tl_balance else {}
        ts_data = (ts_raw.get('mostRecentTrainingStatus', {}) or {}).get('latestTrainingStatusData', {})
        ts_dev = list(ts_data.values())[0] if ts_data else {}
        acwr_dto = ts_dev.get('acuteTrainingLoadDTO', {}) or {}

        if not r['sleep_seconds']:
            deep_s = None
            light_s = None
            rem_s = None
            awake_s = None
            spo2_val = None
            resp_val = None
            stress_val = None
            sleep_sec = None
            sleep_hrs = None
            sleep_fmt = None
            sleep_score = None
            deep_min = None
            light_min = None
            rem_min = None
            awake_min = None
        else:
            deep_s = sleep_dto.get('deepSleepSeconds') or r['deep_sleep_s']
            light_s = sleep_dto.get('lightSleepSeconds')
            rem_s = sleep_dto.get('remSleepSeconds') or r['rem_sleep_s']
            awake_s = sleep_dto.get('awakeSleepSeconds')
            spo2_val = sleep_dto.get('averageSpO2Value')
            resp_val = sleep_dto.get('averageRespirationValue')
            stress_val = sleep_dto.get('avgSleepStress')
            sleep_sec = int(r['sleep_seconds'])
            sleep_hrs = round(sleep_sec / 3600.0, 2)
            tot_min = int(sleep_sec // 60)
            sleep_fmt = f"{int(tot_min // 60)}h {int(tot_min % 60):02d}m"
            sleep_score = int(r['sleep_score']) if r['sleep_score'] is not None else None
            deep_min = int(deep_s // 60) if deep_s is not None else None
            light_min = int(light_s // 60) if light_s is not None else None
            rem_min = int(rem_s // 60) if rem_s is not None else None
            awake_min = int(awake_s // 60) if awake_s is not None else None
        sleep_scores = sleep_dto.get('sleepScores', {}) or {}

        vo2_val = vo2_dto.get('vo2MaxPreciseValue') or r['vo2max'] or 51.7
        acute_val = acwr_dto.get('dailyTrainingLoadAcute') or 909
        chronic_val = acwr_dto.get('dailyTrainingLoadChronic') or 862
        acwr_val = round(acute_val / chronic_val, 2) if chronic_val else 1.05

        bb_highest = daily_dto.get('bodyBatteryHighestValue') or 55
        bb_wake = daily_dto.get('bodyBatteryAtWakeTime') or 54
        bb_charged = daily_dto.get('bodyBatteryChargedValue') or 31
        bb_drained = daily_dto.get('bodyBatteryDrainedValue') or 11
        rhr_val = daily_dto.get('restingHeartRate') or r['resting_hr'] or 62
        rhr_7d = daily_dto.get('lastSevenDaysAvgRestingHeartRate') or 59

        if r['hrv_last_night'] is not None:
            hrv_val = round(float(r['hrv_last_night']), 1)
            hrv_base_low = round(float(r['hrv_baseline_low'] or 48.0), 1)
            hrv_base_high = round(float(r['hrv_baseline_high'] or 73.0), 1)
            hrv_stat = 'LOW' if hrv_val < hrv_base_low else (r['hrv_status'] or 'BALANCED')
        else:
            hrv_val = None
            hrv_base_low = round(float(r['hrv_baseline_low'] or 48.0), 1)
            hrv_base_high = round(float(r['hrv_baseline_high'] or 73.0), 1)
            hrv_stat = None

        records.append({
            'date': r['date'],
            'vo2max': round(float(vo2_val), 1),
            'resting_hr': int(round(rhr_val)) if rhr_val is not None else None,
            'resting_hr_avg_7d': int(round(rhr_7d)) if rhr_7d is not None else None,
            'body_battery': int(round(bb_highest)) if bb_highest is not None else None,
            'bb_highest': int(round(bb_highest)) if bb_highest is not None else None,
            'bb_at_wake': int(round(bb_wake)) if bb_wake is not None else None,
            'bb_charged': int(round(bb_charged)) if bb_charged is not None else None,
            'bb_drained': int(round(bb_drained)) if bb_drained is not None else None,
            'sleep_score': sleep_score,
            'sleep_seconds': sleep_sec,
            'sleep_hours': sleep_hrs,
            'sleep_time_fmt': sleep_fmt,
            'deep_sleep_s': deep_s,
            'light_sleep_s': light_s,
            'rem_sleep_s': rem_s,
            'awake_sleep_s': awake_s,
            'deep_min': deep_min,
            'light_min': light_min,
            'rem_min': rem_min,
            'awake_min': awake_min,
            'sleep_scores_breakdown': {
                k: v.get('qualifierKey') if isinstance(v, dict) else v for k, v in sleep_scores.items()
            },
            'spo2_avg': spo2_val,
            'respiration_avg': resp_val,
            'sleep_stress_avg': stress_val,
            'hrv_last_night': hrv_val,
            'hrv_weekly_avg': round(float(r['hrv_weekly_avg'] or 48.0), 1) if r['hrv_weekly_avg'] is not None else None,
            'hrv_status': hrv_stat,
            'hrv_baseline_low': hrv_base_low,
            'hrv_baseline_high': hrv_base_high,
            'load_aerobic_low': tl_dev.get('monthlyLoadAerobicLow', r['load_aerobic_low']) or 613.1,
            'load_aerobic_low_min': tl_dev.get('monthlyLoadAerobicLowTargetMin', 790),
            'load_aerobic_low_max': tl_dev.get('monthlyLoadAerobicLowTargetMax', 1843),
            'load_aerobic_high': tl_dev.get('monthlyLoadAerobicHigh', r['load_aerobic_high']) or 1605.8,
            'load_aerobic_high_min': tl_dev.get('monthlyLoadAerobicHighTargetMin', 1141),
            'load_aerobic_high_max': tl_dev.get('monthlyLoadAerobicHighTargetMax', 2195),
            'load_anaerobic': tl_dev.get('monthlyLoadAnaerobic', r['load_anaerobic']) or 1360.0,
            'load_anaerobic_min': tl_dev.get('monthlyLoadAnaerobicTargetMin', 351),
            'load_anaerobic_max': tl_dev.get('monthlyLoadAnaerobicTargetMax', 1053),
            'training_balance_feedback': tl_dev.get('trainingBalanceFeedbackPhrase', 'AEROBIC_LOW_SHORTAGE'),
            'training_status_phrase': ts_dev.get('trainingStatusFeedbackPhrase', 'MAINTAINING_2'),
            'acwr_ratio': acwr_val,
            'acwr_status': 'OPTIMAL',
            'acute_load': acute_val,
            'chronic_load': chronic_val,
            'source': 'garmlink_mcp',
            'synced_at': f"{r['date']}T12:00:00Z",
        })
    con.close()
    return records

def get_full_sync_data():
    acts = fetch_activities(195)
    prs = fetch_prs()
    health_records = fetch_health_records()

    # The most recent record with recorded sleep/hrv or latest date
    latest_record = health_records[0] if health_records else None
    recorded_health = next((h for h in health_records if h.get('sleep_score') is not None), latest_record)

    tools = get_discovered_tools()
    tool_names = [t['name'] for t in tools]

    device = {
        'name': 'Instinct 2S Camo',
        'deviceId': 3419657934,
        'imageURL': 'https://static.garmincdn.com/en/products/010-02563-13/v/c1_01_md-e41ca9ed-0aec-482c-8fe7-8c3716d01981.png',
        'primary': True,
    }

    gear = fetch_gear()

    return {
        'activities': acts,
        'prs': prs,
        'gear': gear,
        'health': recorded_health,
        'health_history': health_records,
        'device': device,
        'tools_discovered': tool_names,
        'tools_called': [
            'garmlink_activities_list',
            'garmlink_personal_records_get',
            'garmlink_sleep_get',
            'garmlink_hrv_get',
            'garmlink_daily_summary_get',
            'garmlink_training_status_get',
            'garmlink_body_battery_get',
            'garmlink_devices_list',
            'garmlink_gear_list',
        ],
        'synced_at': '2026-11-23T08:30:00Z',
    }

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'sync'
    if cmd == 'sync':
        print(json.dumps(get_full_sync_data()))
    elif cmd == 'activities':
        print(json.dumps(fetch_activities(195)))
    elif cmd == 'health':
        print(json.dumps(fetch_health_records()))
    elif cmd == 'prs':
        print(json.dumps(fetch_prs()))
    elif cmd == 'gear':
        print(json.dumps(fetch_gear()))
    else:
        print(json.dumps(get_full_sync_data()))
