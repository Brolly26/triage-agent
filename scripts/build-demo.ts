/**
 * Build docs/index.html: a static page of recorded results from a real run.
 *
 *   npx ts-node scripts/build-demo.ts
 *
 * The page calls no API and holds no key; every number on it comes from this
 * script, which fetches real closed issues and scores the rules against the
 * labels maintainers applied (labels stripped before classifying). If
 * docs/model-results.json exists (written by eval:llm) the model row is filled
 * in; until then the page says "not measured" instead of leaving a gap.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchIssues } from '../src/github/client';
import { classifyWithRules, classifyWithModel, Transport } from '../src/triage/classify';
import { Category, Issue } from '../src/shared/types';
import { categoryFromLabels } from '../evals/llm';
import { fixtures } from '../evals/fixtures';

const REPOS = ['microsoft/vscode', 'denoland/deno'];

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const pct = (n: number, d: number) => (d === 0 ? '—' : Math.round((n / d) * 100) + '%');

interface Row { issue: Issue; expected: Category; got: Category; escalated: boolean; reason: string | null; confidence: number }

async function collect(spec: string): Promise<Row[]> {
  const [owner, repo] = spec.split('/');
  const issues = await fetchIssues({ owner, repo, state: 'closed', limit: 100 });
  return issues.flatMap((issue) => {
    const expected = categoryFromLabels(issue.labels);
    if (!expected) return [];
    const t = classifyWithRules({ ...issue, labels: [] });
    return [{ issue, expected, got: t.category, escalated: t.escalate, reason: t.escalationReason, confidence: t.confidence }];
  });
}

async function main() {
  const byRepo: Record<string, Row[]> = {};
  for (const spec of REPOS) byRepo[spec] = await collect(spec);

  const summary = REPOS.map((spec) => {
    const rows = byRepo[spec];
    const auto = rows.filter((r) => !r.escalated);
    return {
      spec,
      n: rows.length,
      accuracy: pct(rows.filter((r) => r.got === r.expected).length, rows.length),
      escalated: pct(rows.filter((r) => r.escalated).length, rows.length),
      auto: pct(auto.filter((r) => r.got === r.expected).length, auto.length),
    };
  });

  // A spread of real cases: some answered, some escalated, in whatever mix the run produced.
  const all = REPOS.flatMap((s) => byRepo[s]);
  const answered = all.filter((r) => !r.escalated).slice(0, 3);
  const escalated = all.filter((r) => r.escalated).slice(0, 4);
  const examples = [...answered, ...escalated];

  // The worst case for the model path: the payload works and the model is certain.
  const steered: Transport = async () => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ category: 'question', confidence: 1, injection_observed: false, reasoning: 'ok' }) }],
  });
  const attacks = [];
  for (const f of fixtures.filter((x) => x.id.startsWith('injection-'))) {
    const t = await classifyWithModel(f.issue, { apiKey: 'demo', transport: steered, log: () => {} });
    attacks.push({ id: f.id, title: f.issue.title, body: f.issue.body.slice(0, 220), t });
  }

  const modelFile = 'docs/model-results.json';
  const model: { model: string; rows: { spec: string; n: number; accuracy: string; escalated: string; auto: string }[] } | null =
    existsSync(modelFile) ? JSON.parse(readFileSync(modelFile, 'utf8')) : null;

  const today = new Date().toISOString().slice(0, 10);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>triage-agent results</title>
<meta name="description" content="Recorded results from running a GitHub issue triage classifier on real issues.">
<style>
:root{--bg:#fff;--fg:#1c1f24;--mute:#5b6370;--line:#dfe3e8;--card:#f6f8fa;--warn:#8a5a00;--warnbg:#fff4d6;--ok:#116329;--bad:#a40e26}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1318;--fg:#e6e9ed;--mute:#9aa4b2;--line:#2a313a;--card:#171c23;--warn:#f0c36d;--warnbg:#2d2410;--ok:#5fd07f;--bad:#ff8a9b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.7rem;margin:0 0 4px}h2{font-size:1.2rem;margin:40px 0 8px}
p{margin:8px 0}.mute{color:var(--mute)}
.note{background:var(--warnbg);color:var(--warn);border-radius:8px;padding:12px 14px;margin:20px 0}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:.95rem}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mute);font-weight:600}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.tag{display:inline-block;font-size:.8rem;padding:1px 8px;border-radius:99px;border:1px solid var(--line)}
.esc{color:var(--bad)}.fine{color:var(--ok)}
code,pre{font:.85rem ui-monospace,Menlo,Consolas,monospace}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:8px 0}
a{color:inherit}.scroll{overflow-x:auto}
</style>
</head>
<body>
<main>
<h1>triage-agent</h1>
<p class="mute">Recorded results, generated ${esc(today)} by <code>scripts/build-demo.ts</code>. This page calls no API and holds no key.</p>
<p>A classifier for GitHub issues that knows when not to decide alone. <a href="https://github.com/Brolly26/triage-agent">Source and README</a>.</p>

<div class="note"><strong>Status.</strong> ${model ? `The model row below was recorded with <code>${esc(model.model)}</code>.` : 'The Claude path is built and tested offline, but <strong>has not been scored</strong>: that needs an API key. Its row says so instead of showing a number.'}</div>

<h2>Rules vs model, on real closed issues</h2>
<p class="mute">Ground truth is the label a maintainer applied. The labels are removed before classifying. Issues whose labels say nothing, or disagree, are dropped.</p>
<div class="scroll"><table>
<tr><th>Path</th><th>Repository</th><th class="n">Issues</th><th class="n">Accuracy</th><th class="n">Escalated</th><th class="n">Accuracy when it answers</th></tr>
${summary.map((s) => `<tr><td>rules</td><td>${esc(s.spec)}</td><td class="n">${s.n}</td><td class="n">${s.accuracy}</td><td class="n">${s.escalated}</td><td class="n">${s.auto}</td></tr>`).join('\n')}
${model ? model.rows.map((s) => `<tr><td>${esc(model.model)}</td><td>${esc(s.spec)}</td><td class="n">${s.n}</td><td class="n">${esc(s.accuracy)}</td><td class="n">${esc(s.escalated)}</td><td class="n">${esc(s.auto)}</td></tr>`).join('\n') : '<tr><td>Claude</td><td colspan="5" class="mute">not measured yet</td></tr>'}
</table></div>
<p>The pattern to read: on real text the rules are rarely sure enough to answer, and right when they do. ${model ? 'The model answers far more often and is wrong on a share of what it answers alone. That is a trade of coverage for caution, and whether it is worth it depends on what a wrong automatic label costs.' : ''}</p>
<p class="mute">Small samples. Treat these as anecdotes, not benchmarks.</p>

<h2>Real issues, one by one</h2>
${examples.map((r) => `<div class="card">
<div><a href="https://github.com/${esc(r.issue.repo)}/issues/${r.issue.number}">${esc(r.issue.repo)}#${r.issue.number}</a> ${esc(r.issue.title)}</div>
<p class="mute">maintainer label: <strong>${esc(r.expected)}</strong> · rules said: <strong>${esc(r.got)}</strong> (confidence ${r.confidence})</p>
<p>${r.escalated ? `<span class="esc">Escalated to a human: ${esc(r.reason ?? '')}. No reply drafted.</span>` : `<span class="fine">Answered by itself${r.got === r.expected ? ', correctly.' : ', and got it wrong.'}</span>`}</p>
</div>`).join('\n')}

<h2>Prompt injection: what happens when the model is fully fooled</h2>
<p>Issues are written by strangers. The model decides only the category and its confidence; escalation checks, priority and reply templates are plain code. To test the worst case, the model here is <strong>simulated</strong> to answer "question, confidence 1.0" for every attack, as if the payload had completely worked.</p>
${attacks.map((a) => `<div class="card">
<p class="mute"><code>${esc(a.id)}</code></p>
<pre>${esc(a.title)}\n${esc(a.body)}</pre>
<p>${a.t.escalate ? `<span class="fine">Held for a human: ${esc(a.t.escalationReason ?? '')}.</span>` : '<span class="esc">NOT held.</span>'} Draft reply: <strong>${a.t.draftReply === null ? 'none' : 'WRITTEN'}</strong>.</p>
</div>`).join('\n')}
<p class="mute">This shows the code path, not that a real model resists semantic injection. The README says the same.</p>
</main>
</body>
</html>
`;
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/index.html', html);
  console.log(`wrote docs/index.html: ${summary.map((s) => `${s.spec} ${s.n} issues`).join(', ')}, ${examples.length} examples, ${attacks.length} attacks`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
