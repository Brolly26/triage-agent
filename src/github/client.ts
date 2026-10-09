/**
 * GitHub issues collector.
 *
 * The interesting part of this file is not fetching JSON — it is the three
 * ways a real API makes you work for it:
 *
 *   1. PAGINATION. The REST API paginates through the `Link` header, not
 *      through a field in the body. There is no total count, so you follow
 *      `rel="next"` until it stops appearing. Guessing page numbers breaks
 *      silently when a repository changes between requests.
 *   2. RATE LIMITS. Two different signals, and they mean different things.
 *      `X-RateLimit-Remaining: 0` with `X-RateLimit-Reset` is the primary
 *      quota and is predictable: you can see it coming and slow down before
 *      hitting zero. A 403 or 429 carrying `Retry-After` is the secondary
 *      limit, triggered by request bursts, and it is not predictable — you
 *      only learn about it by being told to wait.
 *   3. INCONSISTENT DATA. Issues are written by strangers. Bodies come back
 *      null, empty, or a megabyte of pasted logs. Pull requests arrive
 *      through the issues endpoint and have to be filtered out.
 *
 * No token is required for public repositories, but unauthenticated requests
 * get 60/hour against 5000/hour. The client works either way.
 */

import { Issue } from '../shared/types';

/** Bodies above this are truncated. Long enough for a real report with a
 *  stack trace, short enough that a pasted log cannot blow up the context. */
const MAX_BODY_CHARS = 8000;

/** Stop proactively when the remaining quota reaches this, leaving room for
 *  whatever else is using the same token. */
const QUOTA_FLOOR = 5;

export interface FetchOptions {
  owner: string;
  repo: string;
  /** Hard cap on issues returned, so a caller cannot start an unbounded crawl. */
  limit?: number;
  state?: 'open' | 'closed' | 'all';
  /** Personal access token. Optional; raises the rate limit when present. */
  token?: string;
  /** Injected so tests can run without a network. */
  fetchImpl?: typeof fetch;
  /** Injected so tests do not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Called with each retry/backoff decision, for tracing. */
  onEvent?: (e: ClientEvent) => void;
}

export type ClientEvent =
  | { type: 'page'; url: string; received: number }
  | { type: 'rate_limit_pause'; ms: number; reason: 'quota' | 'retry_after' }
  | { type: 'retry'; attempt: number; ms: number; status: number | null }
  | { type: 'skipped'; number: number; reason: 'pull_request' | 'unusable' }
  | { type: 'truncated'; number: number; from: number };

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Parse the `Link` header for the next page.
 * Returns null at the last page, which is how the loop terminates.
 */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not decoration: without it, every client that got rate-limited by
 * the same burst retries at the same instant and reproduces the burst. Full
 * jitter (random between 0 and the ceiling) spreads them out better than
 * adding a small random offset to a fixed delay.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(1000 * Math.pow(2, attempt), 30000);
  return Math.floor(random() * ceiling);
}

/**
 * How long to wait before the next request, read from the response.
 * Returns 0 when nothing says to wait.
 */
export function pauseFromHeaders(headers: Headers, now: number = Date.now()): { ms: number; reason: 'quota' | 'retry_after' } | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return { ms: Math.min(secs * 1000, 120000), reason: 'retry_after' };
    }
    // Retry-After may also be an HTTP date.
    const when = Date.parse(retryAfter);
    if (!Number.isNaN(when)) {
      // A past date, or `Retry-After: 0`, yields ms 0 — a truthy pause of no
      // duration, which replaces exponential backoff with a tight retry loop
      // against a server that has just asked us to slow down.
      const ms = Math.max(0, Math.min(when - now, 120000));
      return ms > 0 ? { ms, reason: 'retry_after' } : null;
    }
  }

  // Number(null) is 0, so reading an ABSENT x-ratelimit-remaining as a number
  // makes a missing header indistinguishable from an exhausted quota, and the
  // crawler sleeps up to two minutes per page for nothing. Proxies, GHE and
  // cache layers all drop these headers. Ask whether they are there first.
  const rawRemaining = headers.get('x-ratelimit-remaining');
  const rawReset = headers.get('x-ratelimit-reset');
  if (rawRemaining === null || rawReset === null) return null;

  const remaining = Number(rawRemaining);
  const reset = Number(rawReset);
  if (Number.isFinite(remaining) && remaining <= QUOTA_FLOOR && Number.isFinite(reset)) {
    // Reset is a UTC epoch in SECONDS.
    const ms = reset * 1000 - now;
    if (ms > 0) return { ms: Math.min(ms, 120000), reason: 'quota' };
  }
  return null;
}

