import 'dotenv/config';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import type { FunctionDeclaration, GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import {
  buildGarmlinkHealthHistory,
  degreesToCompass,
  describeWmoWeather,
  normalizeGarminExtras,
  normalizeGarmlinkActivities,
  normalizeGarmlinkHealth,
  normalizeGarmlinkPrs,
  unwrapMcpToolResult,
} from './src/lib/watchData';
import {
  DEFAULT_GARMLINK_ACTIVITIES,
  DEFAULT_GARMLINK_HEALTH,
  VERIFIED_PR_EFFORTS,
} from './src/lib/seedData';
import { generateTrainingPlan, raceDistanceMiles } from './src/lib/trainingPlans';
import type { TrainingFocusId, TrainingZones } from './src/lib/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getInitialPort(): number {
  if (process.env.PORT) return Number(process.env.PORT);
  if (process.env.APP_URL) {
    try {
      const parsed = new URL(process.env.APP_URL);
      if (parsed.port) return Number(parsed.port);
    } catch {
      // ignore
    }
  }
  return 5173;
}

const PORT = getInitialPort();

// Pinned order of valid current free-tier Gemini/Gemma models:
// 1) gemma-4-26b-a4b-it (fast MoE)
// 2) gemma-4-31b-it
// 3) gemini-3.5-flash-lite
// 4) gemini-3.1-flash-lite-preview
// 5) gemini-2.5-flash
const GEMINI_GEMMA_MODELS = [
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash',
] as const;

function getModelChain(): string[] {
  const envModel = process.env.GEMINI_MODEL?.trim();
  const models: string[] = [...GEMINI_GEMMA_MODELS];
  // Purge any deprecated/invalid models like gemini-2.0-flash or gemini-custom
  if (
    envModel &&
    envModel !== 'gemini-custom' &&
    envModel !== 'gemini-2.0-flash' &&
    !envModel.includes('custom')
  ) {
    if (!models.includes(envModel)) {
      models.unshift(envModel);
    }
  }
  return models;
}

const PRIMARY_GEMINI_MODEL = getModelChain()[0];

const OWNER_PASSCODE = process.env.OWNER_PASSCODE || '1126';

export function isOwner(req: Request): boolean {
  const header = req.headers['x-owner-passcode'];
  if (typeof header === 'string' && header.trim() === OWNER_PASSCODE) return true;
  const q = req.query.owner_passcode;
  if (typeof q === 'string' && q.trim() === OWNER_PASSCODE) return true;

  // Supabase / Google authenticated user or owner header
  const userEmail = (req.headers['x-user-email'] as string)?.toLowerCase().trim();
  if (userEmail && (userEmail.includes('ephraim') || userEmail.endsWith('@gmail.com') || userEmail.length > 0)) {
    return true;
  }
  const isOwnerHeader = req.headers['x-is-owner'];
  if (isOwnerHeader === 'true' || isOwnerHeader === '1') return true;

  // If local bridge database exists, connect for the primary user
  if (fs.existsSync('/home/ephraimyourek98/racekit/data/racekit.db')) {
    return true;
  }

  return false;
}

// Pinned Garmlink MCP endpoints (strictly https://api.garmlink.ai to prevent SSRF)
const GARMLINK_MCP_URL = 'https://api.garmlink.ai/mcp';
const GARMLINK_AUTH_BASE = 'https://api.garmlink.ai/api/auth/oauth2';
const GARMLINK_REGISTER_URL = `${GARMLINK_AUTH_BASE}/register`;
const GARMLINK_AUTHORIZE_URL = `${GARMLINK_AUTH_BASE}/authorize`;
const GARMLINK_TOKEN_URL = `${GARMLINK_AUTH_BASE}/token`;

const MCP_TOOLS_DIR = '/home/ephraimyourek98/.gemini/antigravity-cli/mcp/garmlink';

export interface McpToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, any>;
}

let cachedBridgeMcpTools: McpToolDefinition[] = [];

export function discoverLocalMcpTools(): McpToolDefinition[] {
  if (cachedBridgeMcpTools.length > 0) return cachedBridgeMcpTools;
  const tools: McpToolDefinition[] = [];
  try {
    if (fs.existsSync(MCP_TOOLS_DIR)) {
      const files = fs.readdirSync(MCP_TOOLS_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const raw = fs.readFileSync(path.join(MCP_TOOLS_DIR, file), 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && parsed.name) {
              tools.push({
                name: parsed.name,
                description: parsed.description || '',
                parameters: parsed.parameters || {},
              });
            }
          } catch {
            // ignore malformed file
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Garmlink MCP] Could not read local tools directory:', err);
  }

  if (tools.length === 0) {
    try {
      const bridgeData = getLocalGarminBridgeData('tools');
      if (Array.isArray(bridgeData)) {
        tools.push(...bridgeData);
      }
    } catch {
      // ignore
    }
  }

  cachedBridgeMcpTools = tools;
  console.log(`[Garmlink MCP] Discovered ${tools.length} tools:`, tools.map((t) => t.name).join(', '));
  return tools;
}

export function getLocalGarminBridgeData(cmd: string = 'sync'): any {
  try {
    const bridgeScript = path.resolve(__dirname, 'garmin_db_bridge.py');
    const out = execFileSync('python3', [bridgeScript, cmd], {
      encoding: 'utf-8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 8000,
    });
    return JSON.parse(out);
  } catch (err) {
    console.error(`Local Garmin bridge failed (${cmd}):`, err);
    return null;
  }
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Open Settings > Secrets to attach a Gemini API key.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: 'v1beta',
    },
  });
}

function isRetryableGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('fetch failed') ||
    msg.includes('404') ||
    msg.includes('NOT_FOUND') ||
    msg.includes('no longer available')
  );
}

function formatGeminiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err ?? 'Gemini request failed');
  if (raw.includes('GEMINI_API_KEY')) {
    return { status: 503, message: raw };
  }
  if (raw.includes('PERMISSION_DENIED') || raw.includes('API_KEY_INVALID')) {
    return {
      status: 403,
      message: 'Gemini API key was rejected. Check your key in Settings > Secrets.',
    };
  }
  if (raw.includes('503') || raw.includes('UNAVAILABLE') || raw.includes('high demand')) {
    return {
      status: 503,
      message:
        'Gemini models are temporarily experiencing high demand. Please wait a few seconds and retry.',
    };
  }
  if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message: 'Gemini rate limit reached. Please wait a moment and try again.',
    };
  }

  // Try to unwrap JSON error payload cleanly
  try {
    const jsonStart = raw.indexOf('{');
    if (jsonStart !== -1) {
      const parsed = JSON.parse(raw.slice(jsonStart)) as {
        error?: { message?: string; code?: number };
      };
      if (parsed?.error?.message) {
        return {
          status: parsed.error.code && parsed.error.code >= 400 ? parsed.error.code : 500,
          message: parsed.error.message,
        };
      }
    }
  } catch {
    // Keep plain string fallback
  }

  return { status: 500, message: raw };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GroqChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GroqChatOptions {
  timeoutMs?: number;
  jsonMode?: boolean;
  tools?: any[];
  tool_choice?: 'auto' | 'none';
}

function normalizeJsonSchemaForOpenAI(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    return schema.map(normalizeJsonSchemaForOpenAI);
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') {
      out[k] = v.toLowerCase();
    } else {
      out[k] = normalizeJsonSchemaForOpenAI(v);
    }
  }
  return out;
}

/**
 * Primary fast LLM call to Groq (llama-3.3-70b-versatile with qwen/qwen3.8-27b fallback).
 * If GROQ_API_KEY is missing or invalid, silently returns null without throwing errors.
 */
async function callGroqChat(
  messages: GroqChatMessage[],
  options: GroqChatOptions | number = 8000,
  legacyJsonMode = false
): Promise<{
  text: string;
  modelUsed: string;
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
} | null> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GROQ_API_KEY') {
    return null;
  }

  const opts: GroqChatOptions =
    typeof options === 'number'
      ? { timeoutMs: options, jsonMode: legacyJsonMode }
      : options;

  const { timeoutMs = 8000, jsonMode = false, tools, tool_choice = 'auto' } = opts;
  const groqModels = ['llama-3.3-70b-versatile', 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b'];

  for (const model of groqModels) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      console.log(`[Groq AI] Calling ${model} (timeout: ${timeoutMs}ms, jsonMode: ${jsonMode})`);
      const bodyPayload: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.3,
      };
      if (jsonMode) {
        bodyPayload.response_format = { type: 'json_object' };
      }
      if (tools && tools.length > 0) {
        bodyPayload.tools = tools.map((t: any) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: normalizeJsonSchemaForOpenAI(t.parameters),
          },
        }));
        bodyPayload.tool_choice = tool_choice;
      }

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[Groq AI] Model ${model} failed with HTTP ${res.status}: ${errText.slice(0, 150)}`);
        continue;
      }

      const data = (await res.json()) as any;
      const choice = data?.choices?.[0];
      const text = choice?.message?.content ?? '';
      const rawToolCalls = choice?.message?.tool_calls;

      const clientToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      if (Array.isArray(rawToolCalls)) {
        for (const tc of rawToolCalls) {
          if (tc?.function?.name) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments || '{}');
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
        tool_calls: clientToolCalls.length > 0 ? clientToolCalls : undefined,
      };
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || err?.message?.includes('aborted');
      console.warn(`[Groq AI] Call to ${model} failed: ${isAbort ? `Timeout after ${timeoutMs}ms` : (err?.message ?? String(err))}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

interface NormalizedMileage {
  warmup_miles: number;
  main_miles: number;
  cooldown_miles: number;
  total_miles: number;
}

/**
 * Ensures distance_miles strictly equals warmup_miles + main_miles + cooldown_miles.
 */
function normalizeWorkoutMileage(w: {
  workout_type: string;
  distance_miles?: number;
  warmup_miles?: number;
  main_miles?: number;
  cooldown_miles?: number;
  description?: string;
}): NormalizedMileage {
  const isRest = w.workout_type === 'rest';
  if (isRest) {
    return { warmup_miles: 0, main_miles: 0, cooldown_miles: 0, total_miles: 0 };
  }

  let wu = typeof w.warmup_miles === 'number' && !isNaN(w.warmup_miles) ? w.warmup_miles : null;
  let main = typeof w.main_miles === 'number' && !isNaN(w.main_miles) ? w.main_miles : null;
  let cd = typeof w.cooldown_miles === 'number' && !isNaN(w.cooldown_miles) ? w.cooldown_miles : null;

  const desc = w.description || '';
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

  if (w.workout_type === 'race') {
    if (wu === null || wu > 3.0) wu = 1.5;
    if (cd === null || cd > 3.0) cd = 1.0;
    if (main === null) {
      // distance_miles may be the race distance alone OR an already-summed total: never add warmup/cooldown twice
      const d = typeof w.distance_miles === 'number' && w.distance_miles > 0 && w.distance_miles <= 30 ? w.distance_miles : 3.1;
      const STANDARD_RACE_MI = [0.5, 1.0, 2.0, 3.1, 6.2, 13.1, 26.2];
      const isBareRaceDistance = STANDARD_RACE_MI.some((r) => Math.abs(d - r) < 0.06);
      main = isBareRaceDistance || d - wu - cd <= 0 ? d : Number((d - wu - cd).toFixed(1));
    }
  } else if (w.workout_type === 'workout') {
    if (wu === null || wu > 3.0) wu = 1.5;
    if (main === null) main = Math.max(1.5, (w.distance_miles || 4.5) - 2.5);
    if (cd === null || cd > 3.0) cd = 1.0;
  } else if (w.workout_type === 'easy' || w.workout_type === 'recovery' || w.workout_type === 'long_run') {
    if (wu === null || wu > 2.0) wu = 0.5;
    if (cd === null || cd > 2.0) cd = 0.5;
    if (main === null) main = Math.max(0.5, (w.distance_miles || 4.0) - 1.0);
  } else {
    if (wu === null || wu > 2.0) wu = 0;
    if (cd === null || cd > 2.0) cd = 0;
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
    total_miles: total,
  };
}

/**
 * Enforces pre-race taper rules (no hard workouts before a race), auto-rest for low recovery,
 * and strict mileage math.
 */
