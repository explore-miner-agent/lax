import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobsClient, LaxJobsError } from '../src/index.js';
import type { LaxSubmissionInput } from '../src/index.js';

type Call = { url: string; init: RequestInit };
type Answer = Response | Error | (() => Response);

function fakeFetch(answers: Answer[]) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url, init });
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a() : a.clone();
  };
  return { fn, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function recorder() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}
const BASE = 'https://lax.test/registry';
const JOB = { id: 'job 1/x', title: 'A job', track: 'godman-protocols', status: 'open' };
const GOOD: LaxSubmissionInput = {
  builder: 'SerIgala',
  contact: 'agent@example.com',
  repo_or_patch_url: 'https://github.com/example/repo/commit/0123456789abcdef0123456789abcdef01234567',
  payout_address: '0x' + 'ab'.repeat(20),
  agent_did: 'did:key:z6MkExample',
  notes: 'tests pass',
};

async function rejectsWith(p: Promise<unknown>, code: string, status: number, message?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof LaxJobsError, 'is LaxJobsError');
    assert.ok(e instanceof Error);
    assert.equal(e.code, code);
    assert.equal(e.status, status);
    if (message) assert.match(e.message, message);
    return true;
  });
}

test('A1 listJobs sends GET /jobs with only the given parameters and returns the parsed answer', async () => {
  const f = fakeFetch([json(200, { jobs: [JOB], count: 1 })]);
  const c = createJobsClient({ baseUrl: BASE, fetch: f.fn });
  assert.deepEqual(await c.listJobs(), { jobs: [JOB], count: 1 });
  assert.equal(f.calls[0]!.url, `${BASE}/jobs`);
  assert.equal(f.calls[0]!.init.method, 'GET');
  await c.listJobs({ track: 'seat', limit: 100 });
  assert.equal(f.calls[1]!.url, `${BASE}/jobs?track=seat&limit=100`);
  await c.listJobs({ offset: 0 });
  assert.equal(f.calls[2]!.url, `${BASE}/jobs?offset=0`);
  await rejectsWith(c.listJobs({ limit: 0 }), 'invalid_input', 0);
  await rejectsWith(c.listJobs({ limit: 101 }), 'invalid_input', 0);
  assert.equal(f.calls.length, 3);
});

test('A1 getJob encodes the id and takes the job out of {job}', async () => {
  const f = fakeFetch([json(200, { job: JOB })]);
  const c = createJobsClient({ baseUrl: BASE + '/', fetch: f.fn });
  assert.deepEqual(await c.getJob('job 1/x'), JOB);
  assert.equal(f.calls[0]!.url, `${BASE}/jobs/job%201%2Fx`);
});

test('A1 submit posts JSON to /jobs/<id>/submissions and takes the submission out of {submission}', async () => {
  const sub = { id: 's1', job_id: 'j1', status: 'received', created_at: '2026-10-23T00:00:00Z' };
  const f = fakeFetch([json(201, { submission: sub })]);
  const c = createJobsClient({ baseUrl: BASE, fetch: f.fn });
  assert.deepEqual(await c.submit('j1', GOOD), sub);
  const call = f.calls[0]!;
  assert.equal(call.url, `${BASE}/jobs/j1/submissions`);
  assert.equal(call.init.method, 'POST');
  assert.equal(new Headers(call.init.headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(call.init.body)), GOOD);
});

test('A1 the default base URL is the LAX registry', async () => {
  const f = fakeFetch([json(200, { jobs: [], count: 0 })]);
  await createJobsClient({ fetch: f.fn }).listJobs();
  assert.equal(f.calls[0]!.url, 'https://lax.kognai.ai/registry/jobs');
});

test('A2 a 400, 404 or 409 throws LaxJobsError with its status, code and the registry message after a single request', async () => {
  for (const [status, code] of [[400, 'bad_request'], [404, 'not_found'], [409, 'conflict']] as const) {
    const r = recorder();
    const f = fakeFetch([json(status, { error: `registry says ${status}` })]);
    const c = createJobsClient({ baseUrl: BASE, fetch: f.fn, sleep: r.sleep });
    await rejectsWith(c.getJob('x'), code, status, new RegExp(`registry says ${status}`));
    await rejectsWith(c.listJobs(), code, status);
    await rejectsWith(c.submit('x', GOOD), code, status);
    assert.equal(f.calls.length, 3);
    assert.deepEqual(r.waits, []);
  }
});

test('A3 a 429 is retried after its Retry-After and then succeeds', async () => {
  const r = recorder();
  const f = fakeFetch([json(429, { error: 'slow down' }, { 'retry-after': '3' }), json(200, { job: JOB })]);
  const c = createJobsClient({ baseUrl: BASE, fetch: f.fn, sleep: r.sleep });
  assert.deepEqual(await c.getJob('x'), JOB);
  assert.deepEqual(r.waits, [3000]);
  const r2 = recorder();
  const sub = { id: 's', job_id: 'j', status: 'received', created_at: 't' };
  const f2 = fakeFetch([json(429, { error: 'slow down' }, { 'retry-after': '120' }), json(201, { submission: sub })]);
  assert.deepEqual(await createJobsClient({ baseUrl: BASE, fetch: f2.fn, sleep: r2.sleep }).submit('j', GOOD), sub);
  assert.deepEqual(r2.waits, [30000]); // Retry-After is capped at 30 seconds
});

