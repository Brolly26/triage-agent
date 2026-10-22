import assert from 'node:assert/strict';
import { labelsFor, addLabels } from '../src/action';
import { classifyWithRules } from '../src/triage/classify';
import { fixtures } from './fixtures';

let checks = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => { await fn(); checks++; console.log('  ' + name + ': ok'); };

(async () => {
  await ok('escalated issue gets needs-human', () => {
    const f = fixtures.find((x) => x.expect.escalate)!;
    assert.ok(labelsFor(classifyWithRules(f.issue)).includes('needs-human'));
  });
  await ok('handled issue does not', () => {
    const f = fixtures.find((x) => !x.expect.escalate)!;
    const labels = labelsFor(classifyWithRules(f.issue));
    assert.ok(!labels.includes('needs-human'));
    assert.ok(labels.some((l) => l.startsWith('triage:')) && labels.some((l) => l.startsWith('priority:')));
  });
  await ok('labels never contain issue text', () => {
    for (const f of fixtures) for (const l of labelsFor(classifyWithRules(f.issue))) assert.match(l, /^(triage:\w+|priority:p\d|needs-human)$/);
  });
  await ok('addLabels posts only to the labels endpoint, with the token', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    await addLabels('a/b', 5, ['triage:bug'], 'tok', (async (url: any, init: any) => { seen = { url, init }; return new Response('[]', { status: 200 }); }) as any);
    assert.equal(seen!.url, 'https://api.github.com/repos/a/b/issues/5/labels');
    assert.equal(seen!.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(seen!.init.body)), { labels: ['triage:bug'] });
  });
  await ok('addLabels fails loudly on HTTP errors', async () => {
    await assert.rejects(addLabels('a/b', 5, ['x'], 't', (async () => new Response('', { status: 403 })) as any), /403/);
  });
  console.log('action: ' + checks + '/' + checks + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });
