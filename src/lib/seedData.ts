import type { CoursePreset, Effort, ShoeId, SurfaceType } from './types';

export const ATHLETE_PROFILE = {
  name: 'Ephraim',
  lt_hr_bpm: 184,
  max_hr_bpm: 202,
  resting_hr_baseline: 54,
  hrv_baseline_low: 48,
  hrv_baseline_high: 74,
};

// Verified athlete personal records from original RaceKit profile (automatically updated when Garmlink MCP syncs PRs)
export const VERIFIED_PR_EFFORTS: Effort[] = [
  {
    id: 'pr-1k',
    distance_m: 1000,
    time_s: 194.2,
    date: '2026-10-14',
    hr_avg: 186,
    source: 'verified_pr',
    label: '1K',
  },
  {
    id: 'pr-mile',
    distance_m: 1609.344,
    time_s: 318.88,
    date: '2026-10-28',
    hr_avg: 191,
    source: 'verified_pr',
    label: 'Mile',
  },
  {
    id: 'pr-5k',
    distance_m: 5000,
    time_s: 1144.75,
    date: '2026-11-09',
    hr_avg: 188,
    source: 'verified_pr',
    label: '5K',
  },
  {
    id: 'pr-10k',
    distance_m: 10000,
    time_s: 2591.8,
    date: '2026-10-02',
    hr_avg: 179,
    source: 'verified_pr',
    label: '10K',
  },
];

export const SHOE_DATABASE: Record<
  ShoeId,
  {
    label: string;
    short_label: string;
    description: string;
    default_surface: SurfaceType;
    weight_g: number;
  }
> = {
  streakfly: {
    label: 'Nike Streakfly (Lightweight Road Flat)',
    short_label: 'Nike Streakfly',
    description:
      '170g ZoomX racing flat with midfoot shank. Primary fast 5K road weapon and verified 19:29 XC PR anchor.',
    default_surface: 'road',
    weight_g: 170,
  },
  vaporfly_next2: {
    label: 'Nike Vaporfly Next% 2 (Carbon Super-Shoe)',
    short_label: 'Nike Vaporfly Next% 2',
    description:
      '40mm ZoomX + full carbon Flyplate. Maximum economy for 10K to marathon; stiffer plate slightly reduces 5K cadence vs Streakfly.',
    default_surface: 'road',
    weight_g: 196,
  },
  dragonfly_xc: {
    label: 'Nike Dragonfly XC (6-Pin XC Spikes)',
    short_label: 'Nike Dragonfly XC',
    description:
      'ZoomX foam + reinforced upper + 6-pin steel traction for grass, mud, and Delaware XC hills.',
    default_surface: 'xc',
    weight_g: 158,
  },
  dragonfly_track: {
    label: 'Nike Dragonfly 2 (Track Spikes)',
    short_label: 'Nike Dragonfly 2',
    description:
      '135g featherweight ZoomX + Pebax plate + 6-pin track layout for 800m–5000m track racing.',
    default_surface: 'track',
    weight_g: 135,
  },
  nb_1080: {
    label: 'New Balance 1080 v15 (Daily Trainer)',
    short_label: 'NB 1080 v15',
    description:
      '300g Fresh Foam X max-cushion daily mileage trainer for joint protection on Zone 2 aerobic base runs.',
    default_surface: 'road',
    weight_g: 300,
  },
};

export const SURFACE_OPTIONS: Record<
  SurfaceType,
  { label: string; penalty_pct: number; default_shoe: ShoeId }
> = {
  road: { label: 'Road (Asphalt)', penalty_pct: 0.0, default_shoe: 'streakfly' },
  track: { label: 'Track (All-Weather)', penalty_pct: -0.5, default_shoe: 'dragonfly_track' },
  xc: { label: 'Cross Country (Grass / Hills)', penalty_pct: 3.6, default_shoe: 'dragonfly_xc' },
  grass: { label: 'Grass (Parkland)', penalty_pct: 3.0, default_shoe: 'dragonfly_xc' },
  trail: { label: 'Trail (Dirt / Woods)', penalty_pct: 4.5, default_shoe: 'dragonfly_xc' },
  gravel: { label: 'Gravel / Crushed Stone', penalty_pct: 2.5, default_shoe: 'streakfly' },
  treadmill: { label: 'Treadmill', penalty_pct: -1.0, default_shoe: 'streakfly' },
};