test('A3 a 429 that never ends throws rate_limited after the last retry, with doubling backoff when no Retry-After', async () => {
  const r = recorder();
  const f = fakeFetch([json(429, { error: 'too many submissions' })]);
  const c = createJobsClient({ baseUrl: BASE, fetch: f.fn, sleep: r.sleep, retries: 3 });
  await rejectsWith(c.submit('j', GOOD), 'rate_limited', 429, /too many submissions/);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(r.waits, [500, 1000, 2000]);
});

test('A4 a 5xx or a network error on a read is retried and then throws server or network', async () => {
  const r = recorder();
  const f = fakeFetch([json(503, { error: 'down' }), json(502, { error: 'down' }), json(200, { jobs: [], count: 0 })]);
  assert.deepEqual(await createJobsClient({ baseUrl: BASE, fetch: f.fn, sleep: r.sleep }).listJobs(), { jobs: [], count: 0 });
  assert.deepEqual(r.waits, [500, 1000]);
  const f2 = fakeFetch([json(500, { error: 'boom' })]);
  await rejectsWith(createJobsClient({ baseUrl: BASE, fetch: f2.fn, sleep: recorder().sleep }).getJob('x'), 'server', 500, /boom/);
  assert.equal(f2.calls.length, 3);
  const f3 = fakeFetch([new TypeError('fetch failed')]);
  await rejectsWith(createJobsClient({ baseUrl: BASE, fetch: f3.fn, sleep: recorder().sleep }).listJobs(), 'network', 0, /fetch failed/);
  assert.equal(f3.calls.length, 3);
});

test('A4 submit is not retried on a 5xx or a network error', async () => {
  const f = fakeFetch([json(500, { error: 'boom' })]);
  await rejectsWith(createJobsClient({ baseUrl: BASE, fetch: f.fn, sleep: recorder().sleep }).submit('j', GOOD), 'server', 500);
  assert.equal(f.calls.length, 1);
  const f2 = fakeFetch([new TypeError('fetch failed')]);
  await rejectsWith(createJobsClient({ baseUrl: BASE, fetch: f2.fn, sleep: recorder().sleep }).submit('j', GOOD), 'network', 0);
  assert.equal(f2.calls.length, 1);
});

test('A4 a request that times out is a network error', async () => {
  const hang = (_u: string, init: RequestInit = {}) => new Promise<Response>((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await rejectsWith(createJobsClient({ baseUrl: BASE, fetch: hang, retries: 0, timeoutMs: 20 }).getJob('x'), 'network', 0, /20 ms/);
});

test('A4 an answer that is not JSON or lacks the expected field is invalid_response', async () => {
  const f = fakeFetch([new Response('<html>', { status: 200 })]);
  await rejectsWith(createJobsClient({ baseUrl: BASE, fetch: f.fn }).getJob('x'), 'invalid_response', 200);
  const f2 = fakeFetch([json(200, { nope: true })]);
  await rejectsWith(createJobsClient({ baseUrl: BASE, fetch: f2.fn }).getJob('x'), 'invalid_response', 200);
});

test('A5 submit refuses a missing agent_did, a bad payout address or a link that is not https before any request', async () => {
  const f = fakeFetch([json(201, { submission: {} })]);
  const c = createJobsClient({ baseUrl: BASE, fetch: f.fn });
  const { agent_did: _drop, ...noDid } = GOOD;
  await rejectsWith(c.submit('j', noDid as LaxSubmissionInput), 'invalid_input', 0, /agent_did/);
  await rejectsWith(c.submit('j', { ...GOOD, agent_did: 'z6Mk' }), 'invalid_input', 0, /agent_did/);
  await rejectsWith(c.submit('j', { ...GOOD, payout_address: '0x1234' }), 'invalid_input', 0, /payout_address/);
  await rejectsWith(c.submit('j', { ...GOOD, payout_address: '5Kf3notbase' }), 'invalid_input', 0, /payout_address/);
  await rejectsWith(c.submit('j', { ...GOOD, repo_or_patch_url: 'http://github.com/x/y' }), 'invalid_input', 0, /https/);
  await rejectsWith(c.submit('j', { ...GOOD, repo_or_patch_url: 'not a url' }), 'invalid_input', 0, /https/);
  assert.equal(f.calls.length, 0);
});

test('A6 no console output from the client and no new runtime dependency', async () => {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/jobs.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bconsole\./);
  assert.doesNotMatch(src, /^import .* from ['"](?!\.)/m);
  const seen: unknown[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { seen.push(a); };
  try {
    const f = fakeFetch([json(500, { error: 'x' }), json(429, {}), json(200, { jobs: [], count: 0 })]);
    const c = createJobsClient({ baseUrl: BASE, fetch: f.fn, sleep: async () => {} });
    await c.listJobs();
    await c.submit('j', { ...GOOD, payout_address: 'bad' }).catch(() => {});
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(seen, []);
});

test('A7 integration: reads the live GET /jobs only when LAX_LIVE=1', { skip: process.env.LAX_LIVE !== '1' && 'set LAX_LIVE=1 to read the live registry' }, async () => {
  const c = createJobsClient();
  const list = await c.listJobs({ limit: 5 });
  assert.ok(Array.isArray(list.jobs));
  assert.ok(list.jobs.length <= 5);
  if (list.jobs[0]) assert.equal((await c.getJob(list.jobs[0].id)).id, list.jobs[0].id);
});