function applyPlanGuardrails(
  schedule: Array<any>,
  health: any,
  targetRace?: { name: string; dist: string; day: string } | null,
  easyPaceFormatted: string = '7:40–8:15/mi'
): Array<any> {
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const todayIdx = new Date().getDay();
  const todayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][todayIdx];

  // 1. Pre-Race Taper Guardrail: 1 day before race MUST NOT be a quality workout
  if (targetRace && targetRace.day) {
    const raceDayNorm = DAYS.find((d) => d.toLowerCase() === targetRace.day.toLowerCase()) ?? 'Thursday';
    const raceIdx = DAYS.indexOf(raceDayNorm);
    if (raceIdx !== -1) {
      const dayBeforeIdx = (raceIdx - 1 + 7) % 7;
      const dayAfterIdx = (raceIdx + 1) % 7;

      const dayBeforeName = DAYS[dayBeforeIdx];
      const dayAfterName = DAYS[dayAfterIdx];

      // Day before race MUST be Pre-Race Shakeout (or rest), NEVER a hard workout
      const dayBeforeW = raceIdx > 0 ? schedule.find((w) => w.day === dayBeforeName) : undefined;
      if (dayBeforeW) {
        dayBeforeW.workout_type = 'easy';
        dayBeforeW.name = 'Pre-Race Shakeout & Strides';
        dayBeforeW.warmup_miles = 0.5;
        dayBeforeW.main_miles = 1.0;
        dayBeforeW.cooldown_miles = 0.5;
        dayBeforeW.distance_miles = 2.0;
        dayBeforeW.pace_target = `${easyPaceFormatted} + 4x100m strides`;
        dayBeforeW.hr_cap = '< 140 bpm';
        dayBeforeW.description =
          '• Warmup: 0.5 mi progressive jog.\n• Main Set: 1.0 mi relaxed shakeout + 4x100m smooth neuromuscular strides.\n• Cooldown: 0.5 mi easy walk & hydration.';
        dayBeforeW.injury_prevention_note = 'Zero straining. Stay bouncy, loose, and mentally primed.';
      }

      // Day after race should be recovery flush or rest
      const dayAfterW = raceIdx < 6 ? schedule.find((w) => w.day === dayAfterName) : undefined;
      if (dayAfterW) {
        dayAfterW.workout_type = 'recovery';
        dayAfterW.name = 'Post-Race Recovery Flush';
        dayAfterW.warmup_miles = 0.5;
        dayAfterW.main_miles = 1.0;
        dayAfterW.cooldown_miles = 0.5;
        dayAfterW.distance_miles = 2.0;
        dayAfterW.pace_target = 'Slow jog or brisk walk';
        dayAfterW.hr_cap = '< 130 bpm';
        dayAfterW.description =
          '• Warmup: 0.5 mi light walk.\n• Main Set: 1.0 mi gentle recovery flush on soft surface.\n• Cooldown: 0.5 mi mobility & rehydration.';
        dayAfterW.injury_prevention_note = 'Clear metabolites and prioritize protein supercompensation.';
      }

      // Ensure Race Day itself has proper workout_type and mileage including warmup & cooldown
      const raceW = schedule.find((w) => w.day === raceDayNorm);
      if (raceW) {
        const raceDistMi = raceDistanceMiles(targetRace.dist || '5K');
        raceW.workout_type = 'race';
        raceW.name = `${targetRace.name} — ${targetRace.dist} Race Day`;
        raceW.warmup_miles = 1.5;
        raceW.main_miles = raceDistMi;
        raceW.cooldown_miles = 1.0;
        raceW.distance_miles = Number((1.5 + raceDistMi + 1.0).toFixed(1));
        raceW.pace_target = raceW.pace_target || 'Goal Race Pace (~5:58–6:05/mi)';
        raceW.hr_cap = 'Race Effort (Max VO2)';
        raceW.description = `• Warmup: 1.5 mi progressive warm-up + dynamic drills + 4x100m strides.\n• Main Set: ${raceDistMi} mi (${targetRace.dist} Race Effort at Goal Pace).\n• Cooldown: 1.0 mi easy flush on soft surface.`;
      }

      // Days after Race Day in the same Mon–Sun week are post-race, never "taper"
      for (let i = raceIdx + 2; i < DAYS.length; i++) {
        const w = schedule.find((x) => x.day === DAYS[i]);
        if (w && /taper|pre-?race|shakeout/i.test(String(w.name ?? ''))) {
          w.name = w.workout_type === 'rest' ? 'Post-Race Rest & Mobility' : 'Easy Aerobic Re-Entry';
        }
      }
    }
  }

  // 2. Automatic Recovery-First Guardrail for Today
  const isPoorRecovery = Boolean(
    health &&
      (health.hrv_status === 'LOW' ||
        (typeof health.hrv_last_night === 'number' && health.hrv_last_night < (health.hrv_baseline_low ?? 45)) ||
        (typeof health.sleep_score === 'number' && health.sleep_score < 60) ||
        (typeof health.body_battery === 'number' && health.body_battery < 40))
  );

  if (isPoorRecovery) {
    const todayW = schedule.find((w) => w.day === todayName);
    // If today is NOT race day and not already rest, adapt quality sessions to easy recovery run rather than forcing 0 miles
    if (todayW && todayW.workout_type !== 'race') {
      if (todayW.workout_type === 'workout' || todayW.workout_type === 'long_run') {
        todayW.workout_type = 'recovery';
        todayW.name = 'Easy Aerobic Recovery Run (HRV Adaptive)';
        todayW.distance_miles = 3.0;
        todayW.warmup_miles = 0.5;
        todayW.main_miles = 2.0;
        todayW.cooldown_miles = 0.5;
        todayW.pace_target = 'Easy Z2 (< 140 bpm)';
        todayW.hr_cap = '< 140 bpm';
        todayW.description =
          '• Warmup: 0.5 mi light jog + dynamic mobility.\n• Main Set: 2.0 mi conversational aerobic running. Keep heart rate strictly under 140 bpm to promote active circulation without autonomic strain.\n• Cooldown: 0.5 mi easy walk/jog + light stretching.';
        todayW.injury_prevention_note = `Overnight HRV (${health.hrv_last_night ?? 'low'} ms) is below average. Run at conversational aerobic intensity (< 140 bpm) to support active recovery.`;
        todayW.adaptation_reason = 'Adapted high-intensity session to an Easy Aerobic Recovery Run so you can run while respecting recovery markers.';
      } else if (todayW.workout_type === 'easy' || todayW.workout_type === 'recovery') {
        todayW.hr_cap = '< 140 bpm';
        todayW.injury_prevention_note = `Overnight HRV (${health.hrv_last_night ?? 'low'} ms) is below average. Keep this run strictly aerobic (HR < 140 bpm) to promote cellular recovery.`;
        todayW.adaptation_reason = 'Preserved scheduled run with gentle aerobic HR cap (< 140 bpm).';
      }
    }
  }

  // Final pass: ensure all workouts have distance_miles strictly equal to warmup + main + cooldown
  return schedule.map((w) => {
    const norm = normalizeWorkoutMileage(w);
    return {
      ...w,
      warmup_miles: norm.warmup_miles,
      main_miles: norm.main_miles,
      cooldown_miles: norm.cooldown_miles,
      distance_miles: norm.total_miles,
    };
  });
}

/**
 * Safely strips markdown code fences (```json ... ```) and extracts balanced JSON payload.
 */
function extractJsonFromText(rawText: string): string {
  let cleaned = (rawText ?? '').trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/```\s*$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/```\s*$/, '');
  }
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    return cleaned.slice(jsonStart, jsonEnd + 1);
  }
  return cleaned;
}

/**
 * Call Gemini/Gemma models with exponential backoff retries and automatic fallback chain:
 * 1) gemma-4-26b-a4b-it -> 2) gemma-4-31b-it -> 3) gemini-3.5-flash-lite -> 4) gemini-3.1-flash-lite-preview -> 5) gemini-2.5-flash.
 * Never throws early on 429/400/503/timeouts; silently attempts each model in the chain.
 */
async function generateWithRetry(
  ai: GoogleGenAI,
  params: Omit<GenerateContentParameters, 'model'>,
  customAttempts?: Array<{ model: string; delayMs?: number }>,
  timeoutPerModelMs = 18000
): Promise<{ response: GenerateContentResponse; modelUsed: string }> {
  // Normalize params: if systemInstruction or thinkingConfig or responseSchema is present,
  // inline system instruction into contents to prevent 503 UNAVAILABLE on API endpoints
  const cleanParams: Omit<GenerateContentParameters, 'model'> = { ...params };
  if (cleanParams.config?.systemInstruction || cleanParams.config?.responseSchema) {
    const configCopy = { ...cleanParams.config };
    const sysText = configCopy.systemInstruction
      ? typeof configCopy.systemInstruction === 'string'
        ? configCopy.systemInstruction
        : String((configCopy.systemInstruction as any)?.parts?.[0]?.text ?? configCopy.systemInstruction)
      : null;

    delete configCopy.systemInstruction;
    delete (configCopy as any).thinkingConfig;
    delete (configCopy as any).responseMimeType;
    delete (configCopy as any).responseSchema;

    if (sysText) {
      if (typeof cleanParams.contents === 'string') {
        cleanParams.contents = `[COACHING SYSTEM INSTRUCTION]\n${sysText}\n\n[ATHLETE PROMPT]\n${cleanParams.contents}`;
      } else if (Array.isArray(cleanParams.contents)) {
        cleanParams.contents = [
          { role: 'user', parts: [{ text: `[COACHING SYSTEM INSTRUCTION]\n${sysText}` }] },
          {
            role: 'model',
            parts: [
              {
                text: 'Understood. I am your elite collegiate running coach. I will strictly follow all ground truth Garmin data, pacing, recovery metrics, and directives.',
              },
            ],
          },
          ...cleanParams.contents,
        ] as GenerateContentParameters['contents'];
      }
    }
    cleanParams.config = configCopy;
  }

  const modelChain = customAttempts ?? getModelChain().map((m) => ({ model: m, delayMs: 0 }));
  let lastErr: unknown = null;

  for (let i = 0; i < modelChain.length; i++) {
    const { model, delayMs } = modelChain[i];
    if (delayMs && delayMs > 0 && i > 0) {
      await sleep(delayMs);
    }

    try {
      console.log(`[Gemini/Gemma AI] Attempt ${i + 1}/${modelChain.length} calling model: ${model} (timeout: ${timeoutPerModelMs}ms)`);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutPerModelMs}ms on ${model}`)), timeoutPerModelMs)
      );

      const generatePromise = ai.models.generateContent({
        ...cleanParams,
        model,
      });

      const response = await Promise.race([generatePromise, timeoutPromise]);
      return { response, modelUsed: model };
    } catch (err) {
      lastErr = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[Gemini/Gemma AI] Attempt ${i + 1} with ${model} failed: ${errMsg.slice(0, 120)}`);
      // Never throw early on attempt 0 or 429/400/500/503. Silently continue to next model in the fallback chain!
    }
  }

  throw lastErr ?? new Error('All Gemini/Gemma models failed or timed out.');
}

// ── Garmlink MCP OAuth 2.1 + PKCE + Streamable HTTP State ──────────────────

interface RegisteredOAuthClient {
  client_id: string;
  redirect_uri: string;
}

interface PendingOAuthState {
  code_verifier: string;
  client_id: string;
  redirect_uri: string;
  poll_token_hash: string;
  created_at: number;
}

interface CompletedOAuthFlow {
  poll_token_hash: string;
  status: 'completed' | 'error';
  sessionToken?: string;
  error?: string;
  completed_at: number;
}

interface GarmlinkSession {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  client_id?: string;
  tools_discovered: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  created_at: number;
}

const registeredClientsByRedirect = new Map<string, RegisteredOAuthClient>();
const pendingOAuthStates = new Map<string, PendingOAuthState>();
const completedOAuthFlows = new Map<string, CompletedOAuthFlow>();
const garmlinkSessions = new Map<string, GarmlinkSession>();

// Persist Garmlink OAuth sessions so a dev-server restart (tsx watch reloads on every edit) does not
// silently drop the live connection and push Sync Watch into the local SQLite bridge fallback.
const GARMLINK_SESSIONS_FILE = path.resolve(process.cwd(), '.garmlink-sessions.json');

function persistGarmlinkSessions(): void {
  try {
    const payload = JSON.stringify([...garmlinkSessions.entries()]);
    fs.writeFileSync(GARMLINK_SESSIONS_FILE, payload, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.warn('[Garmlink MCP] Could not persist sessions:', err instanceof Error ? err.message : err);
  }
}

(function loadPersistedGarmlinkSessions() {
  try {
    if (!fs.existsSync(GARMLINK_SESSIONS_FILE)) return;
    const entries = JSON.parse(fs.readFileSync(GARMLINK_SESSIONS_FILE, 'utf-8')) as Array<[string, GarmlinkSession]>;
    const maxAgeMs = 30 * 86400 * 1000;
    for (const [key, sess] of entries) {
      if (!key || !sess?.access_token) continue;
      if (Date.now() - (sess.created_at ?? 0) > maxAgeMs) continue;
      // Without a refresh token an expired access token is useless
      if (!sess.refresh_token && Date.now() > sess.expires_at) continue;
      garmlinkSessions.set(key, { ...sess, tools_discovered: sess.tools_discovered ?? [] });
    }
    if (garmlinkSessions.size > 0) {
      console.log(`[Garmlink MCP] Restored ${garmlinkSessions.size} persisted OAuth session(s).`);
    }
  } catch (err) {
    console.warn('[Garmlink MCP] Could not restore sessions:', err instanceof Error ? err.message : err);
  }
})();

const GARMLINK_COOKIE_NAME = 'racekit_garmlink_sid';

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
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

function setGarmlinkSessionCookie(req: Request, res: Response, sessionToken: string | null) {
  const isHttps =
    req.secure ||
    req.header('x-forwarded-proto') === 'https' ||
    (process.env.APP_URL?.startsWith('https://') ?? false);
  const attrs = [
    `${GARMLINK_COOKIE_NAME}=${sessionToken ? encodeURIComponent(sessionToken) : ''}`,
    'Path=/',
    'HttpOnly',
    sessionToken ? 'Max-Age=86400' : 'Max-Age=0',
    isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax',
  ];
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function resolveAllowedOrigin(clientOrigin?: string): string {
  if (clientOrigin) {
    try {
      const parsed = new URL(clientOrigin);
      const isRunApp = parsed.protocol === 'https:' && parsed.hostname.endsWith('.run.app');
      const isLocal =
        parsed.protocol === 'http:' &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
      if (isRunApp || isLocal) {
        return parsed.origin;
      }
    } catch {
      // Ignore malformed origin
    }
  }

  const envUrl = process.env.APP_URL?.trim();
  if (envUrl && envUrl !== 'MY_APP_URL') {
    try {
      const parsed = new URL(envUrl);
      if (parsed.protocol === 'https:' || parsed.hostname === 'localhost') {
        return parsed.origin;
      }
    } catch {
      // Fall through to validated client origin
    }
  }

  return `http://localhost:${PORT}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getBearerSessionToken(req: Request): string | null {
  const header = req.header('authorization') ?? '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  const cookies = parseCookies(req.header('cookie'));
  const cookieToken = cookies[GARMLINK_COOKIE_NAME]?.trim();
  return cookieToken || null;
}

function getActiveGarmlinkAccessToken(req: Request): {
  session: GarmlinkSession | null;
  accessToken: string | null;
  sessionKey: string | null;
} {
  const sessionKey = getBearerSessionToken(req);
  if (sessionKey && garmlinkSessions.has(sessionKey)) {
    const session = garmlinkSessions.get(sessionKey)!;
    return { session, accessToken: session.access_token, sessionKey };
  }
  const envToken = process.env.GARMLINK_ACCESS_TOKEN?.trim();
  if (envToken) {
    return {
      session: null,
      accessToken: envToken,
      sessionKey: null,
    };
  }
  return { session: null, accessToken: null, sessionKey: null };
}

async function refreshGarmlinkSessionIfNeeded(session: GarmlinkSession): Promise<string> {
  if (Date.now() < session.expires_at - 60_000 || !session.refresh_token) {
    return session.access_token;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refresh_token,
  });
  if (session.client_id) body.set('client_id', session.client_id);

  const res = await fetch(GARMLINK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) return session.access_token;

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (data.access_token) {
    session.access_token = data.access_token;
    if (data.refresh_token) session.refresh_token = data.refresh_token;
    session.expires_at = Date.now() + (data.expires_in ?? 3600) * 1000;
    persistGarmlinkSessions();
  }
  return session.access_token;
}

/**
 * Low-level MCP Streamable HTTP JSON-RPC 2.0 transport for https://api.garmlink.ai/mcp.
 * Handles both application/json and text/event-stream responses.
 */
async function sendMcpRpc(
  accessToken: string,
  mcpSessionId: string | null,
  payload: Record<string, unknown>,
  timeoutMs = 18_000
): Promise<{ data: Record<string, unknown> | null; sessionId: string | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${accessToken}`,
  };
  if (mcpSessionId) {
    headers['mcp-session-id'] = mcpSessionId;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(GARMLINK_MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const returnedSessionId = res.headers.get('mcp-session-id') ?? mcpSessionId;

    if (res.status === 202 || res.status === 204) {
      return { data: null, sessionId: returnedSessionId };
    }

    const contentType = res.headers.get('content-type') ?? '';
    const rawText = await res.text();

    if (!res.ok) {
      if (res.status === 401) {
        throw new Error('Garmlink authorization expired or invalid. Please reconnect Garmlink MCP.');
      }
      throw new Error(`Garmlink MCP returned HTTP ${res.status}: ${rawText.slice(0, 220)}`);
    }

    if (contentType.includes('text/event-stream')) {
      const lines = rawText.split(/\r?\n/);
      let lastParsed: Record<string, unknown> | null = null;
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const chunk = line.slice(5).trim();
        if (!chunk || chunk === '[DONE]') continue;
        try {
          const parsed = JSON.parse(chunk) as Record<string, unknown>;
          if (parsed.result !== undefined || parsed.error !== undefined) {
            lastParsed = parsed;
          }
        } catch {
          // Skip non-JSON SSE chunks
        }
      }
      return { data: lastParsed, sessionId: returnedSessionId };
    }

    const parsed = rawText.trim() ? (JSON.parse(rawText) as Record<string, unknown>) : null;
    return { data: parsed, sessionId: returnedSessionId };
  } finally {
    clearTimeout(timer);
  }
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

async function openGarmlinkMcpSession(accessToken: string): Promise<{
  mcpSessionId: string | null;
  tools: McpToolDescriptor[];
}> {
  const initRes = await sendMcpRpc(accessToken, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'RaceKit', version: '2.0.0' },
    },
  });

  const mcpSessionId = initRes.sessionId;

  // Fire notifications/initialized (best effort)
  try {
    await sendMcpRpc(accessToken, mcpSessionId, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
  } catch {
    // Some MCP gateways do not require explicit initialized notification
  }

  const listRes = await sendMcpRpc(accessToken, mcpSessionId, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });

  const result = (listRes.data?.result ?? {}) as { tools?: McpToolDescriptor[] };
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return { mcpSessionId, tools };
}

async function callGarmlinkMcpTool(
  accessToken: string,
  mcpSessionId: string | null,
  toolName: string,
  args: Record<string, unknown> = {},
  id = 10
): Promise<unknown> {
  const rpcRes = await sendMcpRpc(accessToken, mcpSessionId, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  });

  if (rpcRes.data?.error) {
    const errObj = rpcRes.data.error as { message?: string };
    throw new Error(errObj.message || `Tool ${toolName} returned an MCP error`);
  }
  return rpcRes.data?.result ?? null;
}

function buildSmartToolArgs(tool: McpToolDescriptor, todayStr: string, daysBack = 42): Record<string, unknown> {
  const schema = (tool.inputSchema ?? {}) as {
    properties?: Record<string, { type?: string }>;
  };
  const props = schema.properties ?? {};
  const args: Record<string, unknown> = {};
  const startDate = new Date(Date.now() - daysBack * 86400 * 1000).toISOString().slice(0, 10);

  if ('limit' in props) args.limit = 30;
  if ('count' in props) args.count = 30;
  if ('days' in props) args.days = 14;
  if ('date' in props) args.date = todayStr;
  if ('start_date' in props) args.start_date = startDate;
  if ('startDate' in props) args.startDate = startDate;
  if ('end_date' in props) args.end_date = todayStr;
  if ('endDate' in props) args.endDate = todayStr;
  return args;
}

function pickTool(tools: McpToolDescriptor[], patterns: RegExp[]): McpToolDescriptor | null {
  for (const pat of patterns) {
    const found = tools.find((t) => pat.test(t.name.toLowerCase()));
    if (found) return found;
  }
  return null;
}

/**
 * Compact, prompt-ready summary of every live Garmin metric synced for this athlete.
 * Only lists values that were actually measured (no placeholders).
 */
function buildLiveMetricsSummary(health: any, fitness: any, prs: any): string {
  const lines: string[] = [];
  const fmt = (sec: number) => {
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  };
  if (fitness?.vo2max != null) {
    lines.push(`- True VDOT (from verified race PRs): ${fitness.vo2max}${fitness.critical_speed_pace ? ` | Critical Speed: ${fitness.critical_speed_pace}` : ''}`);
  }
  if (Array.isArray(prs) && prs.length > 0) {
    lines.push(
      `- Verified running PRs: ${prs
        .filter((p: any) => p && p.label && Number(p.time_s) > 0)
        .map((p: any) => `${p.label} ${fmt(Number(p.time_s))} (${p.date ?? 'n/a'})`)
        .join(', ')}`
    );
  }
  const h = health ?? {};
  if (h.longest_run_m) lines.push(`- Longest Run PR: ${(h.longest_run_m / 1609.344).toFixed(2)} mi`);
  const gp = h.garmin_race_predictions;
  if (gp) {
    const parts = [
      gp.time_5k_s ? `5K ${fmt(gp.time_5k_s)}` : '',
      gp.time_10k_s ? `10K ${fmt(gp.time_10k_s)}` : '',
      gp.time_half_s ? `Half ${fmt(gp.time_half_s)}` : '',
      gp.time_marathon_s ? `Marathon ${fmt(gp.time_marathon_s)}` : '',
    ].filter(Boolean);
    if (parts.length) lines.push(`- Garmin Watch Race Predictions: ${parts.join(', ')}`);
  }
  const rd = h.readiness;
  if (rd && rd.score != null) {
    const f = rd.factors ?? {};
    lines.push(
      `- Training Readiness: ${rd.score}/100${rd.level ? ` (${rd.level})` : ''}${rd.feedback ? ` — ${rd.feedback}` : ''}${
        rd.recovery_hours != null ? ` | Recovery time remaining: ${rd.recovery_hours} h` : ''
      } | Factors: sleep ${f.sleep_score_pct ?? '—'}%, recovery ${f.recovery_pct ?? '—'}%, HRV ${f.hrv_pct ?? '—'}%, sleep history ${f.sleep_history_pct ?? '—'}%, stress history ${f.stress_history_pct ?? '—'}%, ACWR ${f.acwr_pct ?? '—'}%`
    );
  }
  if (h.lthr_bpm != null || h.running_ftp_w != null) {
    lines.push(
      `- Lactate Threshold: ${h.lthr_bpm != null ? `${h.lthr_bpm} bpm` : '—'} | Running FTP: ${
        h.running_ftp_w != null ? `${h.running_ftp_w} W` : '—'
      }${h.running_ftp_wkg != null ? ` (${h.running_ftp_wkg} W/kg)` : ''}`
    );
  }
  if (h.hrv_last_night != null) {
    lines.push(`- HRV: ${h.hrv_last_night} ms last night vs baseline ${h.hrv_baseline_low ?? '—'}–${h.hrv_baseline_high ?? '—'} ms (${h.hrv_status ?? '—'})`);
  }
  if (h.sleep_hours != null || h.sleep_score != null) {
    lines.push(`- Sleep: ${h.sleep_hours ?? '—'} h, score ${h.sleep_score ?? '—'}/100`);
  }
  if (h.spo2_avg != null || h.spo2_avg_sleep != null) {
    lines.push(`- SpO2: avg ${h.spo2_avg ?? '—'}%, sleep avg ${h.spo2_avg_sleep ?? '—'}%, latest ${h.spo2_latest ?? '—'}%`);
  }
  if (h.stress_avg != null) lines.push(`- Stress: avg ${h.stress_avg}, max ${h.stress_max ?? '—'}`);
  if (h.respiration_avg_sleep != null) {
    lines.push(`- Respiration: ${h.respiration_avg_sleep} brpm asleep, ${h.respiration_avg_waking ?? '—'} brpm awake`);
  }
  if (h.steps != null) lines.push(`- Steps today: ${h.steps}${h.step_goal ? ` / ${h.step_goal} goal` : ''}`);
  if (h.intensity_weekly_total != null) {
    lines.push(`- Intensity minutes this week: ${h.intensity_weekly_total}${h.intensity_week_goal ? ` / ${h.intensity_week_goal} goal` : ''}`);
  }
  if (h.fitness_age != null) lines.push(`- Fitness Age: ${h.fitness_age}`);
  return lines.length > 0 ? lines.join('\n') : '- No live Garmin metrics synced yet.';
}

// ── Express Application ────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '512kb' }));

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    gemini_configured: Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    ),
    garmlink_endpoint: GARMLINK_MCP_URL,
    server_time: new Date().toISOString(),
  });
});

// ── Race-Time Weather Forecast & Archive Proxy (Open-Meteo) ────────────────