export const PRESET_COURSES: CoursePreset[] = [
  {
    course_id: 'run_for_pie_glasgow',
    name: 'Run for Pie 5K — Glasgow Park (Newark, DE)',
    short_name: 'Run for Pie 5K · Glasgow Park',
    distance_label: '5K',
    surface: 'road',
    elevation_gain_ft: 55,
    elevation_loss_ft: 55,
    max_incline_pct: 2.4,
    max_decline_pct: -2.2,
    altitude_ft: 70,
    lat: 39.6079,
    lon: -75.7369,
    description:
      'Fast, flat loop inside Glasgow Park on paved multi-use paths. Mild banking around the pond; prime PR course.',
    profile: [65, 68, 74, 82, 85, 78, 71, 66, 68, 65],
    is_preset: true,
  },
  {
    course_id: 'brandywine_creek_ncc',
    name: 'Brandywine Creek State Park — NCC Champs 5K XC',
    short_name: 'Brandywine Creek · NCC Champs',
    distance_label: '5K',
    surface: 'xc',
    elevation_gain_ft: 380,
    elevation_loss_ft: 380,
    max_incline_pct: 12.5,
    max_decline_pct: -11.8,
    altitude_ft: 220,
    lat: 39.8054,
    lon: -75.5735,
    description:
      'Premier Delaware XC powerhouse course featuring Cemetery Hill and The Wall. Demands aggressive spike bite and eccentric quad control.',
    profile: [180, 230, 310, 410, 310, 240, 350, 280, 220, 180],
    is_preset: true,
  },
  {
    course_id: 'killens_pond_diaa',
    name: 'Killens Pond State Park — DIAA State Champs 5K XC',
    short_name: 'Killens Pond · DIAA State Champs',
    distance_label: '5K',
    surface: 'xc',
    elevation_gain_ft: 125,
    elevation_loss_ft: 125,
    max_incline_pct: 5.2,
    max_decline_pct: -5.5,
    altitude_ft: 50,
    lat: 38.9855,
    lon: -75.5458,
    description:
      'Delaware DIAA State Championship venue. Fast meadow loops, wooded pond trail, and punchy rollers.',
    profile: [50, 68, 92, 106, 85, 68, 88, 74, 58, 50],
    is_preset: true,
  },
  {
    course_id: 'white_clay_creek',
    name: 'White Clay Creek State Park — Newark 5K XC',
    short_name: 'White Clay Creek · Newark XC',
    distance_label: '5K',
    surface: 'xc',
    elevation_gain_ft: 310,
    elevation_loss_ft: 310,
    max_incline_pct: 7.8,
    max_decline_pct: -7.2,
    altitude_ft: 140,
    lat: 39.7194,
    lon: -75.6893,
    description:
      'Technical wooded trails, creek valley switchbacks, and sustained aerobic climbs.',
    profile: [120, 160, 220, 280, 240, 305, 250, 190, 145, 120],
    is_preset: true,
  },
  {
    course_id: 'bellevue_state_park',
    name: 'Bellevue State Park — Blue Hen Conf 5K XC',
    short_name: 'Bellevue · Blue Hen Conf XC',
    distance_label: '5K',
    surface: 'xc',
    elevation_gain_ft: 195,
    elevation_loss_ft: 195,
    max_incline_pct: 6.0,
    max_decline_pct: -5.8,
    altitude_ft: 180,
    lat: 39.7765,
    lon: -75.5022,
    description:
      'Sweeping grass estate fields, gravel horse track, and sustained grinding climbs.',
    profile: [165, 185, 215, 248, 230, 195, 210, 190, 175, 165],
    is_preset: true,
  },
  {
    course_id: 'blackbird_forest_xc',
    name: 'Blackbird State Forest — Smyrna 5K XC',
    short_name: 'Blackbird Forest · Smyrna XC',
    distance_label: '5K',
    surface: 'xc',
    elevation_gain_ft: 70,
    elevation_loss_ft: 70,
    max_incline_pct: 3.8,
    max_decline_pct: -3.5,
    altitude_ft: 95,
    lat: 39.3436,
    lon: -75.6775,
    description:
      'Flat, fast woodland doubletrack and packed grass perimeter built for fast spike times.',
    profile: [98, 108, 122, 134, 125, 110, 116, 114, 104, 98],
    is_preset: true,
  },
  {
    course_id: 'custom',
    name: 'Custom Course (Manual Sliders)',
    short_name: 'Custom Course',
    distance_label: '5K',
    surface: 'road',
    elevation_gain_ft: 0,
    elevation_loss_ft: 0,
    max_incline_pct: 0,
    max_decline_pct: 0,
    altitude_ft: 0,
    lat: 39.6079,
    lon: -75.7369,
    description: 'Manual environmental and elevation controls.',
    profile: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    is_preset: true,
  },
];
