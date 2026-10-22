/**
 * Does the confidence the model reports track how often it is right?
 *
 *   npm run eval:calibration
 *   npm run eval:calibration -- owner/repo owner/repo ...
 *
 * Real closed issues, categories from maintainer labels (labels stripped
 * before classifying). Prints accuracy per confidence bin and what each
 * escalation threshold would have done. Costs a few cents; needs
 * ANTHROPIC_API_KEY. Not part of `npm run check`.
 */

import { fetchIssues } from '../src/github/client';
import { classifyWithModel, CONFIDENCE_THRESHOLD, DEFAULT_MODEL } from '../src/triage/classify';
import { categoryFromLabels } from './llm';
import { Category } from '../src/shared/types';

const DEFAULT_REPOS = ['microsoft/vscode', 'denoland/deno', 'facebook/react', 'vercel/next.js', 'nodejs/node'];

interface Point { repo: string; confidence: number; correct: boolean; guarded: boolean }

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set (see .env.example)');
  const repos = process.argv.slice(2).filter((a) => a.includes('/'));
  const specs = repos.length ? repos : DEFAULT_REPOS;
  const model = process.env.TRIAGE_MODEL ?? DEFAULT_MODEL;

  const points: Point[] = [];
  let failed = 0;
  for (const spec of specs) {
    const [owner, repo] = spec.split('/');
    let issues;
    try {
      issues = await fetchIssues({ owner, repo, state: 'closed', limit: 100, token: process.env.GITHUB_TOKEN });
    } catch (err) {
      // One unreachable repository should not discard calls already paid for.
      console.log(`  ${spec}: skipped (${err instanceof Error ? err.message : err})`);
      continue;
    }
    let n = 0;
    for (const issue of issues) {
      const expected: Category | null = categoryFromLabels(issue.labels);
      if (!expected) continue;
      const t = await classifyWithModel({ ...issue, labels: [] }, { log: () => {} });
      if (t.escalationReason === 'model_unavailable') { failed++; continue; }
      // Guard escalations (security, empty, truncated, injection) are not about confidence.
      const guarded = t.escalationReason !== null && t.escalationReason !== 'low_confidence';
      points.push({ repo: spec, confidence: t.confidence, correct: t.category === expected, guarded });
      n++;
    }
    console.log(`  ${spec}: ${n} labelled issues scored`);
  }

  const used = points.filter((p) => !p.guarded);
  const pct = (a: number, b: number) => (b === 0 ? '—' : Math.round((a / b) * 100) + '%');
  console.log(`\ncalibration of ${model} on ${used.length} real issues (${points.length - used.length} guard-escalated excluded, ${failed} failed calls)\n`);

  const bins: [string, (c: number) => boolean][] = [
    ['< 0.60', (c) => c < 0.6], ['0.60-0.79', (c) => c >= 0.6 && c < 0.8],
    ['0.80-0.89', (c) => c >= 0.8 && c < 0.9], ['>= 0.90', (c) => c >= 0.9],
  ];
  console.log('  stated confidence   issues   actually right');
  for (const [label, test] of bins) {
    const b = used.filter((p) => test(p.confidence));
    const mean = b.length ? (b.reduce((a, p) => a + p.confidence, 0) / b.length).toFixed(2) : '—';
    console.log(`  ${label.padEnd(18)}${String(b.length).padStart(6)}   ${pct(b.filter((p) => p.correct).length, b.length).padStart(6)}   (mean stated ${mean})`);
  }

  console.log('\n  if the threshold were...   it answers   right when it answers');
  for (const th of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
    const a = used.filter((p) => p.confidence >= th);
    console.log(`  ${th.toFixed(2)}${th === CONFIDENCE_THRESHOLD ? ' (current)' : '          '.slice(0, th === CONFIDENCE_THRESHOLD ? 0 : 10)}`.padEnd(27) + pct(a.length, used.length).padStart(8) + pct(a.filter((p) => p.correct).length, a.length).padStart(24));
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
