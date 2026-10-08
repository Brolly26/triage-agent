/**
 * GitHub client checks, with `fetch` and `sleep` injected.
 *
 * No network. The failure modes this file exists to pin — a paginated crawl, a
 * secondary rate limit, a null body, a pull request arriving through the
 * issues endpoint — are exactly the ones you cannot reproduce on demand
 * against the real API, which is why they are simulated and asserted here
 * instead of discovered in production.
 */

import {
  parseNextLink,
  backoffMs,
  pauseFromHeaders,
  normalizeIssue,
  fetchIssues,
  GitHubError,
  ClientEvent,
} from '../src/github/client';

interface Check { name: string; ok: boolean; detail?: string }
const checks: Check[] = [];
const ok = (name: string, pass: boolean, detail?: string) => checks.push({ name, ok: pass, detail });

// --- Link header parsing ---------------------------------------------------
const link =
  '<https://api.github.com/repositories/1/issues?page=2>; rel="next", ' +
  '<https://api.github.com/repositories/1/issues?page=9>; rel="last"';
ok('finds rel=next', parseNextLink(link) === 'https://api.github.com/repositories/1/issues?page=2');
ok('null on last page', parseNextLink('<https://x/?page=1>; rel="prev"') === null);
ok('null on absent header', parseNextLink(null) === null);

// --- backoff ---------------------------------------------------------------
ok('backoff is bounded', [0, 1, 2, 5, 10].every((a) => backoffMs(a, () => 1) <= 30000));
ok('backoff grows', backoffMs(0, () => 1) < backoffMs(3, () => 1));
ok('backoff jitters to zero', backoffMs(5, () => 0) === 0);
ok('backoff caps at 30s', backoffMs(20, () => 0.999) <= 30000);

// --- rate-limit headers ----------------------------------------------------
const NOW = 1_000_000_000_000;
const h = (o: Record<string, string>) => new Headers(o);

ok('no pause when quota is healthy',
  pauseFromHeaders(h({ 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String(NOW / 1000 + 600) }), NOW) === null);

const quota = pauseFromHeaders(h({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': String(NOW / 1000 + 30) }), NOW);
ok('pauses when quota is nearly spent', quota?.reason === 'quota' && quota.ms > 0, JSON.stringify(quota));

const retry = pauseFromHeaders(h({ 'retry-after': '12' }), NOW);
ok('honours Retry-After seconds', retry?.reason === 'retry_after' && retry.ms === 12000, JSON.stringify(retry));

ok('Retry-After outranks quota',
  pauseFromHeaders(h({ 'retry-after': '5', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 900) }), NOW)?.reason === 'retry_after');

ok('pause is capped at 120s',
  (pauseFromHeaders(h({ 'retry-after': '9999' }), NOW)?.ms ?? 0) === 120000);

// --- normalisation of inconsistent data ------------------------------------
ok('null body becomes empty string', normalizeIssue({ number: 1, title: 't', body: null }, 'a/b')?.body === '');
ok('pull request is dropped', normalizeIssue({ number: 2, title: 't', pull_request: {} }, 'a/b') === null);
ok('record without a number is dropped', normalizeIssue({ title: 't' }, 'a/b') === null);
ok('non-object is dropped', normalizeIssue('nope', 'a/b') === null);
ok('labels as objects are flattened',
  JSON.stringify(normalizeIssue({ number: 3, title: 't', labels: [{ name: 'bug' }, 'raw'] }, 'a/b')?.labels) === '["bug","raw"]');

const huge = normalizeIssue({ number: 4, title: 't', body: 'x'.repeat(50000) }, 'a/b');
ok('oversized body is truncated', (huge?.body.length ?? 0) <= 8000, String(huge?.body.length));
ok('truncation is flagged', huge?.bodyTruncated === true);

// --- pagination and retries, end to end ------------------------------------
function response(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function run(label: string, fn: () => Promise<void>) {
  try { await fn(); } catch (e: any) { ok(label + ' (threw)', false, String(e?.message ?? e)); }
}

async function main() {
await run('pagination', async () => {
  const pages = [
    response([{ number: 1, title: 'a' }, { number: 2, title: 'b', pull_request: {} }],
      { headers: { link: '<https://api.github.com/page2>; rel="next"' } }),
    response([{ number: 3, title: 'c' }]),
  ];
  let i = 0;
  const events: ClientEvent[] = [];
  const issues = await fetchIssues({
    owner: 'a', repo: 'b', limit: 50,
    fetchImpl: async () => pages[i++],
    sleepImpl: async () => {},
    onEvent: (e) => events.push(e),
  });
  ok('follows rel=next across pages', issues.length === 2, `got ${issues.length}`);
  ok('drops pull requests mid-page', !issues.some((x) => x.number === 2));
  ok('reports each page', events.filter((e) => e.type === 'page').length === 2);
  ok('reports the skipped PR', events.some((e) => e.type === 'skipped' && e.reason === 'pull_request'));
});

await run('limit', async () => {
  const issues = await fetchIssues({
    owner: 'a', repo: 'b', limit: 2,
    fetchImpl: async () => response([{ number: 1, title: 'a' }, { number: 2, title: 'b' }, { number: 3, title: 'c' }],
      { headers: { link: '<https://api.github.com/page2>; rel="next"' } }),
    sleepImpl: async () => {},
  });
  ok('honours the limit', issues.length === 2, `got ${issues.length}`);
});

await run('secondary rate limit', async () => {
  let calls = 0;
  const slept: number[] = [];
  const issues = await fetchIssues({
    owner: 'a', repo: 'b',
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return response({ message: 'slow down' }, { status: 429, headers: { 'retry-after': '3' } });
      return response([{ number: 7, title: 'ok' }]);
    },
    sleepImpl: async (ms) => { slept.push(ms); },
  });
  ok('retries after a 429', issues.length === 1 && calls === 2, `calls=${calls}`);
  ok('waits the Retry-After interval', slept.includes(3000), JSON.stringify(slept));
});

await run('non-retryable', async () => {
  let calls = 0;
  try {
    await fetchIssues({
      owner: 'a', repo: 'b',
      fetchImpl: async () => { calls++; return response({ message: 'Not Found' }, { status: 404 }); },
      sleepImpl: async () => {},
    });
    ok('404 is not retried', false, 'no error thrown');
  } catch (e) {
    ok('404 throws GitHubError', e instanceof GitHubError && (e as GitHubError).status === 404);
    ok('404 is not retried', calls === 1, `calls=${calls}`);
  }
});

await run('transient network failure', async () => {
  let calls = 0;
  const issues = await fetchIssues({
    owner: 'a', repo: 'b',
    fetchImpl: async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNRESET');
      return response([{ number: 9, title: 'recovered' }]);
    },
    sleepImpl: async () => {},
  });
  ok('recovers from a network error', issues.length === 1 && calls === 3, `calls=${calls}`);
});

  // --- report ----------------------------------------------------------------
  const failed = checks.filter((c) => !c.ok);
  console.log('\ntriage-agent — GitHub client checks');
  for (const c of checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${!c.ok && c.detail ? `  (${c.detail})` : ''}`);
  }
  console.log(`  ${checks.length - failed.length}/${checks.length} passed\n`);
  process.exit(failed.length ? 1 : 0);

}

main().catch((e) => {
  console.error('client.test crashed:', e);
  process.exit(3);
});