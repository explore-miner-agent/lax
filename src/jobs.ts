/**
 * LAX jobs client: list jobs, read one job and submit work to the LAX registry.
 * Fetch only, no runtime dependency, no console output.
 */

export const LAX_JOBS_DEFAULT_BASE_URL = 'https://lax.kognai.ai/registry';

export type LaxJobTrack = 'lax-agents' | 'coding-agents' | 'godman-protocols' | 'templates' | 'genesis-tools' | 'seat' | (string & {});

export interface LaxJob {
  id: string;
  title: string;
  track?: LaxJobTrack;
  summary?: string;
  spec_md?: string;
  spec_url?: string | null;
  tests_url?: string | null;
  skills?: string[];
  bounty_usdc?: number;
  currency?: string;
  chain?: string;
  deadline?: string;
  status?: string;
  bid_closes?: string | null;
  selection?: unknown;
  created_at?: string;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface LaxJobList { jobs: LaxJob[]; count: number }

export interface ListJobsParams { track?: LaxJobTrack; limit?: number; offset?: number }

export interface LaxSubmissionInput {
  builder: string;
  contact: string;
  repo_or_patch_url: string;
  payout_address: string;
  agent_did: string;
  notes?: string;
}

export interface LaxSubmission { id: string; job_id: string; status: string; created_at: string; [key: string]: unknown }

export type LaxJobsErrorCode =
  | 'invalid_input' | 'bad_request' | 'not_found' | 'conflict' | 'rate_limited' | 'server' | 'network' | 'invalid_response';

export class LaxJobsError extends Error {
  readonly status: number;
  readonly code: LaxJobsErrorCode;
  constructor(code: LaxJobsErrorCode, status: number, message: string) {
    super(message);
    this.name = 'LaxJobsError';
    this.code = code;
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JobsClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  /** extra attempts after the first one (default 2) */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface JobsClient {
  listJobs(params?: ListJobsParams): Promise<LaxJobList>;
  getJob(id: string): Promise<LaxJob>;
  submit(jobId: string, input: LaxSubmissionInput): Promise<LaxSubmission>;
}

const DID = /^did:[a-z0-9]+:\S+$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_RETRY_AFTER_MS = 30_000;
const BASE_BACKOFF_MS = 500;

function codeForStatus(status: number): LaxJobsErrorCode {
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'bad_request';
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const secs = Number(raw.trim());
  if (!Number.isFinite(secs) || secs < 0) return undefined;
  return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
}

async function errorText(res: Response): Promise<string> {
  let text = '';
  try { text = await res.text(); } catch { /* body unreadable */ }
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof body.error === 'string' && body.error) return body.error;
      if (typeof body.message === 'string' && body.message) return body.message;
    } catch { return text.slice(0, 500); }
  }
  return res.statusText || `HTTP ${res.status}`;
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function checkSubmission(input: LaxSubmissionInput | undefined): void {
  const bad = (message: string): never => { throw new LaxJobsError('invalid_input', 0, message); };
  if (!input || typeof input !== 'object') bad('submission input is required');
  const s = input as LaxSubmissionInput;
  if (typeof s.agent_did !== 'string' || !DID.test(s.agent_did)) bad('agent_did must be a DID such as did:key:z6Mk...');
  if (typeof s.payout_address !== 'string' || !EVM_ADDRESS.test(s.payout_address)) bad('payout_address must be 0x followed by 40 hex characters');
  if (!isHttpsUrl(s.repo_or_patch_url)) bad('repo_or_patch_url must be an https link');
  if (typeof s.builder !== 'string' || s.builder.trim().length < 2) bad('builder must be at least 2 characters');
  if (typeof s.contact !== 'string' || !s.contact.trim()) bad('contact is required');
  if (s.notes !== undefined && typeof s.notes !== 'string') bad('notes must be text');
}

export function createJobsClient(options: JobsClientOptions = {}): JobsClient {
  const baseUrl = (options.baseUrl ?? LAX_JOBS_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const retries = Math.max(0, Math.floor(options.retries ?? 2));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function once(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(url: string, init: RequestInit, kind: 'read' | 'submit'): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= retries;
      const backoff = BASE_BACKOFF_MS * 2 ** attempt;
      let res: Response;
      try {
        res = await once(url, init);
      } catch (e) {
        const reason = e instanceof Error && e.name === 'AbortError' ? `no answer within ${timeoutMs} ms` : e instanceof Error ? e.message : String(e);
        if (kind === 'read' && !last) { await sleep(backoff); continue; }
        throw new LaxJobsError('network', 0, `request failed: ${reason}`);
      }
      if (res.ok) {
        try { return await res.json(); } catch { throw new LaxJobsError('invalid_response', res.status, 'the registry answer is not JSON'); }
      }
      const retryable = res.status === 429 || (kind === 'read' && res.status >= 500);
      if (retryable && !last) {
        const wait = res.status === 429 ? retryAfterMs(res) ?? backoff : backoff;
        res.body?.cancel().catch(() => undefined);
        await sleep(wait);
        continue;
      }
      throw new LaxJobsError(codeForStatus(res.status), res.status, await errorText(res));
    }
  }

  return {
    async listJobs(params: ListJobsParams = {}): Promise<LaxJobList> {
      const query = new URLSearchParams();
      if (params.track !== undefined) {
        if (typeof params.track !== 'string' || !params.track) throw new LaxJobsError('invalid_input', 0, 'track must be a non empty string');
        query.set('track', params.track);
      }
      if (params.limit !== undefined) {
        if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100) throw new LaxJobsError('invalid_input', 0, 'limit must be a whole number from 1 to 100');
        query.set('limit', String(params.limit));
      }
      if (params.offset !== undefined) {
        if (!Number.isInteger(params.offset) || params.offset < 0) throw new LaxJobsError('invalid_input', 0, 'offset must be a whole number of 0 or more');
        query.set('offset', String(params.offset));
      }
      const qs = query.toString();
      const body = await request(`${baseUrl}/jobs${qs ? `?${qs}` : ''}`, { method: 'GET', headers: { accept: 'application/json' } }, 'read') as Partial<LaxJobList> | null;
      if (!body || !Array.isArray(body.jobs)) throw new LaxJobsError('invalid_response', 200, 'the registry answer has no jobs list');
      return { jobs: body.jobs, count: typeof body.count === 'number' ? body.count : body.jobs.length };
    },

    async getJob(id: string): Promise<LaxJob> {
      if (typeof id !== 'string' || !id) throw new LaxJobsError('invalid_input', 0, 'job id is required');
      const body = await request(`${baseUrl}/jobs/${encodeURIComponent(id)}`, { method: 'GET', headers: { accept: 'application/json' } }, 'read') as { job?: LaxJob } | null;
      if (!body || !body.job || typeof body.job !== 'object') throw new LaxJobsError('invalid_response', 200, 'the registry answer has no job');
      return body.job;
    },

    async submit(jobId: string, input: LaxSubmissionInput): Promise<LaxSubmission> {
      if (typeof jobId !== 'string' || !jobId) throw new LaxJobsError('invalid_input', 0, 'job id is required');
      checkSubmission(input);
      const { builder, contact, repo_or_patch_url, payout_address, agent_did, notes } = input;
      const payload: LaxSubmissionInput = { builder, contact, repo_or_patch_url, payout_address, agent_did };
      if (notes !== undefined) payload.notes = notes;
      const body = await request(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/submissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      }, 'submit') as { submission?: LaxSubmission } | null;
      if (!body || !body.submission || typeof body.submission !== 'object') throw new LaxJobsError('invalid_response', 201, 'the registry answer has no submission');
      return body.submission;
    },
  };
}
