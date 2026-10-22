import assert from 'node:assert/strict';
import { parseTarget, format } from '../src/cli';
import { fetchIssue } from '../src/github/client';
import { classifyWithRules } from '../src/triage/classify';
import { fixtures } from './fixtures';

let checks = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { checks++; console.log('  ' + name + ': ok'); });

const json = (body: unknown, status = 200) =>
  async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

(async () => {
  await ok('parses owner/repo#n', () => assert.deepEqual(parseTarget('microsoft/vscode#123'), { owner: 'microsoft', repo: 'vscode', number: 123 }));
  await ok('accepts dots and dashes in names', () => assert.equal(parseTarget('a.b/c-d_e#1')?.repo, 'c-d_e'));
  for (const bad of [undefined, '', 'microsoft/vscode', 'vscode#1', 'a/b#x', 'a/b#1/extra', '../x/y#1'])
    await ok(`rejects ${JSON.stringify(bad)}`, () => assert.equal(parseTarget(bad), null));

  await ok('fetchIssue reads one issue', async () => {
    const issue = await fetchIssue({ owner: 'a', repo: 'b', number: 7, fetchImpl: json({ number: 7, title: 'Crash on save', body: 'x', state: 'open', labels: [] }) as any });
    assert.equal(issue.number, 7);
    assert.equal(issue.repo, 'a/b');
  });
  await ok('fetchIssue refuses a pull request', async () => {
    await assert.rejects(fetchIssue({ owner: 'a', repo: 'b', number: 8, fetchImpl: json({ number: 8, title: 't', pull_request: {} }) as any }), /pull request/);
  });
  await ok('fetchIssue surfaces a 404', async () => {
    await assert.rejects(fetchIssue({ owner: 'a', repo: 'b', number: 9, fetchImpl: json({ message: 'Not Found' }, 404) as any, sleepImpl: async () => {} }));
  });

  await ok('escalated output says why and drafts nothing', () => {
    const f = fixtures.find((x) => x.expect.escalate)!;
    const out = format(f.issue, classifyWithRules(f.issue));
    assert.match(out, /ESCALATE/);
    assert.doesNotMatch(out, /draft reply/);
  });
  await ok('handled output shows the draft', () => {
    const f = fixtures.find((x) => !x.expect.escalate)!;
    assert.match(format(f.issue, classifyWithRules(f.issue)), /draft reply/);
  });

  console.log('cli: ' + checks + '/' + checks + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });
