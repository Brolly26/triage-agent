/**
 * GitHub Action entry point: label a newly opened issue.
 *
 * It only ever adds labels. It never comments, closes or edits, because a
 * label is cheap to undo and a posted reply is not. Escalated issues get
 * `needs-human`, and nothing is drafted for them anyway.
 *
 * The issue arrives as the event payload file, never through shell
 * interpolation, so an issue title cannot become a command.
 */

import { readFileSync } from 'node:fs';
import { normalizeIssue } from './github/client';
import { classifyWithRules, classifyWithModel } from './triage/classify';
import { Triage } from './shared/types';

export function labelsFor(t: Triage): string[] {
  const labels = [`triage:${t.category}`, `priority:${t.priority}`];
  if (t.escalate) labels.push('needs-human');
  return labels;
}

export async function addLabels(
  repo: string, number: number, labels: string[], token: string, fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${number}/labels`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ labels }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`labelling failed: HTTP ${res.status}`);
}

async function main(): Promise<number> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!eventPath || !repo) {
    console.error('GITHUB_EVENT_PATH and GITHUB_REPOSITORY are required (this runs inside GitHub Actions).');
    return 2;
  }
  const payload = JSON.parse(readFileSync(eventPath, 'utf8'));
  const issue = normalizeIssue(payload.issue, repo);
  if (!issue) {
    console.log('not an issue (or unreadable); nothing to do');
    return 0;
  }

  // Claude only when a key is configured; otherwise the rules, which is the
  // path the repo has measured.
  const t = process.env.ANTHROPIC_API_KEY ? await classifyWithModel(issue) : classifyWithRules(issue);
  const labels = labelsFor(t);
  console.log(`#${issue.number} via ${t.path}: ${labels.join(', ')}${t.escalationReason ? ` (${t.escalationReason})` : ''}`);

  if (process.env.DRY_RUN === 'true') return 0;
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('GITHUB_TOKEN is required to apply labels (or set DRY_RUN=true).');
    return 2;
  }
  await addLabels(repo, issue.number, labels, token);
  return 0;
}

if (require.main === module) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
}
