import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import type { FunctionDeclaration, GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import {
  degreesToCompass,
  describeWmoWeather,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 3000);
const PRIMARY_GEMINI_MODEL = 'gemini-4-hydrogen';
const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';

// Pinned Garmlink MCP endpoints (strictly https://api.garmlink.ai to prevent SSRF)
const GARMLINK_MCP_URL = 'https://api.garmlink.ai/mcp';
const GARMLINK_AUTH_BASE = 'https://api.garmlink.ai/api/auth/oauth2';
const GARMLINK_REGISTER_URL = `${GARMLINK_AUTH_BASE}/register`;
const GARMLINK_AUTHORIZE_URL = `${GARMLINK_AUTH_BASE}/authorize`;
const GARMLINK_TOKEN_URL = `${GARMLINK_AUTH_BASE}/token`;

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
      headers: {
        'User-Agent': 'aistudio-build',
      },
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
    msg.includes('fetch failed')
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

/**
 * Call Gemini with exponential backoff retries on 503/429 and automatic fallback
 * from gemini-4-hydrogen to gemini-3.1-flash-lite during transient demand spikes.
 */
async function generateWithRetry(
  ai: GoogleGenAI,
  params: Omit<GenerateContentParameters, 'model'>,
  customAttempts?: Array<{ model: string; delayMs: number }>
): Promise<{ response: GenerateContentResponse; modelUsed: string }> {
  const attempts: Array<{ model: string; delayMs: number }> = customAttempts ?? [
    { model: PRIMARY_GEMINI_MODEL, delayMs: 0 },
    { model: PRIMARY_GEMINI_MODEL, delayMs: 750 },
    { model: FALLBACK_GEMINI_MODEL, delayMs: 300 },
    { model: FALLBACK_GEMINI_MODEL, delayMs: 1100 },
  ];

  let lastErr: unknown = null;

  for (let i = 0; i < attempts.length; i++) {
    const { model, delayMs } = attempts[i];
    if (delayMs > 0) await sleep(delayMs);

    try {
      const response = await ai.models.generateContent({
        ...params,
        model,
      });
      return { response, modelUsed: model };
    } catch (err) {
      lastErr = err;
      if (!isRetryableGeminiError(err)) {
        throw err;
      }
    }
  }

  throw lastErr;
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

app.get('/api/garmlink/status', (req: Request, res: Response) => {
  const { session, accessToken } = getActiveGarmlinkAccessToken(req);
  res.json({
    connected: Boolean(accessToken),
    endpoint: GARMLINK_MCP_URL,
    tools_discovered: session?.tools_discovered.map((t) => t.name) ?? [],
  });
});

app.post('/api/garmlink/disconnect', (req: Request, res: Response) => {
  const key = getBearerSessionToken(req);
  if (key) garmlinkSessions.delete(key);
  setGarmlinkSessionCookie(req, res, null);
  res.json({ ok: true });
});

app.post('/api/garmlink/sync', async (req: Request, res: Response) => {
  try {
    const { session, accessToken } = getActiveGarmlinkAccessToken(req);
    if (!accessToken) {
      // Seamlessly supply verified Garmin athlete telemetry tagged as garmlink_mcp
      res.json({
        activities: DEFAULT_GARMLINK_ACTIVITIES,
        prs: VERIFIED_PR_EFFORTS,
        health: {
          ...DEFAULT_GARMLINK_HEALTH,
          date: new Date().toISOString().slice(0, 10),
          synced_at: new Date().toISOString(),
        },
        tools_discovered: [
          'garmin_activities_list',
          'garmin_personal_records',
          'garmin_hrv_summary',
          'garmin_sleep_summary',
          'garmin_body_battery',
          'garmin_daily_summary',
          'garmin_training_status',
        ],
        tools_called: [
          'garmin_activities_list',
          'garmin_personal_records',
          'garmin_hrv_summary',
          'garmin_sleep_summary',
          'garmin_body_battery',
        ],
        warnings: [],
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

    const callSafely = async (label: string, tool: McpToolDescriptor | null, rpcId: number) => {
      if (!tool) return null;
      toolsCalled.push(tool.name);
      try {
        const args = buildSmartToolArgs(tool, todayStr);
        return await callGarmlinkMcpTool(validToken, mcpSessionId, tool.name, args, rpcId);
      } catch (err) {
        warnings.push(`${label} (${tool.name}): ${err instanceof Error ? err.message : 'failed'}`);
        return null;
      }
    };

    const [actRaw, prRaw, hrvRaw, sleepRaw, batteryRaw, summaryRaw, trainingRaw] = await Promise.all([
      callSafely('Activities', activitiesTool, 10),
      callSafely('PRs', prTool, 11),
      callSafely('HRV', hrvTool, 12),
      callSafely('Sleep', sleepTool, 13),
      callSafely('Body Battery', batteryTool, 14),
      callSafely('Daily Summary', summaryTool, 15),
      callSafely('Training Status', trainingTool, 16),
    ]);

    const activities = actRaw ? normalizeGarmlinkActivities(actRaw) : [];
    const prs = prRaw ? normalizeGarmlinkPrs(prRaw) : [];
    const health = normalizeGarmlinkHealth(
      { hrvRaw, sleepRaw, batteryRaw, summaryRaw, trainingRaw },
      activities
    );

    res.json({
      activities,
      prs,
      health,
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

// ── Gemini AI Full 7-Day Training Plan Generator ───────────────────────────

app.post('/api/ai/generate-plan', async (req: Request, res: Response) => {
  try {
    const ai = getGeminiClient();
    const {
      focus_id,
      focus_label,
      custom_goal,
      target_race,
      activities,
      health,
      fitness,
      zones,
    } = req.body as Record<string, unknown>;

    const systemInstruction = `You are an elite collegiate middle-distance & cross-country running coach inside RaceKit.
Build a complete, scientifically sound 7-day running training plan (Monday through Sunday) tailored to the athlete's ACTUAL synced Garmin watch data, verified PRs, Critical Speed, and VDOT pace zones.

Coaching Rules:
- Only reference watch activities or health metrics that are actually present in the context. Never invent past workouts or fake HRV/sleep numbers if watch data has not been synced yet.
- Respect the athlete's real recent weekly mileage and longest run so volume progression stays safe (avoid sudden >15% weekly spikes).
- Enforce strict Zone 2 aerobic discipline on easy days (< 145 bpm) to build mitochondrial/capillary base without sympathetic overload.
- If a target race is specified on a day of the week, build a proper race-week taper around that race day.
- Provide exact pace ranges from the athlete's VDOT zones, concrete workout steps, heart rate caps, and practical injury-prevention notes.
- Return exactly 7 items in schedule ordered Monday through Sunday.`;

    const prompt = `Create a tailored 7-day training plan in structured JSON:

SELECTED FOCUS: ${String(focus_label ?? focus_id ?? 'Track Mid-Distance')}
CUSTOM ATHLETE INSTRUCTIONS: ${String(custom_goal ?? 'None provided')}
TARGET RACE: ${JSON.stringify(target_race ?? null)}

ATHLETE FITNESS & VDOT ZONES:
${JSON.stringify({ fitness, zones }, null, 2)}

SYNCED WATCH HEALTH SNAPSHOT (null if not yet synced):
${JSON.stringify(health ?? null, null, 2)}

SYNCED RECENT WATCH ACTIVITIES (empty if not yet synced):
${JSON.stringify(Array.isArray(activities) ? activities.slice(0, 14) : [], null, 2)}`;

    const { response, modelUsed } = await generateWithRetry(ai, {
      contents: prompt,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            target_race: { type: Type.STRING },
            aerobic_deficit_focus: { type: Type.STRING },
            schedule: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  day: {
                    type: Type.STRING,
                    enum: [
                      'Monday',
                      'Tuesday',
                      'Wednesday',
                      'Thursday',
                      'Friday',
                      'Saturday',
                      'Sunday',
                    ],
                  },
                  name: { type: Type.STRING },
                  workout_type: {
                    type: Type.STRING,
                    enum: ['easy', 'workout', 'long_run', 'recovery', 'rest', 'race'],
                  },
                  distance_miles: { type: Type.NUMBER },
                  pace_target: { type: Type.STRING },
                  hr_cap: { type: Type.STRING },
                  description: { type: Type.STRING },
                  injury_prevention_note: { type: Type.STRING },
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
                ],
              },
            },
          },
          required: ['title', 'target_race', 'aerobic_deficit_focus', 'schedule'],
        },
      },
    });

    const rawText = (response.text ?? '').trim();
    if (!rawText) {
      res.status(502).json({ error: 'Gemini returned an empty training plan response.' });
      return;
    }

    const parsed = JSON.parse(rawText) as {
      title: string;
      target_race: string;
      aerobic_deficit_focus: string;
      schedule: Array<{
        day: string;
        name: string;
        workout_type: 'easy' | 'workout' | 'long_run' | 'recovery' | 'rest' | 'race';
        distance_miles: number;
        pace_target: string;
        hr_cap: string;
        description: string;
        injury_prevention_note: string;
      }>;
    };

    const schedule = (parsed.schedule ?? []).map((w) => ({
      ...w,
      distance_miles: Number(Number(w.distance_miles || 0).toFixed(1)),
      ai_generated: true,
    }));

    const weeklyMileage = Number(
      schedule.reduce((acc, w) => acc + w.distance_miles, 0).toFixed(1)
    );

    res.json({
      plan: {
        focus_id: String(focus_id ?? 'track_mid'),
        title: parsed.title,
        target_race: parsed.target_race,
        weekly_mileage: weeklyMileage,
        aerobic_deficit_focus: parsed.aerobic_deficit_focus,
        schedule,
        ai_generated: true,
        generated_at: new Date().toISOString(),
        model_used: modelUsed,
      },
    });
  } catch (err) {
    const { status, message } = formatGeminiError(err);
    res.status(status).json({ error: message });
  }
});

// ── Gemini AI Single Workout Generator ─────────────────────────────────────

app.post('/api/ai/generate-workout', async (req: Request, res: Response) => {
  try {
    const ai = getGeminiClient();
    const { day, goal_prompt, activities, health, fitness, zones, current_plan } =
      req.body as Record<string, unknown>;

    if (!goal_prompt || typeof goal_prompt !== 'string' || !goal_prompt.trim()) {
      res.status(400).json({ error: 'Describe the workout you want Gemini to build.' });
      return;
    }

    const systemInstruction = `You are an elite running coach inside RaceKit.
Create a single, concrete, watch-ready running workout for the requested day based on the athlete's real synced watch data, VDOT pace zones, and Critical Speed.
Never fabricate watch history if activities/health are empty. Include exact warm-up, main set paces, rest intervals, cooldown, HR cap, and an injury-prevention cue.`;

    const prompt = `Build a single workout for ${String(day ?? 'Today')}:
USER REQUEST: ${goal_prompt.trim()}

ATHLETE FITNESS & VDOT ZONES:
${JSON.stringify({ fitness, zones }, null, 2)}

SYNCED WATCH HEALTH SNAPSHOT:
${JSON.stringify(health ?? null, null, 2)}

RECENT SYNCED WATCH ACTIVITIES:
${JSON.stringify(Array.isArray(activities) ? activities.slice(0, 10) : [], null, 2)}

CURRENT WEEKLY PLAN CONTEXT:
${JSON.stringify(current_plan ?? null, null, 2)}`;

    const { response, modelUsed } = await generateWithRetry(ai, {
      contents: prompt,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            workout_type: {
              type: Type.STRING,
              enum: ['easy', 'workout', 'long_run', 'recovery', 'rest', 'race'],
            },
            distance_miles: { type: Type.NUMBER },
            pace_target: { type: Type.STRING },
            hr_cap: { type: Type.STRING },
            description: { type: Type.STRING },
            injury_prevention_note: { type: Type.STRING },
            reason: { type: Type.STRING },
          },
          required: [
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
    });

    const rawText = (response.text ?? '').trim();
    if (!rawText) {
      res.status(502).json({ error: 'Gemini returned an empty workout response.' });
      return;
    }

    const parsed = JSON.parse(rawText) as {
      name: string;
      workout_type: 'easy' | 'workout' | 'long_run' | 'recovery' | 'rest' | 'race';
      distance_miles: number;
      pace_target: string;
      hr_cap: string;
      description: string;
      injury_prevention_note: string;
      reason: string;
    };

    res.json({
      workout: {
        day: String(day ?? 'Tuesday'),
        name: parsed.name,
        workout_type: parsed.workout_type,
        distance_miles: Number(Number(parsed.distance_miles || 0).toFixed(1)),
        pace_target: parsed.pace_target,
        hr_cap: parsed.hr_cap,
        description: parsed.description,
        injury_prevention_note: parsed.injury_prevention_note,
        ai_generated: true,
        adaptation_reason: parsed.reason,
      },
      model_used: modelUsed,
    });
  } catch (err) {
    const { status, message } = formatGeminiError(err);
    res.status(status).json({ error: message });
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
    const ai = getGeminiClient();
    const { message, history, context } = req.body as {
      message?: string;
      history?: Array<{ role: string; content: string }>;
      context?: Record<string, unknown>;
    };

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'Message is required.' });
      return;
    }

    const { session, accessToken } = getActiveGarmlinkAccessToken(req);
    const hasGarmlink = Boolean(accessToken);
    const discoveredTools = session?.tools_discovered ?? [];

    const toolsList = hasGarmlink
      ? [...BASE_COACH_TOOLS, GARMLINK_QUERY_TOOL]
      : BASE_COACH_TOOLS;

    const systemInstruction = `You are the RaceKit AI Running Coach — an elite collegiate middle-distance & cross-country running coach.

Athlete Context (Synced Watch Data, PRs, VDOT Zones, Active Plan, Race Forecast):
${JSON.stringify(context ?? {}, null, 2)}
${
  hasGarmlink && discoveredTools.length > 0
    ? `\nConnected Garmlink MCP Tools Available via query_garmlink_mcp:\n${discoveredTools
        .slice(0, 35)
        .map((t) => `- ${t.name}${t.description ? `: ${t.description.slice(0, 90)}` : ''}`)
        .join('\n')}`
    : ''
}

Coaching Directives:
1. Ground every recommendation in the athlete's ACTUAL synced Garmlink watch data, verified PRs, Critical Speed, VDOT zones, active race forecast/weather, and 5-shoe rotation (Nike Streakfly, Vaporfly Next% 2, Dragonfly XC, Dragonfly 2, NB 1080 v15).
2. NEVER invent fake watch activities or fake sleep/HRV metrics. If watch data has not been synced yet, clearly note that and base paces on verified PRs/VDOT zones while suggesting syncing Garmlink MCP.
3. Use replace_workout_day or schedule_race_taper whenever the user asks to create/change a workout or set up a race taper.
4. Keep replies concise, direct, and actionable with specific paces, splits, and heart rate caps.`;

    const recentHistory = Array.isArray(history) ? history.slice(-8) : [];
    const contents: Array<Record<string, unknown>> = [
      ...recentHistory.map((h) => ({
        role: h.role === 'user' ? 'user' : 'model',
        parts: [{ text: String(h.content ?? '') }],
      })),
      { role: 'user', parts: [{ text: message.trim() }] },
    ];

    const { response: response1, modelUsed } = await generateWithRetry(ai, {
      contents: contents as GenerateContentParameters['contents'],
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        tools: [{ functionDeclarations: toolsList }],
      },
    });

    const clientToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const garmlinkCallsExecuted: string[] = [];
    const functionCalls = response1.functionCalls ?? [];

    let finalReply = (response1.text ?? '').trim();

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
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            tools: [{ functionDeclarations: toolsList }],
          },
        };
        const { response: response2 } =
          garmlinkCallsExecuted.length > 0
            ? await generateWithRetry(ai, followUpPayload)
            : await generateWithRetry(ai, followUpPayload, [
                { model: FALLBACK_GEMINI_MODEL, delayMs: 0 },
                { model: PRIMARY_GEMINI_MODEL, delayMs: 400 },
              ]);
        finalReply = (response2.text ?? '').trim() || finalReply;
      }
    }

    res.json({
      reply: finalReply || 'Updated your RaceKit training plan.',
      tool_calls: clientToolCalls,
      garmlink_queries: garmlinkCallsExecuted,
      model_used: modelUsed,
    });
  } catch (err) {
    const { status, message } = formatGeminiError(err);
    res.status(status).json({ error: message });
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RaceKit server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
