/**
 * One real run against the public GitHub API — no token, no mocks.
 *
 * The eval suite injects `fetch`, which is right for CI: it is fast,
 * deterministic and offline. But it means every assumption about the real API
 * is only an assumption. This script is the counterweight: it crawls two busy
 * repositories, runs the deterministic triage over what comes back, and prints
 * what it actually saw — pages followed, rate-limit pauses, issues skipped,
 * bodies truncated, and the triage distribution.
 *
 * Unauthenticated GitHub allows 60 requests per hour, which is plenty for a
 * capped crawl and is itself worth exercising: the quota path is the one most
 * likely to be wrong, and here it is real.
 *
 *   npx ts-node scripts/smoke.ts [owner/repo ...]
 */

import { fetchIssues, ClientEvent } from '../src/github/client';
import { classifyWithRules } from '../src/triage/classify';
import { Issue } from '../src/shared/types';

const DEFAULT_REPOS = ['microsoft/vscode', 'denoland/deno'];
const LIMIT = 40;

function pct(n: number, d: number): string {
  return d === 0 ? '—' : Math.round((n / d) * 100) + '%';
}

async function crawl(spec: string) {
  const [owner, repo] = spec.split('/');
  const events: ClientEvent[] = [];
  const started = Date.now();

  let issues: Issue[];
  try {
    issues = await fetchIssues({
      owner,
      repo,
      limit: LIMIT,
      onEvent: (e) => events.push(e),
    });
  } catch (err: any) {
    console.log(`\n${spec}: FAILED — ${err?.message ?? err}`);
    return;
  }

  const pages = events.filter((e) => e.type === 'page').length;
  const skipped = events.filter((e) => e.type !== 'page');
  const truncated = issues.filter((i) => i.bodyTruncated).length;
  const emptyBody = issues.filter((i) => !i.body || i.body.trim() === '').length;

  console.log(`\n${spec}`);
  console.log(`  ${issues.length} issues over ${pages} page(s) in ${Date.now() - started}ms`);
  console.log(`  empty bodies: ${emptyBody} (${pct(emptyBody, issues.length)})` +
              `   truncated: ${truncated}`);

  if (skipped.length) {
    const kinds: Record<string, number> = {};
    skipped.forEach((e) => { kinds[e.type] = (kinds[e.type] || 0) + 1; });
    console.log('  client events: ' +
      Object.entries(kinds).map(([k, v]) => `${k}=${v}`).join(' '));
  }

  const byCategory: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  const escalations: Record<string, number> = {};
  let drafted = 0;

  for (const issue of issues) {
    const t = classifyWithRules(issue);
    byCategory[t.category] = (byCategory[t.category] || 0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
    if (t.escalationReason) {
      escalations[t.escalationReason] = (escalations[t.escalationReason] || 0) + 1;
    } else {
      drafted++;
    }
  }

  const fmt = (o: Record<string, number>) =>
    Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ') || '—';

  console.log('  category:   ' + fmt(byCategory));
  console.log('  priority:   ' + fmt(byPriority));
  console.log('  escalated:  ' + fmt(escalations) +
    `   (${pct(issues.length - drafted, issues.length)} of the batch)`);

  const sample = issues.find((i) => i.body && i.body.length > 200);
  if (sample) {
    const t = classifyWithRules(sample);
    console.log(`  sample #${sample.number}: ${t.category}/${t.priority}` +
      (t.escalationReason ? ` -> escalated (${t.escalationReason})` : ' -> drafted') +
      `  "${sample.title.slice(0, 54)}"`);
  }
}

async function main() {
  const specs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_REPOS;
  console.log(`Real GitHub crawl, unauthenticated, ${LIMIT} issues per repo.`);
  for (const spec of specs) await crawl(spec);
  console.log('');
}

main().catch((e) => { console.error('smoke run failed:', e); process.exit(1); });