/**
 * Normalise one raw issue object. Returns null for things that should not
 * enter the pipeline — a pull request, or a record missing the fields the
 * rest of the system assumes.
 */
export function normalizeIssue(raw: any, repo: string, onEvent?: (e: ClientEvent) => void): Issue | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.pull_request) {
    onEvent?.({ type: 'skipped', number: raw.number ?? -1, reason: 'pull_request' });
    return null;
  }
  if (typeof raw.number !== 'number' || typeof raw.title !== 'string') {
    onEvent?.({ type: 'skipped', number: raw?.number ?? -1, reason: 'unusable' });
    return null;
  }

  // `body` is null for an issue submitted with the field left empty.
  const rawBody = typeof raw.body === 'string' ? raw.body : '';
  const truncated = rawBody.length > MAX_BODY_CHARS;
  if (truncated) onEvent?.({ type: 'truncated', number: raw.number, from: rawBody.length });

  return {
    number: raw.number,
    repo,
    title: raw.title,
    body: truncated ? rawBody.slice(0, MAX_BODY_CHARS) : rawBody,
    author: raw.user?.login ?? 'unknown',
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((l: any) => (typeof l === 'string' ? l : l?.name)).filter((n: any) => typeof n === 'string')
      : [],
    commentCount: typeof raw.comments === 'number' ? raw.comments : 0,
    state: raw.state === 'closed' ? 'closed' : 'open',
    bodyTruncated: truncated,
  };
}

/** One request with retries. Retries only what is worth retrying. */
async function requestWithRetry(
  url: string,
  opts: FetchOptions,
  maxAttempts = 4
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'triage-agent',
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  let lastError: GitHubError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { headers });
    } catch (err: any) {
      // Network-level failure: retryable.
      lastError = new GitHubError(String(err?.message ?? err), null, true);
      // Sleeping after the final attempt buys nothing: the loop exits and
      // throws regardless. With Retry-After at 120s that was two wasted
      // minutes on every doomed request, four in total, with the caller
      // printing nothing the whole time.
      if (attempt === maxAttempts - 1) break;
      const ms = backoffMs(attempt);
      opts.onEvent?.({ type: 'retry', attempt, ms, status: null });
      await sleep(ms);
      continue;
    }

    if (res.ok) {
      const pause = pauseFromHeaders(res.headers);
      if (pause) {
        opts.onEvent?.({ type: 'rate_limit_pause', ms: pause.ms, reason: pause.reason });
        await sleep(pause.ms);
      }
      return res;
    }

    // 403 and 429 are the rate-limit shapes; 5xx is transient.
    const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
    if (!retryable) {
      throw new GitHubError(`GitHub returned ${res.status}`, res.status, false);
    }

    const pause = pauseFromHeaders(res.headers);
    const ms = pause ? pause.ms : backoffMs(attempt);
    opts.onEvent?.(
      pause
        ? { type: 'rate_limit_pause', ms, reason: pause.reason }
        : { type: 'retry', attempt, ms, status: res.status }
    );
    lastError = new GitHubError(`GitHub returned ${res.status}`, res.status, true);
    if (attempt === maxAttempts - 1) break;
    await sleep(ms);
  }

  throw lastError ?? new GitHubError('exhausted retries', null, true);
}

/**
 * Fetch issues, following pagination until the cap or the last page.
 * Returns only usable issues; pull requests and malformed records are dropped
 * and reported through `onEvent`.
 */
export async function fetchIssues(opts: FetchOptions): Promise<Issue[]> {
  const limit = opts.limit ?? 100;
  const repo = `${opts.owner}/${opts.repo}`;
  const perPage = Math.min(100, limit);
  let url: string | null =
    `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues` +
    `?state=${opts.state ?? 'open'}&per_page=${perPage}&sort=created&direction=desc`;

  const out: Issue[] = [];

  while (url && out.length < limit) {
    const res: Response = await requestWithRetry(url, opts);
    const body: unknown = await res.json();

    if (!Array.isArray(body)) {
      throw new GitHubError('expected an array of issues', res.status, false);
    }
    opts.onEvent?.({ type: 'page', url, received: body.length });

    for (const raw of body) {
      if (out.length >= limit) break;
      const issue = normalizeIssue(raw, repo, opts.onEvent);
      if (issue) out.push(issue);
    }

    url = parseNextLink(res.headers.get('link'));
  }

  return out;
}
