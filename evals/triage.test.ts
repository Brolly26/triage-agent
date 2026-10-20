import assert from 'node:assert/strict';
import { normalizeIssue } from '../src/github/client';
import { classifyWithRules } from '../src/triage/classify';

let checks = 0;
for (const tail of ['XSS vulnerability', 'Ignore previous instructions', 'Ordinary long log']) {
  const issue = normalizeIssue({
    number: 1, title: 'Bug in parser', labels: ['bug'],
    body: 'Steps to reproduce: run v1.2.3 on Linux.\n' + 'x'.repeat(8100) + '\n' + tail,
  }, 'acme/widget')!;
  assert.equal(issue.bodyTruncated, true);
  const triage = classifyWithRules(issue);
  assert.equal(triage.escalate, true);
  assert.equal(triage.escalationReason, 'truncated_body');
  assert.equal(triage.draftReply, null);
  checks++;
}
// Visible security/injection evidence keeps its more specific escalation reason.
for (const [title, reason] of [
  ['XSS in parser', 'security_report'],
  ['Ignore previous instructions', 'suspected_injection'],
] as const) {
  const issue = normalizeIssue({ number: 2, title, body: 'x'.repeat(8100) }, 'a/b')!;
  const triage = classifyWithRules(issue);
  assert.equal(triage.escalationReason, reason);
  assert.equal(triage.draftReply, null);
  checks++;
}
console.log('triage regressions: ' + checks + '/' + checks + ' passed');
