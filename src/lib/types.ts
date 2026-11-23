export type SurfaceType =
  | 'road'
  | 'track'
  | 'xc'
  | 'grass'
  | 'trail'
  | 'gravel'
  | 'treadmill';

export type ShoeId =
  | 'streakfly'
  | 'vaporfly_next2'
  | 'dragonfly_xc'
  | 'dragonfly_track'
  | 'nb_1080';

export type WindDirection = 'head' | 'tail' | 'cross' | 'mixed';

export type HrvStatus = 'BALANCED' | 'LOW' | 'UNBALANCED' | 'POOR';

export type SplitStrategy = 'course_gap' | 'negative' | 'even';

export type TrainingFocusId =
  | 'track_mid'
  | 'track_long'
  | 'xc'
  | 'half_marathon'
  | 'base_building';

export type WorkoutType = 'easy' | 'workout' | 'long_run' | 'recovery' | 'rest' | 'race';

export interface Effort {
  id: string;
  distance_m: number;
  time_s: number;
  date: string;
  power_w?: number;
  hr_avg?: number;
  source: string;
  label: string;
}

export interface VolumeProfile {
  longest_run_miles: number;
  avg_weekly_miles: number;
}

export interface CourseConditions {
  elevation_gain_ft: number;
  elevation_loss_ft: number;
  surface: SurfaceType;
  altitude_ft: number;
  temperature_f: number;
  humidity_pct: number;
  wind_mph: number;
  wind_direction: WindDirection;
  shoe_type: ShoeId;
  use_readiness: boolean;
  hrv_status: HrvStatus;
  sleep_score: number;
  body_battery: number;
}

export interface RaceWeatherSync {
  temp_f: number;
  humidity: number;
  wind_mph: number;
  wind_deg: number | null;
  wind_compass: string;
  weather_code: number;
  condition_label: string;
  target_datetime: string;
  timezone_abbr: string;
  source: 'current' | 'hourly_forecast' | 'historical_actual' | 'historical_reference';
  note?: string;
}

export interface CoursePreset {
  course_id: string;
  name: string;
  short_name: string;
  distance_label: string;
  surface: SurfaceType;
  elevation_gain_ft: number;
  elevation_loss_ft: number;
  altitude_ft: number;
  lat: number;
  lon: number;
  max_incline_pct: number;
  max_decline_pct: number;
  description: string;
  profile: number[];
  is_preset: boolean;
}

export interface ModelContribution {
  time_s: number;
  time_fmt: string;
  weight: number;
}

export interface RacePrediction {
  distance_m: number;
  distance_label: string;
  time_s: number;
  time_fmt: string;
  fast_s: number;
  fast_fmt: string;
  slow_s: number;
  slow_fmt: string;
  pace_per_mile_s: number;
  pace_per_mile: string;
  theoretical_time_s: number;
  theoretical_time_fmt: string;
  volume_penalty_pct: number;
  readiness_status: 'READY' | 'VOLUME STRETCH' | 'HIGH BONK RISK';
  readiness_note: string;
  models: Record<string, ModelContribution>;
  adjustments: Record<string, number>;
  adjustment_pct: number;
}

export interface FitnessMetrics {
  critical_speed_mps: number | null;
  critical_speed_pace: string;
  d_prime_m: number | null;
  riegel_exponent: number | null;
  vo2max: number | null;
  fatigue_profile: string;
  num_efforts: number;
  model_fit_r2: number | null;
  longest_run_miles: number;
  avg_weekly_miles: number;
  lt_hr_bpm: number;
}

export interface TrainingZones {
  recovery: { pace_s: number; label: string };
  easy: { pace_s: number; label: string };
  marathon: { pace_s: number; label: string };
  threshold: { pace_s: number; label: string };
  interval: { pace_s: number; label: string };
  repetition: { pace_s: number; label: string };
  rep_400m: string;
}

export interface RaceSplit {
  label: string;
  segment_m: number;
  segment_time_s: number;
  segment_time_fmt: string;
  cumulative_time_s: number;
  cumulative_time_fmt: string;
  pace_per_mile: string;
  elev_delta_ft: number;
  grade_pct: number;
  cue: string;
}

export interface ShoeComparison {
  shoe_id: ShoeId;
  label: string;
  short_label: string;
  time_s: number;
  time_fmt: string;
  pace_per_mile: string;
  shoe_pct: number;
  delta_s: number;
  tag: 'OPTIMAL' | 'VIABLE' | 'TRAINING HEAVY' | 'SURFACE HAZARD';
}

export interface HealthSnapshot {
  date: string;
  vo2max: number | null;
  hrv_last_night: number | null;
  hrv_weekly_avg: number | null;
  hrv_status: HrvStatus;
  hrv_baseline_low: number;
  hrv_baseline_high: number;
  sleep_score: number | null;
  sleep_hours: number | null;
  body_battery: number | null;
  resting_hr: number | null;
  stress_avg: number | null;
  load_anaerobic: number | null;
  load_aerobic_low: number | null;
  load_aerobic_high: number | null;
  consecutive_run_days: number;
  source: 'garmlink_mcp' | 'manual';
  synced_at: string;
}

export interface DailyWorkout {
  day: string;
  name: string;
  workout_type: WorkoutType;
  distance_miles: number;
  pace_target: string;
  hr_cap: string;
  description: string;
  injury_prevention_note: string;
  ai_generated?: boolean;
  adaptation_reason?: string;
}

export interface TrainingPlan {
  focus_id: TrainingFocusId;
  title: string;
  target_race: string;
  weekly_mileage: number;
  aerobic_deficit_focus: string;
  schedule: DailyWorkout[];
  ai_generated?: boolean;
  generated_at?: string;
  model_used?: string;
}

export interface CoachMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  tool_actions?: string[];
  error?: boolean;
  retryPrompt?: string;
}

export interface WatchActivity {
  id: string;
  name: string;
  date: string;
  activity_type: string;
  distance_m: number;
  duration_s: number;
  avg_hr: number | null;
  max_hr: number | null;
  elevation_gain_ft: number;
  avg_cadence: number | null;
  source: 'garmlink_mcp' | 'file_import';
  source_label: string;
}

export interface GarmlinkSyncMeta {
  connected: boolean;
  syncing: boolean;
  last_synced_at: string | null;
  tools_discovered: string[];
  tools_called: string[];
  error: string | null;
}