app.get('/api/weather', async (req: Request, res: Response) => {
  const lat = Number(req.query.lat ?? 39.6079);
  const lon = Number(req.query.lon ?? -75.7369);
  const raceDateRaw = typeof req.query.date === 'string' ? req.query.date.trim() : '';
  const raceTimeRaw = typeof req.query.time === 'string' ? req.query.time.trim() : '08:00';

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    res.status(400).json({ error: 'Invalid latitude or longitude bounds.' });
    return;
  }

  if (raceDateRaw && !/^\d{4}-\d{2}-\d{2}$/.test(raceDateRaw)) {
    res.status(400).json({ error: 'date must be formatted as YYYY-MM-DD.' });
    return;
  }

  const timeMatch = raceTimeRaw.match(/^(\d{1,2}):(\d{2})$/);
  const targetHour = timeMatch
    ? Math.max(0, Math.min(23, Number(timeMatch[1])))
    : 8;
  const targetMin = timeMatch ? Math.max(0, Math.min(59, Number(timeMatch[2]))) : 0;
  const roundedHour = targetMin >= 30 ? Math.min(23, targetHour + 1) : targetHour;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    // Case A: No date specified -> fetch live current conditions
    if (!raceDateRaw) {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.searchParams.set('latitude', lat.toFixed(4));
      url.searchParams.set('longitude', lon.toFixed(4));
      url.searchParams.set(
        'current',
        'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code'
      );
      url.searchParams.set('temperature_unit', 'fahrenheit');
      url.searchParams.set('wind_speed_unit', 'mph');
      url.searchParams.set('timezone', 'auto');

      const upstream = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timeout);
      if (!upstream.ok) {
        res.status(502).json({ error: `Open-Meteo returned HTTP ${upstream.status}` });
        return;
      }

      const data = (await upstream.json()) as {
        timezone_abbreviation?: string;
        current?: {
          time?: string;
          temperature_2m?: number;
          relative_humidity_2m?: number;
          wind_speed_10m?: number;
          wind_direction_10m?: number;
          weather_code?: number;
        };
      };
      const cur = data.current ?? {};
      const code = Number(cur.weather_code ?? 0);
      const deg = cur.wind_direction_10m != null ? Math.round(Number(cur.wind_direction_10m)) : null;

      res.json({
        temp_f: Math.round(Number(cur.temperature_2m ?? 50)),
        humidity: Math.round(Number(cur.relative_humidity_2m ?? 50)),
        wind_mph: Math.round(Number(cur.wind_speed_10m ?? 0)),
        wind_deg: deg,
        wind_compass: degreesToCompass(deg),
        weather_code: code,
        condition_label: describeWmoWeather(code),
        target_datetime: cur.time ?? new Date().toISOString().slice(0, 16),
        timezone_abbr: data.timezone_abbreviation ?? 'Local',
        source: 'current',
      });
      return;
    }

    // Case B: Specific race date & start time requested
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    const requestedDate = new Date(`${raceDateRaw}T00:00:00Z`);
    const diffDays = Math.round((requestedDate.getTime() - todayUtc.getTime()) / 86400000);

    let queryDate = raceDateRaw;
    let useArchive = false;
    let source: 'hourly_forecast' | 'historical_actual' | 'historical_reference' = 'hourly_forecast';
    let note: string | undefined;

    if (diffDays < 0) {
      useArchive = true;
      source = 'historical_actual';
      note = 'Historical recorded weather for this past race date and time.';
    } else if (diffDays > 15) {
      useArchive = true;
      source = 'historical_reference';
      const refYear = requestedDate.getUTCFullYear() - 1;
      queryDate = `${refYear}-${raceDateRaw.slice(5)}`;
      note = `Race is ${diffDays} days away (beyond 16-day forecast range). Showing historical weather from ${queryDate} as a seasonal reference.`;
    }

    const baseUrl = useArchive
      ? 'https://archive-api.open-meteo.com/v1/archive'
      : 'https://api.open-meteo.com/v1/forecast';

    const url = new URL(baseUrl);
    url.searchParams.set('latitude', lat.toFixed(4));
    url.searchParams.set('longitude', lon.toFixed(4));
    url.searchParams.set('start_date', queryDate);
    url.searchParams.set('end_date', queryDate);
    url.searchParams.set(
      'hourly',
      'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code'
    );
    url.searchParams.set('temperature_unit', 'fahrenheit');
    url.searchParams.set('wind_speed_unit', 'mph');
    url.searchParams.set('timezone', 'auto');

    const upstream = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);
    if (!upstream.ok) {
      res.status(502).json({ error: `Open-Meteo returned HTTP ${upstream.status}` });
      return;
    }

    const data = (await upstream.json()) as {
      timezone_abbreviation?: string;
      hourly?: {
        time?: string[];
        temperature_2m?: number[];
        relative_humidity_2m?: number[];
        wind_speed_10m?: number[];
        wind_direction_10m?: number[];
        weather_code?: number[];
      };
    };

    const hourly = data.hourly;
    const times = hourly?.time ?? [];
    if (times.length === 0) {
      res.status(404).json({ error: 'No hourly weather data available for the selected date.' });
      return;
    }

    const targetHourStr = `${queryDate}T${String(roundedHour).padStart(2, '0')}:00`;
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
      target_datetime: `${raceDateRaw} ${String(targetHour).padStart(2, '0')}:${String(targetMin).padStart(2, '0')}`,
      timezone_abbr: data.timezone_abbreviation ?? 'Local',
      source,
      note,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Weather lookup failed';
    res.status(502).json({ error: `Weather unavailable: ${message}` });
  }
});

// ── Garmlink MCP OAuth 2.1 + PKCE + Sync Routes ────────────────────────────

app.post('/api/garmlink/oauth/start', async (req: Request, res: Response) => {
  try {
    const clientOrigin =
      typeof (req.body as Record<string, unknown>)?.origin === 'string'
        ? String((req.body as Record<string, unknown>).origin)
        : undefined;
    const baseOrigin = resolveAllowedOrigin(clientOrigin);
    const redirectUri = `${baseOrigin}/api/garmlink/oauth/callback`;

    // Clean stale pending states (> 15 min) and completed handoffs (> 3 min)
    const now = Date.now();
    for (const [k, v] of pendingOAuthStates.entries()) {
      if (now - v.created_at > 15 * 60 * 1000) pendingOAuthStates.delete(k);
    }
    for (const [k, v] of completedOAuthFlows.entries()) {
      if (now - v.completed_at > 3 * 60 * 1000) completedOAuthFlows.delete(k);
    }

    // Dynamically register a public PKCE OAuth client with Garmlink if not cached
    let client = registeredClientsByRedirect.get(redirectUri);
    if (!client) {
      const regRes = await fetch(GARMLINK_REGISTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'RaceKit Running Coach',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: 'openid profile email offline_access',
        }),
      });
      if (!regRes.ok) {
        const errText = await regRes.text();
        res.status(502).json({
          error: `Garmlink OAuth registration failed (HTTP ${regRes.status}): ${errText.slice(0, 180)}`,
        });
        return;
      }
      const regData = (await regRes.json()) as { client_id?: string };
      if (!regData.client_id) {
        res.status(502).json({ error: 'Garmlink OAuth registration did not return a client_id.' });
        return;
      }
      client = { client_id: regData.client_id, redirect_uri: redirectUri };
      registeredClientsByRedirect.set(redirectUri, client);
    }

    const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
    const codeChallenge = base64UrlEncode(
      crypto.createHash('sha256').update(codeVerifier).digest()
    );
    const state = crypto.randomBytes(24).toString('hex');
    const pollToken = crypto.randomBytes(32).toString('hex');

    pendingOAuthStates.set(state, {
      code_verifier: codeVerifier,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      poll_token_hash: sha256Hex(pollToken),
      created_at: now,
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      resource: GARMLINK_MCP_URL,
    });

    res.json({
      auth_url: `${GARMLINK_AUTHORIZE_URL}?${params.toString()}`,
      redirect_uri: redirectUri,
      state,
      poll_token: pollToken,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to initialize Garmlink OAuth';
    res.status(500).json({ error: message });
  }
});

const handleGarmlinkCallback = async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const oauthError = typeof req.query.error === 'string' ? req.query.error : '';
  const oauthErrorDesc =
    typeof req.query.error_description === 'string' ? req.query.error_description : '';

  const renderPopupResult = (
    payload: Record<string, unknown>,
    heading: string,
    bodyText: string,
    targetOrigin = '*'
  ) => {
    const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c');
    const safeTargetOrigin = JSON.stringify(targetOrigin).replace(/</g, '\\u003c');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>RaceKit · Garmlink MCP</title></head>
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

  const pending = state ? pendingOAuthStates.get(state) : undefined;
  let callbackOrigin = '*';
  if (pending) {
    try {
      callbackOrigin = new URL(pending.redirect_uri).origin;
    } catch {
      callbackOrigin = '*';
    }
  }

  if (oauthError) {
    if (pending) {
      pendingOAuthStates.delete(state);
      completedOAuthFlows.set(state, {
        poll_token_hash: pending.poll_token_hash,
        status: 'error',
        error: oauthErrorDesc || oauthError,
        completed_at: Date.now(),
      });
    }
    renderPopupResult(
      { type: 'GARMLINK_OAUTH_ERROR', error: oauthErrorDesc || oauthError },
      'Garmlink Connection Cancelled',
      oauthErrorDesc || oauthError,
      callbackOrigin
    );
    return;
  }

  if (!code || !state || !pending) {
    renderPopupResult(
      { type: 'GARMLINK_OAUTH_ERROR', error: 'Invalid or expired OAuth state. Please try connecting again.' },
      'Session Expired',
      'Invalid or expired OAuth state. Close this window and click Connect Garmlink MCP again.'
    );
    return;
  }
  pendingOAuthStates.delete(state);

  try {
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirect_uri,
      client_id: pending.client_id,
      code_verifier: pending.code_verifier,
      resource: GARMLINK_MCP_URL,
    });

    const tokenRes = await fetch(GARMLINK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!tokenRes.ok || !tokenData.access_token) {
      const errMsg = tokenData.error_description || tokenData.error || 'Token exchange failed.';
      completedOAuthFlows.set(state, {
        poll_token_hash: pending.poll_token_hash,
        status: 'error',
        error: errMsg,
        completed_at: Date.now(),
      });
      renderPopupResult(
        { type: 'GARMLINK_OAUTH_ERROR', error: errMsg },
        'Garmlink Authorization Failed',
        errMsg,
        callbackOrigin
      );
      return;
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    garmlinkSessions.set(sessionToken, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
      client_id: pending.client_id,
      tools_discovered: [],
      created_at: Date.now(),
    });
    persistGarmlinkSessions();

    // Store one-time claimable handoff so RaceKit syncs automatically even when COOP severs window.opener
    completedOAuthFlows.set(state, {
      poll_token_hash: pending.poll_token_hash,
      status: 'completed',
      sessionToken,
      completed_at: Date.now(),
    });

    setGarmlinkSessionCookie(req, res, sessionToken);

    renderPopupResult(
      { type: 'GARMLINK_OAUTH_SUCCESS', sessionToken },
      'Garmlink MCP Connected',
      'Authorization succeeded! RaceKit is automatically syncing your watch data now. You can close this window if it does not close automatically.',
      callbackOrigin
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OAuth callback error';
    completedOAuthFlows.set(state, {
      poll_token_hash: pending.poll_token_hash,
      status: 'error',
      error: message,
      completed_at: Date.now(),
    });
    renderPopupResult(
      { type: 'GARMLINK_OAUTH_ERROR', error: message },
      'Connection Error',
      message,
      callbackOrigin
    );
  }
};

app.get(['/api/garmlink/oauth/callback', '/api/garmlink/oauth/callback/'], handleGarmlinkCallback);

// One-time COOP-resilient handoff endpoint so the main RaceKit window receives the session
// even when api.garmlink.ai's Cross-Origin-Opener-Policy severs window.opener.
app.post('/api/garmlink/oauth/poll', (req: Request, res: Response) => {
  const { state, poll_token } = req.body as { state?: string; poll_token?: string };
  if (!state || typeof state !== 'string' || !poll_token || typeof poll_token !== 'string') {
    res.status(400).json({ status: 'error', error: 'Missing state or poll_token.' });
    return;
  }

  const presentedHash = sha256Hex(poll_token);

  const completed = completedOAuthFlows.get(state);
  if (completed) {
    if (!timingSafeHexEqual(completed.poll_token_hash, presentedHash)) {
      res.status(403).json({ status: 'error', error: 'Invalid poll token.' });
      return;
    }
    completedOAuthFlows.delete(state);
    if (completed.status === 'completed' && completed.sessionToken) {
      setGarmlinkSessionCookie(req, res, completed.sessionToken);
      res.json({ status: 'completed', sessionToken: completed.sessionToken });
      return;
    }
    res.json({ status: 'error', error: completed.error || 'Garmlink authorization failed.' });
    return;
  }

  const pending = pendingOAuthStates.get(state);
  if (pending) {
    if (!timingSafeHexEqual(pending.poll_token_hash, presentedHash)) {
      res.status(403).json({ status: 'error', error: 'Invalid poll token.' });
      return;
    }
    res.json({ status: 'pending' });
    return;
  }

  res.json({ status: 'expired' });
});

// Per-user Garmlink linking configuration (in-memory per user_id)
const userGarmlinkConfigs = new Map<string, { apiKey?: string; accessToken?: string; connectedAt: string }>();

app.post('/api/user/garmlink-config', (req: Request, res: Response) => {
  const { user_id, api_key, access_token } = req.body as { user_id?: string; api_key?: string; access_token?: string };
  if (!user_id) {
    res.status(400).json({ ok: false, error: 'Missing user_id' });
    return;
  }
  userGarmlinkConfigs.set(user_id, {
    apiKey: api_key?.trim() || undefined,
    accessToken: access_token?.trim() || undefined,
    connectedAt: new Date().toISOString(),
  });
  res.json({ ok: true, connected: Boolean(api_key || access_token) });
});

app.get('/api/user/garmlink-config', (req: Request, res: Response) => {
  const userId = (req.query.user_id as string) || (req.headers['x-user-id'] as string);
  if (!userId || !userGarmlinkConfigs.has(userId)) {
    res.json({ connected: false });
    return;
  }
  const cfg = userGarmlinkConfigs.get(userId)!;
  res.json({ connected: true, configured_at: cfg.connectedAt });
});

app.get('/api/garmlink/status', (req: Request, res: Response) => {
  const { session, accessToken } = getActiveGarmlinkAccessToken(req);
  const isOwn = isOwner(req);
  const localTools = discoverLocalMcpTools();
  const hasLocalDb = isOwn && fs.existsSync('/home/ephraimyourek98/racekit/data/racekit.db');
  const isConnected = Boolean(accessToken || hasLocalDb);

  const discoveredToolNames = session?.tools_discovered && session.tools_discovered.length > 0
    ? session.tools_discovered.map((t) => t.name)
    : (isConnected ? localTools.map((t) => t.name) : []);

  res.json({
    connected: isConnected && discoveredToolNames.length > 0,
    is_owner: isOwn,
    endpoint: GARMLINK_MCP_URL,
    tools_count: discoveredToolNames.length,
    tools_discovered: discoveredToolNames,
  });
});

app.post('/api/owner/verify-passcode', (req: Request, res: Response) => {
  const { passcode } = req.body as { passcode?: string };
  if (passcode && passcode.trim() === OWNER_PASSCODE) {
    res.json({ ok: true, is_owner: true });
  } else {
    res.status(401).json({ ok: false, error: 'Incorrect owner passcode.' });
  }
});

app.post('/api/garmlink/disconnect', (req: Request, res: Response) => {
  const key = getBearerSessionToken(req);
  if (key && garmlinkSessions.delete(key)) persistGarmlinkSessions();
  setGarmlinkSessionCookie(req, res, null);
  res.json({ ok: true });
});

app.post('/api/garmlink/sync', async (req: Request, res: Response) => {
  try {
    const isOwn = isOwner(req);
    const { session, accessToken } = getActiveGarmlinkAccessToken(req);
    console.log(`[Garmlink MCP] /api/garmlink/sync called. isOwn: ${isOwn}, hasToken: ${Boolean(accessToken)}`);

    if (!accessToken) {
      // A bearer token that no longer maps to a session means the live Garmlink link was lost
      // (e.g. server restart before sessions were persisted). Surface it instead of hiding it.
      const staleSession = Boolean(getBearerSessionToken(req));
      const liveOnlyWarning =
        (staleSession ? 'Your live Garmlink session expired. ' : 'Garmlink is not connected live. ') +
        'This sync came from the local Garmin cache, which has no Training Readiness, SpO2, race predictions, ' +
        'lactate threshold, zones, fitness age or daily rollup. Click Connect Garmlink to pull them live.';
      // Supply verified Garmin athlete telemetry if owner or local bridge exists
      if (isOwn) {
        const localData = getLocalGarminBridgeData('sync');
        if (localData) {
          const tools = localData.tools_discovered && localData.tools_discovered.length > 0
            ? localData.tools_discovered
            : discoverLocalMcpTools().map((t) => t.name);
          console.log(`[Garmlink MCP] Sync successful: ${localData.activities?.length ?? 0} activities, ${tools.length} MCP tools discovered.`);
          res.json({
            activities: localData.activities,
            prs: localData.prs,
            gear: localData.gear,
            health: localData.health,
            health_history: localData.health_history,
            device: localData.device,
            tools_discovered: tools,
            tools_called: localData.tools_called,
            warnings: [liveOnlyWarning],
            sync_source: 'local_bridge',
            session_expired: staleSession,
            synced_at: new Date().toISOString(),
          });
          return;
        }
      }

      // Guest / Friend / Family mode: clean slate without owner data
      res.json({
        activities: [],
        prs: [],
        gear: [],
        health: null,
        health_history: [],
        device: null,
        tools_discovered: [],
        tools_called: [],
        warnings: isOwn ? [] : ['Guest mode: Connect your own Garmin watch or unlock Owner Sync in Settings.'],
        sync_source: 'none',
        session_expired: staleSession,
        synced_at: new Date().toISOString(),
      });
      return;
    }

    const validToken = session ? await refreshGarmlinkSessionIfNeeded(session) : accessToken;
    const { mcpSessionId, tools } = await openGarmlinkMcpSession(validToken);

    if (session) {
      session.tools_discovered = tools;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const toolsCalled: string[] = [];
    const warnings: string[] = [];

    const activitiesTool = pickTool(tools, [
      /activities_list/,
      /list_activities/,
      /get_activities/,
      /recent_activities/,
      /activities/,
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
      /resting_heart/,
    ]);
    const trainingTool = pickTool(tools, [
      /training_status/,
      /training_readiness/,
      /training_load/,
      /vo2/,
    ]);

    const callSafely = async (
      label: string,
      tool: McpToolDescriptor | null,
      rpcId: number,
      overrides: Record<string, unknown> = {}
    ) => {
      if (!tool) return null;
      toolsCalled.push(tool.name);
      try {
        const props = ((tool.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {};
        const args = buildSmartToolArgs(tool, todayStr);
        for (const [k, v] of Object.entries(overrides)) {
          if (k in props) args[k] = v;
        }
        return await callGarmlinkMcpTool(validToken, mcpSessionId, tool.name, args, rpcId);
      } catch (err) {
        warnings.push(`${label} (${tool.name}): ${err instanceof Error ? err.message : 'failed'}`);
        return null;
      }
    };

    const exact = (suffix: string) => pickTool(tools, [new RegExp(`${suffix}$`)]);
    const recentDays = { limit: 7 };
    const latestSnapshot = { limit: 3 };
    // 60 nights so the 30-day Sleep + HRV charts are fully covered (Oct → today), not just ~2 weeks
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
      fitnessAgeRaw,
    ] = await Promise.all([
      // Full activity history (Garmlink max page size is 200)
      callSafely('Activities', activitiesTool, 10, { limit: 200 }),
      callSafely('PRs', prTool, 11, latestSnapshot),
      callSafely('HRV', hrvTool, 12, chartWindow),
      callSafely('Sleep', sleepTool, 13, chartWindow),
      callSafely('Body Battery', batteryTool, 14),
      callSafely('Daily Summary', summaryTool, 15, chartWindow),
      callSafely('Training Status', trainingTool, 16),
      callSafely('Training Readiness', exact('readiness_get'), 17, recentDays),
      callSafely('Race Predictions', exact('race_predictions_get'), 18, latestSnapshot),
      callSafely('VO2max History', exact('vo2max_history'), 19, latestSnapshot),
      callSafely('SpO2', exact('spo2_get'), 20, recentDays),
      callSafely('Stress', exact('stress_get'), 21, recentDays),
      callSafely('Respiration', exact('respiration_get'), 22, recentDays),
      callSafely('Steps', exact('steps_get'), 23, recentDays),
      callSafely('Floors', exact('floors_get'), 24, recentDays),
      callSafely('Intensity Minutes', exact('intensity_minutes_get'), 25, recentDays),
      callSafely('Lactate Threshold', exact('lactate_threshold_get'), 26, latestSnapshot),
      callSafely('Zones', exact('zones_get'), 27),
      callSafely('Fitness Age', exact('fitness_age_get'), 28, latestSnapshot),
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
      fitnessAgeRaw,
    });

    // Merge extended metrics onto the core snapshot. Extras only fill gaps for core sleep fields
    // (so unworn nights stay empty) but are authoritative for their own dedicated endpoints.
    let health = coreHealth;
    const hasExtras = Object.keys(extras).length > 0 || vo2max_running != null;
    if (!health && hasExtras) {
      health = {
        date: todayStr,
        vo2max: null,
        hrv_last_night: null,
        hrv_weekly_avg: null,
        hrv_status: 'BALANCED',
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
        source: 'garmlink_mcp',
        synced_at: new Date().toISOString(),
      };
    }
    if (health) {
      const merged: Record<string, unknown> = { ...health };
      for (const [k, v] of Object.entries(extras)) {
        if (v === null || v === undefined) continue;
        const gapFillOnly = k.startsWith('sleep_') || k.endsWith('_min');
        if (gapFillOnly && merged[k] != null) continue;
        merged[k] = v;
      }
      // Running VO2max from garmlink_vo2max_history is authoritative over the generic deep search
      if (vo2max_running != null) merged.vo2max = vo2max_running;
      health = merged as unknown as typeof health;
    }

    const healthHistory = buildGarmlinkHealthHistory({ sleepRaw, hrvRaw, summaryRaw });
    console.log(
      `[Garmlink MCP] Live sync: ${activities.length} activities, ${healthHistory.length} history days, ` +
        `${toolsCalled.length} tools called, ${warnings.length} warnings.`
    );

    res.json({
      activities,
      prs,
      health,
      health_history: healthHistory,
      sync_source: 'garmlink_live',
      tools_discovered: tools.map((t) => t.name),
      tools_called: toolsCalled,
      warnings,
      synced_at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Garmlink MCP sync failed';
    const status = message.includes('authorization expired') || message.includes('Not connected') ? 401 : 502;
    res.status(status).json({ error: message });
  }
});

app.get('/api/garmlink/activities', (req: Request, res: Response) => {
  if (!isOwner(req)) {
    res.json([]);
    return;
  }
  const localData = getLocalGarminBridgeData('activities');
  res.json(localData ?? DEFAULT_GARMLINK_ACTIVITIES);
});

app.get('/api/garmlink/health', (req: Request, res: Response) => {
  if (!isOwner(req)) {
    res.json([]);
    return;
  }
  const localData = getLocalGarminBridgeData('health');
  res.json(localData ?? [DEFAULT_GARMLINK_HEALTH]);
});

app.get('/api/garmlink/prs', (req: Request, res: Response) => {
  if (!isOwner(req)) {
    res.json([]);
    return;
  }
  const localData = getLocalGarminBridgeData('prs');
  res.json(localData ?? VERIFIED_PR_EFFORTS);
});

app.get('/api/garmlink/gear', (req: Request, res: Response) => {
  if (!isOwner(req)) {
    res.json([]);
    return;
  }
  const localData = getLocalGarminBridgeData('gear');
  res.json(localData ?? []);
});

// ── Direct Download Endpoints for Athlete Exports ─────────────────────────
app.get('/api/download/:file', (req: Request, res: Response) => {
  const allowed = [
    'racekit-training-calendar.ics',
    'racekit-5k-race-day.tcx',
    'racekit-telemetry-dossier.json',
    'racekit-source-bundle.zip',
    'RACEKIT_FULL_CODEBASE_FOR_FABLE.md',
    'RACEKIT_FULL_CODEBASE_FOR_FABLE.txt',
    'racekit-fable-package.zip',
  ];
  const file = req.params.file;
  if (!allowed.includes(file)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  const filePath = path.join(
    '/home/ephraimyourek98/.gemini/antigravity/brain/b3cb27ab-c4eb-436b-8dca-0316cac7161f/downloads',
    file
  );
  if (fs.existsSync(filePath)) {
    res.download(filePath, file);
  } else {
    res.status(404).json({ error: 'File not found on disk' });
  }
});

// ── Gemini AI Full 7-Day Training Plan Generator ───────────────────────────

app.post('/api/ai/generate-plan', async (req: Request, res: Response) => {
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
      prs,
    } = req.body as Record<string, unknown>;

    const zoneObj = (zones as Record<string, { min_pace?: string; max_pace?: string; label?: string }> | undefined) ?? {};
    const easyZone = zoneObj.easy;
    const easyPaceFormatted =
      easyZone && easyZone.min_pace && easyZone.max_pace
        ? `${easyZone.max_pace}–${easyZone.min_pace}/mi`
        : easyZone?.label ?? '7:40–8:15/mi';

    const safeZones: TrainingZones = {
      recovery: (zones as any)?.recovery?.label ? (zones as any).recovery : { pace_s: 540, label: '8:45–9:15/mi' },
      easy: (zones as any)?.easy?.label ? (zones as any).easy : { pace_s: 480, label: easyPaceFormatted },
      marathon: (zones as any)?.marathon?.label ? (zones as any).marathon : { pace_s: 420, label: '6:50–7:10/mi' },
      threshold: (zones as any)?.threshold?.label ? (zones as any).threshold : { pace_s: 385, label: '6:20–6:35/mi' },
      interval: (zones as any)?.interval?.label ? (zones as any).interval : { pace_s: 360, label: '5:50–6:05/mi' },
      repetition: (zones as any)?.repetition?.label ? (zones as any).repetition : { pace_s: 330, label: '5:15–5:30/mi' },
      rep_400m: (zones as any)?.rep_400m ?? '78–82s',
    };

    const systemInstruction = `You are an elite collegiate middle-distance & cross-country running coach inside RaceKit.
Build a complete, scientifically sound 7-day running training plan (Monday through Sunday) tailored to the athlete's ACTUAL synced Garmin watch data, verified PRs, Critical Speed, and VDOT pace zones.

Coaching Rules:
- Only reference watch activities or health metrics that are actually present in the context. Never invent past workouts or fake HRV/sleep numbers if watch data has not been synced yet.
- Respect the athlete's real recent weekly mileage and longest run so volume progression stays safe (avoid sudden >15% weekly spikes).
- Enforce strict Zone 2 aerobic discipline on easy days (< 145 bpm) to build mitochondrial/capillary base without sympathetic overload.
- If a target race is specified on a day of the week, build a proper race-week taper around that race day.
- STRICT EASY / RECOVERY PACE GUARDRAIL: Easy runs, aerobic base runs, recovery runs, and long runs MUST be constrained strictly to the athlete's calculated VDOT Easy pace zone (${easyPaceFormatted} or ~7:30–8:15/mi). NEVER prescribe easy, recovery, or base runs faster than 7:20/mi (e.g. 6:30/mi or 6:45/mi are strictly forbidden for easy runs as that is threshold/tempo pace for this athlete).
- REST-DAY CAP: Schedule exactly 1 rest day per week by default. Hard maximum of 2. NEVER schedule 3 or more rest days unless the CUSTOM ATHLETE INSTRUCTIONS explicitly ask for that many. Even with low Training Readiness / HRV or a mid-week race, use short Zone 1–2 recovery shakeouts (2–3 mi, workout_type "recovery") instead of extra rest days, and keep total weekly mileage reasonably close to the athlete's recent weekly volume.
- WORKOUT VARIETY: Do not default to the same two sessions every week. Pick the quality days from this library, choosing different types from each other and suited to the focus: Threshold Cruise Intervals (4–5x1K or 3–4x1 mi @ T); Continuous Tempo Run (15–25 min @ T); VO2max Track Intervals (5x800m, 6x600m, 4x1000m or 8x400m @ I); Speed / Repetitions (10x200m or 6x300m with full recovery); Fartlek (1-2-3-2-1 min ladder or 8x2 min hard / 1 min float); Hill Repeats (6–8x45–60s uphill); Progression Run (easy → steady → threshold finish); Long Run w/ Fast Finish; Easy Aerobic + Strides (4–6x100m); Pre-Race Shakeout + Strides and Post-Race Recovery around any race.
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

SELECTED FOCUS: ${String(focus_label ?? focus_id ?? 'Track Mid-Distance')}
CUSTOM ATHLETE INSTRUCTIONS: ${String(custom_goal ?? 'None provided')}
TARGET RACE: ${JSON.stringify(target_race ?? null)}

ATHLETE FITNESS & VDOT ZONES:
${JSON.stringify({ fitness, zones }, null, 2)}

LIVE GARMIN METRICS (readiness, PRs, Garmin predictions, LT, SpO2, stress, HRV, sleep):
${buildLiveMetricsSummary(health, fitness, prs)}

SYNCED WATCH HEALTH SNAPSHOT (null if not yet synced):
${JSON.stringify(health ?? null, null, 2)}

SYNCED RECENT WATCH ACTIVITIES (empty if not yet synced):
${JSON.stringify(Array.isArray(activities) ? activities.slice(0, 14) : [], null, 2)}`;

    let rawText = '';
    let usedModel = '';

    // 1. Try Groq FIRST (ultra-fast ~1s generation with llama-3.3-70b-versatile / qwen)
    try {
      const groqRes = await callGroqChat(
        [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt },
        ],
        { timeoutMs: 8000, jsonMode: true }
      );
      if (groqRes && groqRes.text) {
        rawText = groqRes.text.trim();
        usedModel = groqRes.modelUsed;
      }
    } catch (groqErr) {
      console.warn('[AI Plan] Primary Groq call failed, trying backup chain:', groqErr);
    }

    // 2. Fall back to Gemini/Gemma backup chain if Groq was unavailable
    if (!rawText) {
      try {
        const ai = getGeminiClient();
        const { response, modelUsed } = await generateWithRetry(
          ai,
          {
            contents: prompt,
            config: {
              systemInstruction,
            },
          },
          undefined,
          8000
        );
        rawText = (response.text ?? '').trim();
        usedModel = modelUsed;
      } catch (geminiErr) {
        console.warn('[AI Plan] All Gemini/Gemma backup models failed or timed out:', geminiErr);
      }
    }

    let parsed: {
      title?: string;
      target_race?: string;
      aerobic_deficit_focus?: string;
      schedule?: Array<{
        day: string;
        name: string;
        workout_type: 'easy' | 'workout' | 'long_run' | 'recovery' | 'rest' | 'race';
        distance_miles: number;
        warmup_miles?: number;
        main_miles?: number;
        cooldown_miles?: number;
        pace_target: string;
        hr_cap: string;
        description: string;
        injury_prevention_note: string;
      }>;
    } | null = null;

    if (rawText) {
      try {
        const cleaned = extractJsonFromText(rawText);
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        console.warn('[AI Plan] JSON parse failed, falling back to deterministic engine:', parseErr);
      }
    }

    // 3. Fall back to local deterministic training plan engine (never throw 429/500/503 to frontend)
    if (!parsed || !Array.isArray(parsed.schedule) || parsed.schedule.length !== 7) {
      console.log('[AI Plan] Falling back to deterministic local training plan engine');
      const safeFocus = (focus_id as TrainingFocusId) || 'track_mid';
      const fallbackPlan = generateTrainingPlan(
        safeFocus,
        safeZones,
        target_race as { name: string; dist: string; day: string } | null
      );

      const guardedSchedule = applyPlanGuardrails(
        fallbackPlan.schedule,
        health,
        target_race as any,
        easyPaceFormatted
      );
      const totalWeekly = Number(
        guardedSchedule.reduce((acc, w) => acc + (w.distance_miles || 0), 0).toFixed(1)
      );

      res.json({
        plan: {
          ...fallbackPlan,
          weekly_mileage: totalWeekly,
          schedule: guardedSchedule,
          ai_generated: true,
          generated_at: new Date().toISOString(),
          model_used: 'local-engine',
          source: 'local-engine',
        },
      });
      return;
    }

    let rawSchedule = (parsed.schedule ?? []).map((w) => {
      let paceTarget = w.pace_target || '';
      const isBaseOrRecovery =
        w.workout_type === 'easy' ||
        w.workout_type === 'recovery' ||
        w.workout_type === 'long_run';
      // Sanitize unrealistic fast paces for easy/recovery runs (e.g. 6:xx or faster than 7:20)
      if (
        isBaseOrRecovery &&
        (/\b6:[0-5][0-9]\b/.test(paceTarget) ||
          /\b7:0[0-9]\b/.test(paceTarget) ||
          /\b7:1[0-9]\b/.test(paceTarget))
      ) {
        paceTarget = easyPaceFormatted;
      }
      return {
        ...w,
        pace_target: paceTarget,
        ai_generated: true,
      };
    });

    // Enforce pre-race taper rules, auto-rest on poor recovery, and strict mileage summation
    const guardedSchedule = applyPlanGuardrails(
      rawSchedule,
      health,
      target_race as any,
      easyPaceFormatted
    );

    // The client caps automatic rest days at 2/week. If the athlete explicitly asked for 3+ rest days,
    // tag them as requested so the cap leaves them alone.
    if (/\b(3|three|4|four)\s+(full\s+|complete\s+)?(rest|off)\s+days?\b/i.test(String(custom_goal ?? ''))) {
      for (const w of guardedSchedule as Array<{ workout_type: string; adaptation_reason?: string }>) {
        if (w.workout_type === 'rest' && !w.adaptation_reason) {
          w.adaptation_reason = 'Rest day requested by athlete.';
        }
      }
    }

    const weeklyMileage = Number(
      guardedSchedule.reduce((acc, w) => acc + (w.distance_miles || 0), 0).toFixed(1)
    );

    res.json({
      plan: {
        focus_id: String(focus_id ?? 'track_mid'),
        title: parsed.title || 'Custom 7-Day Training Plan',
        target_race: parsed.target_race || 'Season Preparation',
        weekly_mileage: weeklyMileage,
        aerobic_deficit_focus: parsed.aerobic_deficit_focus || 'Aerobic base conditioning',
        schedule: guardedSchedule,
        ai_generated: true,
        generated_at: new Date().toISOString(),
        model_used: usedModel || 'local-engine',
        source: usedModel ? undefined : 'local-engine',
      },
    });
  } catch (outerErr) {
    console.error('[AI Plan] Unexpected error, returning deterministic fallback:', outerErr);
    const safeFocus = ((req.body?.focus_id as TrainingFocusId) || 'track_mid');
    const fallbackPlan = generateTrainingPlan(
      safeFocus,
      {
        recovery: { pace_s: 540, label: '8:45–9:15/mi' },
        easy: { pace_s: 480, label: '7:40–8:15/mi' },
        marathon: { pace_s: 420, label: '6:50–7:10/mi' },
        threshold: { pace_s: 385, label: '6:20–6:35/mi' },
        interval: { pace_s: 360, label: '5:50–6:05/mi' },
        repetition: { pace_s: 330, label: '5:15–5:30/mi' },
        rep_400m: '78–82s',
      },
      (req.body?.target_race as any) ?? null
    );
    res.json({
      plan: {
        ...fallbackPlan,
        ai_generated: true,
        generated_at: new Date().toISOString(),
        model_used: 'local-engine',
        source: 'local-engine',
      },
    });
  }
});

// ── Gemini AI Single Workout Generator ─────────────────────────────────────

app.post('/api/ai/generate-workout', async (req: Request, res: Response) => {
  try {
    const ai = getGeminiClient();
    const { day, goal_prompt, activities, health, fitness, zones, current_plan, prs } =
      req.body as Record<string, unknown>;

    if (!goal_prompt || typeof goal_prompt !== 'string' || !goal_prompt.trim()) {
      res.status(400).json({ error: 'Describe the workout you want Gemini to build.' });
      return;
    }

    const systemInstruction = `You are an elite running coach inside RaceKit.
Create a single, concrete, watch-ready running workout for the requested day based on the athlete's real synced watch data, VDOT pace zones, and Critical Speed.
Never fabricate watch history if activities/health are empty. Include exact warm-up, main set paces, rest intervals, cooldown, HR cap, and an injury-prevention cue.

CRITICAL DIRECTIVE ON USER INTENT:
If the user's request asks for a RACE, TIME TRIAL, or SPECIFIC WORKOUT (e.g. "run for pie 5k", "3.1 mile race", "5K race", "tempo", "intervals", "long run"):
1. ALWAYS create that exact requested workout or race.
2. For races (e.g. "run for pie 5k", "5K race", "3.1 mile race"), workout_type MUST be "race", distance_miles MUST be 3.1 (or requested distance), name MUST reflect the race name (e.g. "Run for Pie 5K — Race Day"), pace_target MUST be the target race pace (e.g. 5:58–6:05/mi), and description MUST include race-day warm-up, race execution, and cooldown.
3. NEVER override an explicit user-requested future race or workout with a "Recovery Shakeout" or "Easy Run" just because today's HRV is low. Today's recovery metrics apply to today, not future race days!`;

    const zoneSummary = zones
      ? `VDOT: ${(fitness as any)?.vo2max ?? 'unknown'} | Easy: ${(zones as any).easy?.label ?? (zones as any).easy ?? '—'} | Threshold: ${(zones as any).threshold?.label ?? (zones as any).threshold ?? '—'} | Interval: ${(zones as any).interval?.label ?? (zones as any).interval ?? '—'}`
      : 'VDOT: 54.6 | Easy: 7:40–8:15/mi';
    const recoverySummary = health
      ? `HRV: ${(health as any).hrv_last_night ?? 32}ms (${(health as any).hrv_status ?? 'LOW'}), Sleep: ${(health as any).sleep_hours ?? 6.5}h, Battery: ${(health as any).body_battery ?? 55}`
      : 'HRV: 32ms (LOW), Sleep: 6.5h, Battery: 55';
    const targetRaceStr = (current_plan as any)?.target_race?.name
      ? `${(current_plan as any).target_race.name} (${(current_plan as any).target_race.dist}) on ${(current_plan as any).target_race.day}`
      : 'None';

    const prompt = `Build a single watch-ready workout for ${String(day ?? 'Today')}.
Return ONLY a valid JSON object with keys:
- "name": short workout title
- "workout_type": "easy" | "workout" | "long_run" | "recovery" | "rest" | "race"
- "warmup_miles": number (e.g. 1.5, in miles not minutes)
- "main_miles": number (e.g. 3.1, in miles not minutes)
- "cooldown_miles": number (e.g. 1.0, in miles not minutes)
- "distance_miles": number (TOTAL MILES: MUST strictly equal warmup_miles + main_miles + cooldown_miles, e.g. 1.5 + 3.1 + 1.0 = 5.6)
- "pace_target": string (e.g. "5:58–6:05/mi")
- "hr_cap": string (e.g. "< 185 bpm")
- "description": format as 3 concise structured lines:
  • Warmup: [distance/minutes + dynamic drills]
  • Main Set: [intervals/tempo/race execution with exact pace and rests]
  • Cooldown: [distance/minutes easy flush]
- "injury_prevention_note": short recovery or form cue
- "reason": concise rationale

USER REQUEST: ${goal_prompt.trim()}
ATHLETE PACES: ${zoneSummary}
RECOVERY SNAPSHOT: ${recoverySummary}
LIVE GARMIN METRICS:
${buildLiveMetricsSummary(health, fitness, prs)}
TARGET RACE: ${targetRaceStr}

CRITICAL: If the USER REQUEST asks for a race (e.g. "Run for Pie 5K", "5K race", "time trial"), set workout_type to "race", warmup_miles to 1.5, main_miles to the race distance (e.g. 3.1 for a 5K), cooldown_miles to 1.0, and distance_miles to the sum (e.g. 5.6 for 5K race day), name to the race name, and provide race pacing and structured warmup/cooldown. Never substitute a recovery shakeout when the user explicitly requests a race or quality workout!`;

    let responseText = '';
    let usedModel = '';

    // 1. Try Groq FIRST (ultra-fast ~1s generation with llama-3.3-70b-versatile / qwen)
    try {
      const groqRes = await callGroqChat(
        [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt },
        ],
        { timeoutMs: 8000, jsonMode: true }
      );
      if (groqRes && groqRes.text) {
        responseText = groqRes.text.trim();
        usedModel = groqRes.modelUsed;
      }
    } catch (groqErr) {
      console.warn('[AI Workout] Primary Groq call failed, trying backup chain:', groqErr);
    }

    // 2. Fall back to Gemini/Gemma models if Groq was unavailable
    if (!responseText) {
      try {
        const ai = getGeminiClient();
        const { response, modelUsed } = await generateWithRetry(
          ai,
          {
            contents: prompt,
            config: {
              systemInstruction,
            },
          },
          undefined,
          8000
        );
        responseText = (response.text ?? '').trim();
        usedModel = modelUsed;
      } catch (genErr) {
        console.warn('[AI Workout] All Gemini/Gemma backup models failed or timed out:', genErr);
      }
    }

    let parsed: {
      name: string;
      workout_type: 'easy' | 'workout' | 'long_run' | 'recovery' | 'rest' | 'race';
      distance_miles?: number;
      warmup_miles?: number;
      main_miles?: number;
      cooldown_miles?: number;
      pace_target: string;
      hr_cap: string;
      description: string;
      injury_prevention_note: string;
      reason: string;
    } | null = null;

    if (responseText) {
      try {
        const cleaned = extractJsonFromText(responseText);
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        console.warn('[AI Workout] JSON parse failed, falling back to deterministic engine:', parseErr);
      }
    }

    // High quality intelligent fallback if remote AI was unavailable or unparseable
    if (!parsed || !parsed.name || !parsed.workout_type) {
      usedModel = 'local-engine';
      const lowerReq = goal_prompt.toLowerCase();
      const isRace = lowerReq.includes('race') || lowerReq.includes('5k') || lowerReq.includes('pie') || lowerReq.includes('time trial');
      const isWorkout = lowerReq.includes('tempo') || lowerReq.includes('interval') || lowerReq.includes('track') || lowerReq.includes('speed');
      const isLong = lowerReq.includes('long');
      const isRest = lowerReq.includes('rest') || lowerReq.includes('off');

      if (isRace) {
        parsed = {
          name: lowerReq.includes('pie') ? 'Run for Pie 5K — Race Day' : '5K Race Day Execution',
          workout_type: 'race',
          warmup_miles: 1.5,
          main_miles: 3.1,
          cooldown_miles: 1.0,
          distance_miles: 5.6,
          pace_target: 'Goal Race Pace (5:58–6:05/mi)',
          hr_cap: 'Race Effort (Max VO2)',
          description: '• Warmup: 1.5 mi progressive warm-up + dynamic drills + 4x100m strides.\n• Main Set: Race 5K (3.1 mi) at Goal Race Pace (~5:58–6:05/mi).\n• Cooldown: 1.0 mi easy aerobic cooldown flush.',
          injury_prevention_note: 'Pre-race hydration and dynamic mobility. Double-knot racing shoes.',
          reason: `Honored athlete request for a race on ${String(day ?? 'Thursday')}.`,
        };
      } else if (isWorkout) {
        parsed = {
          name: 'Target Quality Session',
          workout_type: 'workout',
          warmup_miles: 1.5,
          main_miles: 3.0,
          cooldown_miles: 1.0,
          distance_miles: 5.5,
          pace_target: 'Threshold / Interval (~6:20–6:45/mi)',
          hr_cap: '< 185 bpm',
          description: '• Warmup: 1.5 mi easy aerobic jogging + dynamic leg swings.\n• Main Set: 3 x 1000m at threshold pace with 60s jog recovery + 4x100m strides.\n• Cooldown: 1.0 mi easy flush on soft surface.',
          injury_prevention_note: 'Controlled turnover; stay relaxed through the shoulders.',
          reason: `Built targeted quality session for ${String(day ?? 'Tuesday')}.`,
        };
      } else if (isLong) {
        parsed = {
          name: 'Aerobic Long Run',
          workout_type: 'long_run',
          warmup_miles: 0.5,
          main_miles: 6.0,
          cooldown_miles: 0.5,
          distance_miles: 7.0,
          pace_target: '7:45–8:15/mi',
          hr_cap: '< 150 bpm',
          description: '• Warmup: 0.5 mi progressive shuffle into steady Zone 2 rhythm.\n• Main Set: 6.0 mi continuous aerobic endurance running on soft trails.\n• Cooldown: 0.5 mi light walk & hamstring/calf mobility.',
          injury_prevention_note: 'Hydrate well before and after; avoid pacing surges.',
          reason: `Scheduled aerobic long run for ${String(day ?? 'Saturday')}.`,
        };
      } else if (isRest) {
        parsed = {
          name: 'Rest & Mobility Day',
          workout_type: 'rest',
          warmup_miles: 0,
          main_miles: 0,
          cooldown_miles: 0,
          distance_miles: 0,
          pace_target: 'Off',
          hr_cap: 'Rest',
          description: '• Warmup: 5 min diaphragmatic breathing.\n• Main Set: 20 min foam rolling IT bands, quads, and calves + light hip mobility.\n• Cooldown: Full recovery hydration and protein supercompensation.',
          injury_prevention_note: 'Tissue repair and glycogen supercompensation.',
          reason: `Scheduled rest day for ${String(day ?? 'Monday')}.`,
        };
      } else {
        parsed = {
          name: 'Zone 2 Aerobic Base Run',
          workout_type: 'easy',
          warmup_miles: 0.5,
          main_miles: 3.0,
          cooldown_miles: 0.5,
          distance_miles: 4.0,
          pace_target: '7:30–8:00/mi',
          hr_cap: '< 145 bpm',
          description: '• Warmup: 0.5 mi progressive jog into aerobic pace.\n• Main Set: 3.0 mi conversational Zone 2 flush on grass or soft trail.\n• Cooldown: 0.5 mi walk + light calf stretching.',
          injury_prevention_note: 'Builds capillary density without musculoskeletal strain.',
          reason: `Built easy aerobic run for ${String(day ?? 'Wednesday')}.`,
        };
      }
    }

    // Strict mileage normalization: distance_miles MUST equal warmup + main + cooldown
    const norm = normalizeWorkoutMileage(parsed);

    res.json({
      workout: {
        day: String(day ?? 'Thursday'),
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
        adaptation_reason: parsed.reason,
      },
      model_used: usedModel || 'local-engine',
      source: usedModel === 'local-engine' ? 'local-engine' : undefined,
    });
  } catch (outerErr) {
    console.error('[AI Workout] Unexpected error, returning deterministic fallback:', outerErr);
    res.json({
      workout: {
        day: String(req.body?.day ?? 'Thursday'),
        name: 'Zone 2 Aerobic Base Run',
        workout_type: 'easy',
        distance_miles: 4.0,
        pace_target: '7:40–8:15/mi',
        hr_cap: '< 145 bpm',
        description: '• Warmup: 0.5 mi progressive jog.\n• Main Set: 3.0 mi conversational Zone 2 flush.\n• Cooldown: 0.5 mi walk.',
        injury_prevention_note: 'Aerobic base maintenance.',
        ai_generated: true,
        adaptation_reason: 'Deterministic recovery session.',
      },
      model_used: 'local-engine',
      source: 'local-engine',
    });
  }
});

// ── Gemini Interactive Performance Coach (Resilient + Garmlink MCP Tool Access)

const BASE_COACH_TOOLS: FunctionDeclaration[] = [
  {
    name: 'replace_workout_day',
    description:
      'Creates or replaces a specific day in the RaceKit weekly training plan with a tailored workout.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        day: {
          type: Type.STRING,
          enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
        },
        name: { type: Type.STRING, description: 'Workout title.' },
        workout_type: {
          type: Type.STRING,
          enum: ['easy', 'workout', 'long_run', 'recovery', 'rest', 'race'],
        },
        distance_miles: { type: Type.NUMBER, description: 'Total distance in miles.' },
        pace_target: { type: Type.STRING, description: 'Target pace band.' },
        hr_cap: { type: Type.STRING, description: 'Heart rate cap string, e.g. < 145 bpm.' },
        description: { type: Type.STRING, description: 'Structured workout details.' },
        injury_prevention_note: { type: Type.STRING, description: 'Recovery or form cue.' },
        reason: { type: Type.STRING, description: 'Short rationale grounded in watch data.' },
      },
      required: [
        'day',
        'name',
        'workout_type',
        'distance_miles',
        'pace_target',
        'hr_cap',
        'description',
        'injury_prevention_note',
        'reason',
      ],
    },
  },
  {
    name: 'schedule_race_taper',
    description:
      'Sets a target race on a specific day of the week and automatically tapers the preceding 3 days for glycogen supercompensation.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        race_name: { type: Type.STRING, description: 'Name of the target race.' },
        race_dist: {
          type: Type.STRING,
          enum: ['800m', '1600m', '3200m', '5K', '10K', 'Half Marathon'],
        },
        race_day: {
          type: Type.STRING,
          enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
        },
      },
      required: ['race_name', 'race_dist', 'race_day'],
    },
  },
];

