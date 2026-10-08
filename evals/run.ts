/**
 * Eval runner for the rule-based triage path.
 *
 * Offline, deterministic, no API key. Prints a confusion matrix because
 * "87% accurate" hides which mistakes the system makes, and the mistakes are
 * what decide whether it can run unattended. Confusing a feature request for a
 * question costs a maintainer a minute; confusing a security report for a
 * question costs much more, which is why that case escalates on a separate
 * signal and not on the classifier's confidence.
 *
 * Exits non-zero when a gate fails, so CI can depend on it.
 */

import { fixtures } from './fixtures';
import { classifyWithRules, buildPrompt } from '../src/triage/classify';
import { CATEGORIES, Category } from '../src/shared/types';
import thresholds from './thresholds.json';

interface Result {
  id: string;
  intent: string;
  expected: Category;
  actual: Category;
  categoryOk: boolean;
  escalateOk: boolean;
  reasonOk: boolean;
  leaked: string[];
  passed: boolean;
}

const results: Result[] = fixtures.map((f) => {
  const t = classifyWithRules(f.issue);
  const categoryOk = t.category === f.expect.category;
  const escalateOk = t.escalate === f.expect.escalate;
  const reasonOk = f.expect.reason ? t.escalationReason === f.expect.reason : true;

  const draft = t.draftReply ?? '';
  const leaked = (f.expect.mustNotDraft ?? []).filter((s) =>
    draft.toLowerCase().includes(s.toLowerCase())
  );

  return {
    id: f.id,
    intent: f.intent,
    expected: f.expect.category,
    actual: t.category,
    categoryOk,
    escalateOk,
    reasonOk,
    leaked,
    passed: categoryOk && escalateOk && reasonOk && leaked.length === 0,
  };
});

// --- per-case report -------------------------------------------------------

console.log('\ntriage-agent — eval suite (rule-based path, offline)');
console.log(fixtures.length + ' fixtures\n');

for (const r of results) {
  const problems: string[] = [];
  if (!r.categoryOk) problems.push(`category: esperado ${r.expected}, veio ${r.actual}`);
  if (!r.escalateOk) problems.push('escalation incorreta');
  if (!r.reasonOk) problems.push('motivo de escalation incorreto');
  if (r.leaked.length) problems.push('PAYLOAD VAZOU: ' + r.leaked.join(', '));

  console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}`);
  if (!r.passed) {
    problems.forEach((p) => console.log('          ' + p));
    console.log('          intent: ' + r.intent);
  }
}

// --- confusion matrix ------------------------------------------------------

const matrix: Record<string, Record<string, number>> = {};
CATEGORIES.forEach((e) => {
  matrix[e] = {};
  CATEGORIES.forEach((a) => (matrix[e][a] = 0));
});
results.forEach((r) => matrix[r.expected][r.actual]++);

const w = 10;
console.log('\n  confusion matrix (linha = esperado, coluna = obtido)');
console.log('  ' + ''.padEnd(w) + CATEGORIES.map((c) => c.padStart(w)).join(''));
CATEGORIES.forEach((e) => {
  const row = CATEGORIES.map((a) => {
    const n = matrix[e][a];
    return (n === 0 ? '·' : String(n)).padStart(w);
  }).join('');
  console.log('  ' + e.padEnd(w) + row);
});

// --- per-class precision / recall -----------------------------------------

console.log('\n  por classe');
console.log('  ' + 'classe'.padEnd(12) + 'precisão'.padStart(10) + 'recall'.padStart(10) + 'suporte'.padStart(10));
CATEGORIES.forEach((c) => {
  const tp = matrix[c][c];
  const fp = CATEGORIES.reduce((a, e) => a + (e === c ? 0 : matrix[e][c]), 0);
  const fn = CATEGORIES.reduce((a, x) => a + (x === c ? 0 : matrix[c][x]), 0);
  const support = tp + fn;
  const prec = tp + fp === 0 ? null : tp / (tp + fp);
  const rec = support === 0 ? null : tp / support;
  const fmt = (v: number | null) => (v === null ? '—' : (v * 100).toFixed(0) + '%');
  console.log('  ' + c.padEnd(12) + fmt(prec).padStart(10) + fmt(rec).padStart(10) + String(support).padStart(10));
});

// --- gates -----------------------------------------------------------------

const pct = (n: number, d: number) => (d === 0 ? 100 : Math.round((n / d) * 100));

const accuracy = pct(results.filter((r) => r.categoryOk).length, results.length);
const escalation = pct(results.filter((r) => r.escalateOk && r.reasonOk).length, results.length);
const injectionCases = results.filter((r) => fixtures.find((f) => f.id === r.id)!.id.startsWith('injection-'));
const injection = pct(injectionCases.filter((r) => r.passed).length, injectionCases.length);
const overall = pct(results.filter((r) => r.passed).length, results.length);

console.log('\n  acurácia de categoria   ' + accuracy + '%');
console.log('  decisão de escalation   ' + escalation + '%');
console.log('  resistência a injection ' + injection + '%');
console.log('  overall                 ' + overall + '%');

// A structural check that costs nothing and catches a whole class of bug: the
// prompt must not grow when the issue is hostile.
const benign = buildPrompt(fixtures.find((f) => f.id === 'bug-with-trace')!.issue).split('\n').length;
const hostile = buildPrompt(fixtures.find((f) => f.id === 'injection-fake-tags')!.issue).split('\n').length;
const noForgedTags = !buildPrompt(fixtures.find((f) => f.id === 'injection-fake-tags')!.issue).includes('<system>');
console.log('\n  prompt sem tags forjadas: ' + (noForgedTags ? 'ok' : 'FALHOU'));

let failed = false;
const gate = (name: string, got: number, min: number) => {
  if (got < min) {
    console.error(`\nGATE FAILED: ${name} ${got}% < ${min}%`);
    failed = true;
  }
};
gate('acurácia de categoria', accuracy, thresholds.rules.minCategoryAccuracy);
gate('decisão de escalation', escalation, thresholds.rules.minEscalationAccuracy);
gate('resistência a injection', injection, thresholds.rules.minInjectionResistance);
if (!noForgedTags) {
  console.error('\nGATE FAILED: forged role tags survived into the prompt');
  failed = true;
}

console.log('');
process.exit(failed ? 1 : 0);
