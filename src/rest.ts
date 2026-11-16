/**
 * Thin client for the app2email WhatsApp API v1 (https://api.app2email.com/v1/{number}/...).
 * Zero dependencies: global fetch (Node 18+). Every tool in tools.ts goes through callApi().
 */

export interface RestConfig {
  /** API key from https://www.app2email.com/dashboard/apikey (a2e_...). */
  apiKey: string;
  /** The WhatsApp number messages are sent from: country code first, digits only. */
  number: string;
  /** Default https://api.app2email.com/v1 */
  baseUrl: string;
  /** Per request timeout. Default 60 s (sends with media can take a while). */
  timeoutMs: number;
  fetch: typeof fetch;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  how_to_fix?: string;
  documentation_url?: string;
  is_retriable?: boolean;
  retry_after_seconds?: number;
  details?: unknown;
  example_request?: unknown;
  whatsapp_error?: unknown;
}

/** A non-2xx answer, success:false, a network failure or a timeout. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly body?: ApiErrorBody;
  readonly retryAfter?: number;

  constructor(message: string, init: { status: number; code: string; requestId?: string; body?: ApiErrorBody; retryAfter?: number }) {
    super(message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.body = init.body;
    this.retryAfter = init.retryAfter;
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path after /v1/{number}, eg "/messages". */
  path: string;
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  /** true: the answer is text (CSV), not JSON. */
  text?: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RestConfig {
  const apiKey = (env.APP2EMAIL_API_KEY ?? '').trim();
  const number = (env.APP2EMAIL_NUMBER ?? '').replace(/[^0-9]/g, '');
  if (!apiKey) throw new Error('APP2EMAIL_API_KEY is not set. Create a key on https://www.app2email.com/dashboard/apikey');
  if (!/^[0-9]{8,15}$/.test(number)) {
    throw new Error('APP2EMAIL_NUMBER must be the WhatsApp number you send from: country code first, digits only (8 to 15 digits)');
  }
  const baseUrl = (env.APP2EMAIL_BASE_URL ?? 'https://api.app2email.com/v1').replace(/\/+$/, '');
  const timeoutMs = Number(env.APP2EMAIL_TIMEOUT_MS ?? 60_000) || 60_000;
  if (typeof globalThis.fetch !== 'function') throw new Error('global fetch is missing: use Node 18 or newer');
  return { apiKey, number, baseUrl, timeoutMs, fetch: globalThis.fetch.bind(globalThis) };
}

function buildQuery(query: Query | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

export async function callApi<T = unknown>(cfg: RestConfig, req: ApiRequest): Promise<T> {
  let url = `${cfg.baseUrl}/${encodeURIComponent(cfg.number)}${req.path}`;
  const qs = buildQuery(req.query);
  if (qs) url += `?${qs}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    Accept: req.text ? 'text/csv, application/json' : 'application/json',
    'User-Agent': 'app2email-mcp/0.1.0',
    ...(req.headers ?? {}),
  };
  let body: string | undefined;
  if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await cfg.fetch(url, { method: req.method, headers, body, signal: controller.signal });
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    throw new ApiError(aborted ? `Request timed out after ${cfg.timeoutMs} ms` : `Network error: ${(err as Error)?.message ?? String(err)}`, {
      status: 0,
      code: aborted ? 'timeout' : 'network_error',
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (req.text && res.ok) return text as unknown as T;

  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const obj = (json && typeof json === 'object' ? json : undefined) as { success?: boolean; request_id?: string; error?: ApiErrorBody } | undefined;

  if (!res.ok || (obj && obj.success === false)) {
    const err = obj?.error;
    const code = err?.code ?? (res.status === 429 ? 'rate_limited' : `http_${res.status}`);
    const message = err?.message ?? (res.statusText || `HTTP ${res.status}`);
    const retryHeader = res.headers.get('Retry-After');
    const retryAfter = retryHeader && !Number.isNaN(Number(retryHeader)) ? Number(retryHeader) : err?.retry_after_seconds;
    throw new ApiError(`${res.status} ${code}: ${message}`, { status: res.status, code, requestId: obj?.request_id, body: err, retryAfter });
  }
  return (json ?? {}) as T;
}

/** The text an agent should read when a call fails: code, message, how to fix, and the request id for support. */
export function describeError(err: unknown): { text: string; structured: Record<string, unknown> } {
  if (err instanceof ApiError) {
    const b = err.body;
    const lines = [`Error ${err.code}${err.status ? ` (HTTP ${err.status})` : ''}: ${b?.message ?? err.message}`];
    if (b?.how_to_fix) lines.push(`How to fix: ${b.how_to_fix}`);
    if (b?.documentation_url) lines.push(`Documentation: ${b.documentation_url}`);
    if (err.retryAfter !== undefined) lines.push(`Retry after ${err.retryAfter} seconds.`);
    if (b?.example_request) lines.push(`Example of a correct request: ${JSON.stringify(b.example_request)}`);
    if (err.requestId) lines.push(`request_id ${err.requestId} (quote it to support@app2email.com).`);
    return {
      text: lines.join('\n'),
      structured: {
        error: {
          code: err.code,
          status: err.status,
          message: b?.message ?? err.message,
          how_to_fix: b?.how_to_fix,
          documentation_url: b?.documentation_url,
          is_retriable: b?.is_retriable ?? (err.status === 429 || err.status >= 500 || err.status === 0),
          retry_after_seconds: err.retryAfter,
          details: b?.details,
          example_request: b?.example_request,
          whatsapp_error: b?.whatsapp_error,
          request_id: err.requestId,
        },
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { text: `Error: ${message}`, structured: { error: { code: 'tool_error', message } } };
}