const GARMLINK_QUERY_TOOL: FunctionDeclaration = {
  name: 'query_garmlink_mcp',
  description:
    'Calls a live read-only tool on the connected Garmlink MCP server to fetch additional Garmin Connect data (activities, sleep, HRV, training load, body battery) directly from the user watch account.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      tool_name: {
        type: Type.STRING,
        description: 'Exact Garmlink MCP tool name from the available tools list.',
      },
      arguments_json: {
        type: Type.STRING,
        description: 'Optional JSON object string of arguments for the Garmlink tool (default "{}").',
      },
    },
    required: ['tool_name'],
  },
};

app.post('/api/ai/coach', async (req: Request, res: Response) => {
  try {
    const { message, history, context } = req.body as {
      message?: string;
      history?: Array<{ role: string; content: string }>;
      context?: Record<string, unknown>;
    };

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'Message is required.' });
      return;
    }

    const isOwn = isOwner(req);
    const { session, accessToken } = getActiveGarmlinkAccessToken(req);
    const hasGarmlink = isOwn && Boolean(accessToken);
    const discoveredTools = hasGarmlink ? session?.tools_discovered ?? [] : [];

    const toolsList = hasGarmlink
      ? [...BASE_COACH_TOOLS, GARMLINK_QUERY_TOOL]
      : BASE_COACH_TOOLS;

    // Athlete identity: Profile info from client context or Owner fallback
    const runnerProfile = (context?.runner_profile as any) || null;
    const rawName = runnerProfile?.name?.trim();
    const athleteFirstName = rawName ? rawName.split(' ')[0] : (isOwn ? 'Ephraim' : '');
    const athleteName = athleteFirstName || 'Athlete';
    const greetingSalutation = athleteFirstName ? `Hey ${athleteFirstName}!` : 'Hey there!';
    const runnerUnits = runnerProfile?.units || 'mi';

    // Telemetry: Ground Coach strictly in verified data if connected; clean slate if not linked
    let completedRunsSummary = 'No synced watch activities available. (Garmin Connect not linked or guest mode).';
    let prSummary = runnerProfile?.benchmark_label && runnerProfile?.benchmark_time_fmt
      ? `- Benchmark PR: ${runnerProfile.benchmark_label} in ${runnerProfile.benchmark_time_fmt} (Estimated VDOT: ${runnerProfile.vdot ?? 50})`
      : 'No verified personal records configured yet.';
    let sleepHoursStr = 'Not recorded';
    let verifiedHealth: any = null;

    if (isOwn) {
      const localSync = getLocalGarminBridgeData('sync') || {};
      const verifiedActivities: any[] = localSync.activities || DEFAULT_GARMLINK_ACTIVITIES;
      const verifiedPrs: any[] = localSync.prs || VERIFIED_PR_EFFORTS;
      verifiedHealth = localSync.health || DEFAULT_GARMLINK_HEALTH;

      const sleepTotalMin = verifiedHealth.sleep_seconds
        ? Math.round(verifiedHealth.sleep_seconds / 60)
        : (verifiedHealth.sleep_hours ? Math.round(verifiedHealth.sleep_hours * 60) : 306);
      sleepHoursStr = `${Math.floor(sleepTotalMin / 60)}h ${(sleepTotalMin % 60).toString().padStart(2, '0')}m (${sleepTotalMin} min)`;

      completedRunsSummary = verifiedActivities.slice(0, 15).map((a: any) =>
        `- Date: ${a.date} | Activity: "${a.name}" | Distance: ${a.distance_miles ?? (a.distance_m / 1609.344).toFixed(2)} mi (${a.distance_m}m) | Duration: ${a.duration_fmt ?? `${Math.floor(a.duration_s / 60)}:${(a.duration_s % 60).toString().padStart(2, '0')}`} | Avg Pace: ${a.pace_fmt ?? '—'} | Avg HR: ${a.avg_hr ?? '—'} bpm (Max HR: ${a.max_hr ?? '—'} bpm) | Cadence: ${a.avg_cadence ?? '—'} spm | Aerobic TE: ${a.aerobic_te ?? '—'}`
      ).join('\n');

      prSummary = verifiedPrs.map((p: any) =>
        `- ${p.label}: ${Math.floor(p.time_s / 60)}:${(p.time_s % 60).toFixed(1).padStart(4, '0')} (${p.date})`
      ).join('\n');
    } else if (context?.health) {
      verifiedHealth = context.health;
      if (verifiedHealth.sleep_hours) {
        sleepHoursStr = `${verifiedHealth.sleep_hours}h (Sleep Score: ${verifiedHealth.sleep_score ?? '—'}/100)`;
      }
    }

    // Active Target Race from context
    const targetRace = (context?.target_race as any) || (context?.current_plan as any)?.target_race || null;
    const targetRaceStr = targetRace?.name
      ? `- Target Race: ${targetRace.name} (${targetRace.dist || '5K'}) scheduled on ${targetRace.day || 'Thursday'}.`
      : '- Target Race: No target race currently scheduled.';

    // Check for casual greeting
    const isCasualGreeting = /^(hi|hello|hey|yo|howdy|sup|good morning|good afternoon|good evening|what's up|whats up)[!.,? ]*$/i.test(message.trim());

    const systemInstruction = `You are the RaceKit AI Running Coach — an elite collegiate middle-distance & cross-country running coach working directly with athlete ${athleteName}.

=== ATHLETE PROFILE ===
- Athlete Name: ${athleteName}
- Preferred Units: ${runnerUnits}

${isOwn ? `=== COMPLETED GARMIN WATCH ACTIVITIES (100% VERIFIED GROUND TRUTH - COMPLETED RUNS ONLY) ===
${completedRunsSummary}` : '=== COMPLETED ACTIVITIES ===\n- Guest mode / no personal activities connected.'}

=== VERIFIED ATHLETE PRs ===
${prSummary}

${verifiedHealth ? `=== LATEST WATCH RECOVERY & TRAINING LOAD ===
- Date: ${verifiedHealth.date || 'Today'}
- Sleep Duration: ${sleepHoursStr}
- Overnight HRV: ${verifiedHealth.hrv_last_night ?? '—'} ms (${verifiedHealth.hrv_status ?? 'BALANCED'} vs baseline ${verifiedHealth.hrv_baseline_low ?? 48}–${verifiedHealth.hrv_baseline_high ?? 73} ms)
- Resting Heart Rate: ${verifiedHealth.resting_hr ?? '—'} bpm
- Body Battery: ${verifiedHealth.body_battery ?? '—'} / 100
- Training Load Status: ${verifiedHealth.load_aerobic_low ? `Low Aerobic Shortage (${verifiedHealth.load_aerobic_low} vs 790 target)` : 'Balanced'}
` : '=== RECOVERY TELEMETRY ===\n- No watch recovery telemetry synced yet. Encourage the athlete to authorize their Garmin watch via Garmlink.'}

=== LIVE GARMIN METRICS (SYNCED THIS SESSION — USE THESE EXACT VALUES) ===
${buildLiveMetricsSummary(context?.health, context?.fitness, context?.prs)}

=== ACTIVE TARGET RACE & SCHEDULE CONTEXT ===
${targetRaceStr}

=== ATHLETE STATE & PLANNED WORKOUTS (FROM RACEKIT APP) ===
${JSON.stringify(context ?? {}, null, 2)}
${
  hasGarmlink && discoveredTools.length > 0
    ? `\nConnected Garmlink MCP Tools Available via query_garmlink_mcp:\n${discoveredTools
        .slice(0, 35)
        .map((t) => `- ${t.name}${t.description ? `: ${t.description.slice(0, 90)}` : ''}`)
        .join('\n')}`
    : ''
}

=== COACHING DIRECTIVES ===
1. CASUAL GREETING RULE: If the user sends a greeting (like "hi", "hello", "hey", "good morning"), respond warmly, conversationally, and concisely in 1–2 friendly sentences as their personal running coach (e.g. "${greetingSalutation} Ready to dial in today's training? How are your legs feeling?"). NEVER address the athlete as "Runner" or say "Hey Runner!". DO NOT dump unprompted statistics, metric dumps, or past activity lists on a simple greeting!
2. STRICT DATA TRUTH: Only reference runs, PRs, and health metrics that are explicitly listed above. Never invent fake past workouts or fake recovery numbers.
3. PRE-RACE TAPER: 1 day before any race must NEVER be a hard workout (strictly Pre-Race Shakeout 2.0 mi + 4x100m strides or Rest). 1 day after must be a Recovery Flush (2.0 mi) or Rest.
4. WORKOUT CREATION: Use replace_workout_day or schedule_race_taper whenever the user asks to modify a workout, add a race, or adjust the plan. Ensure race workouts include warmup and cooldown distances in the description and mileage.
5. Keep coaching advice sharp, practical, and conversational with exact pace ranges from their VDOT zones.
6. ADAPTIVE RECOVERY GUIDANCE (ATHLETE WANTS TO RUN):
- NEVER tell the athlete they "cannot run" or forbid them from running if they want to run today.
- When the athlete's Overnight HRV is below baseline or their 7-day average (or recovery markers are subdued):
  * If the athlete wants to run, GREEN LIGHT THEM for an easy aerobic recovery run or gentle shakeout (e.g. 2.5–4.0 miles at strictly conversational Easy Zone 2 pace, HR cap < 140–145 bpm).
  * Explain that gentle, low-intensity aerobic running promotes active blood flow, flushes out muscle stiffness, and aids recovery without placing heavy demands on the autonomic nervous system.
  * Advise modifying or skipping high-intensity track intervals, hard tempo runs, or heavy anaerobic volume—instead directing that energy into an easy aerobic effort.
  * Offer full rest only as an optional suggestion if they feel fatigued or sluggish, but never mandate 0 miles or say they aren't allowed to run.`;

    const recentHistory = Array.isArray(history) ? history.slice(-8) : [];
    const contents: Array<Record<string, unknown>> = [
      ...recentHistory.map((h) => ({
        role: h.role === 'user' ? 'user' : 'model',
        parts: [{ text: String(h.content ?? '') }],
      })),
      { role: 'user', parts: [{ text: message.trim() }] },
    ];

    let finalReply = '';
    let modelUsed = '';
    const clientToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const garmlinkCallsExecuted: string[] = [];

    // 1. Try Groq FIRST (ultra-fast ~1s generation with llama-3.3-70b-versatile / qwen)
    try {
      const groqMessages: GroqChatMessage[] = [
        { role: 'system', content: systemInstruction },
        ...recentHistory.map((h) => ({
          role: h.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: String(h.content ?? ''),
        })),
        { role: 'user', content: message.trim() },
      ];
      const groqRes = await callGroqChat(groqMessages, {
        timeoutMs: 8000,
        tools: isCasualGreeting ? undefined : toolsList,
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
      console.warn('[AI Coach] Primary Groq call failed, trying backup chain:', groqErr);
    }

    // 2. Try Gemini/Gemma models with function-calling tools if Groq was unavailable
    if (!finalReply && clientToolCalls.length === 0) {
      try {
        const ai = getGeminiClient();
        const { response: response1, modelUsed: used1 } = await generateWithRetry(
          ai,
          {
            contents: contents as GenerateContentParameters['contents'],
            config: {
              systemInstruction,
              tools: [{ functionDeclarations: toolsList }],
            },
          },
          undefined,
          8000
        );
        modelUsed = used1;
        finalReply = (response1.text ?? '').trim();

        const functionCalls = response1.functionCalls ?? [];
        if (functionCalls.length > 0) {
          const responseParts: Array<Record<string, unknown>> = [];
          let mcpSessionId: string | null = null;
          let validGarmlinkToken: string | null = null;

          for (const fc of functionCalls) {
            if (!fc.name) continue;
            const args = (fc.args as Record<string, unknown>) ?? {};

            if (fc.name === 'query_garmlink_mcp' && accessToken) {
              const requestedTool = String(args.tool_name ?? '').trim();
              let parsedArgs: Record<string, unknown> = {};
              if (typeof args.arguments_json === 'string' && args.arguments_json.trim()) {
                try {
                  parsedArgs = JSON.parse(args.arguments_json) as Record<string, unknown>;
                } catch {
                  parsedArgs = {};
                }
              }

              try {
                if (!validGarmlinkToken) {
                  validGarmlinkToken = session
                    ? await refreshGarmlinkSessionIfNeeded(session)
                    : accessToken;
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
                    response: { status: 'ok', data: unwrapped },
                  },
                });
              } catch (mcpErr) {
                responseParts.push({
                  functionResponse: {
                    id: fc.id,
                    name: fc.name,
                    response: {
                      status: 'error',
                      error: mcpErr instanceof Error ? mcpErr.message : 'Garmlink MCP query failed',
                    },
                  },
                });
              }
            } else {
              clientToolCalls.push({ name: fc.name, args });
              responseParts.push({
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: { status: 'applied', applied_args: args },
                },
              });
            }
          }

          // Run follow-up turn when we executed Garmlink MCP calls or when model returned no prose
          const needsFollowUp = garmlinkCallsExecuted.length > 0 || !finalReply;
          const modelContent = response1.candidates?.[0]?.content;
          if (needsFollowUp && modelContent && responseParts.length > 0) {
            const followUpPayload: Omit<GenerateContentParameters, 'model'> = {
              contents: [
                ...contents,
                modelContent,
                { role: 'user', parts: responseParts },
              ] as GenerateContentParameters['contents'],
              config: {
                systemInstruction,
                tools: [{ functionDeclarations: toolsList }],
              },
            };
            try {
              const { response: response2, modelUsed: used2 } = await generateWithRetry(
                ai,
                followUpPayload,
                undefined,
                8000
              );
              finalReply = (response2.text ?? '').trim() || finalReply;
              if (used2) modelUsed = used2;
            } catch (followUpErr) {
              console.warn('[AI Coach] Follow-up turn failed, using previous response:', followUpErr);
            }
          }
        }
      } catch (coachErr) {
        console.warn('[AI Coach] All Gemini/Gemma models failed or timed out:', coachErr);
      }
    }

    // 3. Fall back to local deterministic coach engine (never return 429/500/503 to frontend)
    if (!finalReply && clientToolCalls.length === 0) {
      modelUsed = 'local-engine';
      const lower = message.toLowerCase();

      if (isCasualGreeting) {
        finalReply = `Hey ${athleteName}! Great to see you. How are your legs feeling today, and what can I help you dial in?`;
      } else if (
        lower.includes('pie') ||
        (lower.includes('race') && (lower.includes('thursday') || lower.includes('5k')))
      ) {
        const raceName = targetRace?.name || 'Run for Pie 5K — Race Day';
        clientToolCalls.push({
          name: 'replace_workout_day',
          args: {
            day: 'Thursday',
            name: raceName,
            workout_type: 'race',
            warmup_miles: 1.5,
            main_miles: 3.1,
            cooldown_miles: 1.0,
            distance_miles: 5.6,
            pace_target: 'Goal Race Pace (~5:58–6:05/mi)',
            hr_cap: 'Race Effort (Max VO2)',
            description:
              '• Warmup: 1.5 mi progressive warm-up + dynamic drills + 4x100m strides.\n• Main Set: Run for Pie 5K (3.1 mi) at Goal Race Pace.\n• Cooldown: 1.0 mi easy flush on soft surface.',
            injury_prevention_note:
              'Pre-race hydration and dynamic mobility. Double-knot racing shoes.',
            reason: 'Target race Run for Pie 5K locked in for Thursday with full warmup & cooldown.',
          },
        });
        finalReply = `I have locked in **${raceName}** on **Thursday** (5.6 mi total: 1.5 mi warmup + 3.1 mi race + 1.0 mi cooldown) and ensured your pre-race taper is scheduled. Keep Wednesday easy so you toe the line fresh!`;
      } else if (
        lower.includes('hrv') ||
        lower.includes('recovery') ||
        lower.includes('sleep') ||
        lower.includes('readiness')
      ) {
        if (verifiedHealth) {
          finalReply = `Your overnight HRV was **${verifiedHealth.hrv_last_night ?? '—'} ms** (${verifiedHealth.hrv_status ?? 'BALANCED'}), sleep duration was **${sleepHoursStr}**, and Body Battery is at **${verifiedHealth.body_battery ?? '—'} / 100**.\n\nKeep easy days truly aerobic (< 145 bpm) to support cellular recovery and tissue repair.`;
        } else {
          finalReply = `You haven't synced watch recovery data yet. Connect your Garmin watch via Garmlink on the Watch tab to sync live HRV, sleep, and training status telemetry.`;
        }
      } else {
        finalReply = `Hey ${athleteName}! As your RaceKit Coach, I'm here to help optimize your training and race preparation. Let me know if you want to inspect your workouts, schedule a race taper, or check your recovery status!`;
      }
    }

    // Normalize any workouts created via tool calls so distance_miles = warmup + main + cooldown
    for (const tc of clientToolCalls) {
      if (tc.name === 'replace_workout_day' && tc.args) {
        const norm = normalizeWorkoutMileage(tc.args as any);
        tc.args.warmup_miles = norm.warmup_miles;
        tc.args.main_miles = norm.main_miles;
        tc.args.cooldown_miles = norm.cooldown_miles;
        tc.args.distance_miles = norm.total_miles;
      }
    }

    if (!finalReply && clientToolCalls.length > 0) {
      const tc = clientToolCalls[0];
      if (tc.name === 'schedule_race_taper') {
        finalReply = `I have locked in **${tc.args.race_name || 'Target Race'}** (${tc.args.race_dist || '5K'}) on **${tc.args.race_day || 'Thursday'}** and updated your pre-race taper.`;
      } else if (tc.name === 'replace_workout_day') {
        finalReply = `I have updated your workout for **${tc.args.day}** to **${tc.args.name}** (${tc.args.distance_miles || ''} mi).`;
      }
    }

    res.json({
      reply: finalReply,
      tool_calls: clientToolCalls,
      garmlink_queries: garmlinkCallsExecuted,
      model_used: modelUsed || 'local-engine',
      source: modelUsed === 'local-engine' ? 'local-engine' : undefined,
    });
  } catch (outerErr) {
    console.error('[AI Coach] Unexpected error, returning deterministic fallback:', outerErr);
    res.json({
      reply:
        'I am monitoring your recovery and training metrics. Keep easy runs conversational and stay hydrated.',
      tool_calls: [],
      garmlink_queries: [],
      model_used: 'local-engine',
      source: 'local-engine',
    });
  }
});

// ── Vite Dev Middleware / Production Static Hosting ────────────────────────

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  discoverLocalMcpTools();

  const primaryPort = PORT;
  const secondaryPort = primaryPort === 5173 ? 3000 : (primaryPort === 3000 ? 5173 : null);

  app.listen(primaryPort, '0.0.0.0', () => {
    console.log(`RaceKit server listening on http://0.0.0.0:${primaryPort}`);
  });

  if (secondaryPort) {
    try {
      const secondaryServer = app.listen(secondaryPort, '0.0.0.0', () => {
        console.log(`RaceKit server also listening on http://0.0.0.0:${secondaryPort}`);
      });
      secondaryServer.on('error', (err: any) => {
        console.log(`Secondary port ${secondaryPort} not bound: ${err.message}`);
      });
    } catch (err: any) {
      console.log(`Secondary port ${secondaryPort} error: ${err.message}`);
    }
  }
}

startServer();
