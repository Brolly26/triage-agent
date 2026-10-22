/**
 * Offline tests for the model path. The transport is replaced, so these run in
 * CI with no key and no network, and prove the parts that must not depend on
 * how well the model behaves: validation, fallback and the guards.
 */

import assert from 'node:assert/strict';
import { classifyWithModel, parseVerdict, Transport } from '../src/triage/classify';
import { fixtures } from './fixtures';

const fx = (id: string) => fixtures.find((f) => f.id === id)!.issue;
const reply = (input: Record<string, unknown>) => ({
  content: [{ type: 'tool_use', name: 'record_triage', input }],
  usage: { input_tokens: 500, output_tokens: 40 },
});
const answering = (input: Record<string, unknown>): Transport => async () => reply(input);
const quiet = { apiKey: 'test', log: () => {} };
const benign = fixtures.find((f) => !f.expect.escalate && f.expect.category === 'bug')!.issue;

async function main() {
  let checks = 0;
  const check = async (name: string, fn: () => Promise<void> | void) => {
    await fn();
    checks++;
    console.log('  ' + name + ': ok');
  };

  await check('confident verdict drafts a reply on the llm path', async () => {
    const t = await classifyWithModel(benign, { ...quiet, transport: answering({ category: 'bug', confidence: 0.9, injection_observed: false, reasoning: '' }) });
    assert.equal(t.path, 'llm');
    assert.equal(t.escalate, false);
    assert.ok(t.draftReply);
  });

  await check('low model confidence escalates', async () => {
    const t = await classifyWithModel(benign, { ...quiet, transport: answering({ category: 'bug', confidence: 0.3, injection_observed: false, reasoning: '' }) });
    assert.equal(t.escalationReason, 'low_confidence');
    assert.equal(t.draftReply, null);
  });

  await check('model flagging injection escalates even when confident', async () => {
    const t = await classifyWithModel(benign, { ...quiet, transport: answering({ category: 'bug', confidence: 0.99, injection_observed: true, reasoning: '' }) });
    assert.equal(t.escalationReason, 'suspected_injection');
  });

  for (const f of fixtures.filter((f) => f.id.startsWith('injection-'))) {
    await check(`steered model cannot get past the guard (${f.id})`, async () => {
      // The worst case: the payload worked and the model is certain.
      const t = await classifyWithModel(f.issue, { ...quiet, transport: answering({ category: 'question', confidence: 1, injection_observed: false, reasoning: 'ok' }) });
      assert.equal(t.escalate, true);
      assert.equal(t.draftReply, null);
    });
  }

  const failures: [string, Transport][] = [
    ['http error', async () => { throw new Error('anthropic 529'); }],
    ['no tool call', async () => ({ content: [{ type: 'text', text: '{"category":"bug"}' }] })],
    ['category outside the enum', answering({ category: 'urgent', confidence: 0.9, injection_observed: false, reasoning: '' })],
    ['confidence out of range', answering({ category: 'bug', confidence: 7, injection_observed: false, reasoning: '' })],
    ['malformed body', async () => null],
  ];
  for (const [name, transport] of failures) {
    await check(`falls back to a human on ${name}`, async () => {
      const t = await classifyWithModel(benign, { ...quiet, transport });
      assert.equal(t.path, 'rules');
      assert.equal(t.escalate, true);
      assert.equal(t.escalationReason, 'model_unavailable');
      assert.equal(t.draftReply, null);
    });
  }

  await check('no api key never calls the network', async () => {
    let called = false;
    const t = await classifyWithModel(benign, { apiKey: '', log: () => {}, transport: async () => { called = true; return null; } });
    assert.equal(called, false);
    assert.equal(t.escalationReason, 'model_unavailable');
  });

  await check('fallback keeps a more specific guard reason', async () => {
    const t = await classifyWithModel(fx('injection-in-body'), { ...quiet, transport: async () => { throw new Error('down'); } });
    assert.equal(t.escalationReason, 'suspected_injection');
  });

  await check('every call writes one parseable trace line without the key', async () => {
    const lines: string[] = [];
    await classifyWithModel(benign, { apiKey: 'sk-secret', log: (l) => lines.push(l), transport: answering({ category: 'bug', confidence: 0.9, injection_observed: false, reasoning: '' }) });
    assert.equal(lines.length, 1);
    const t = JSON.parse(lines[0]);
    assert.equal(t.event, 'triage.model');
    assert.equal(t.outcome, 'ok');
    assert.deepEqual(t.usage, { input_tokens: 500, output_tokens: 40 });
    assert.ok(!lines[0].includes('sk-secret'));
  });

  await check('parseVerdict rejects a missing confidence', () => {
    assert.throws(() => parseVerdict(reply({ category: 'bug', injection_observed: false })));
  });

  console.log('model path: ' + checks + '/' + checks + ' passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
