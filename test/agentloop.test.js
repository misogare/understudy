import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgentLoop, extractJson } from '../src/runtime/agentloop.js';
import { buildToolset } from '../src/tools/index.js';
import { tmpDir, fakeProvider, textResponse, toolCallResponse } from './helpers.js';

function baseOpts(provider, extra = {}) {
  const cwd = extra.cwd || tmpDir();
  return {
    prompt: 'do the thing',
    label: 'test-agent',
    provider,
    model: 'fake-model',
    effort: null,
    toolset: buildToolset({ cwd, mode: extra.mode || 'workspace', config: {} }),
    cwd,
    usage: { input: 0, output: 0 },
    ...extra,
  };
}

test('tool loop: model reads a real file then answers', async () => {
  const cwd = tmpDir();
  writeFileSync(join(cwd, 'note.txt'), 'the secret is 42\n');
  let step = 0;
  const provider = fakeProvider(async ({ messages }) => {
    step++;
    if (step === 1) return toolCallResponse('Read', { file_path: 'note.txt' });
    const toolResult = messages[messages.length - 1];
    assert.equal(toolResult.role, 'tool');
    assert.match(toolResult.content, /the secret is 42/);
    return textResponse('answer: 42');
  });
  const out = await runAgentLoop(baseOpts(provider, { cwd }));
  assert.equal(out.ok, true);
  assert.equal(out.text, 'answer: 42');
  assert.equal(out.turns, 2);
});

test('schema retry: invalid StructuredOutput gets validation feedback, then succeeds', async () => {
  let step = 0;
  const provider = fakeProvider(async ({ messages }) => {
    step++;
    if (step === 1) return toolCallResponse('StructuredOutput', { wrong: true });
    const feedback = messages[messages.length - 1];
    assert.match(feedback.content, /failed validation/);
    return toolCallResponse('StructuredOutput', { n: 3 });
  });
  const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false };
  const out = await runAgentLoop(baseOpts(provider, { schema }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, { n: 3 });
});

test('schema salvage: fenced JSON in plain text is accepted', async () => {
  const provider = fakeProvider(async () => textResponse('Here you go:\n```json\n{"n": 9}\n```\ndone'));
  const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
  const out = await runAgentLoop(baseOpts(provider, { schema }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, { n: 9 });
});

test('read-only mode: Write tool is refused, loop continues', async () => {
  let step = 0;
  const provider = fakeProvider(async ({ messages }) => {
    step++;
    if (step === 1) return toolCallResponse('Write', { file_path: 'x.txt', content: 'hi' });
    assert.match(messages[messages.length - 1].content, /not available in read-only/);
    return textResponse('understood');
  });
  const out = await runAgentLoop(baseOpts(provider, { mode: 'read-only' }));
  assert.equal(out.ok, true);
});

test('workspace mode: writes outside the workspace are refused', async () => {
  const outside = join(tmpDir(), 'elsewhere.txt');
  let refusal = null;
  let step = 0;
  const provider = fakeProvider(async ({ messages }) => {
    step++;
    if (step === 1) return toolCallResponse('Write', { file_path: outside, content: 'x' });
    refusal = messages[messages.length - 1].content;
    return textResponse('ok');
  });
  await runAgentLoop(baseOpts(provider)); // cwd is a different tmp dir
  assert.match(refusal, /outside the workspace/);
});

test('terminal provider error surfaces as failed result', async () => {
  const provider = fakeProvider(async () => { throw Object.assign(new Error('HTTP 401'), { terminal: true }); });
  const out = await runAgentLoop(baseOpts(provider));
  assert.equal(out.ok, false);
  assert.match(out.error, /HTTP 401/);
});

test('extractJson: prefers last fenced block, falls back to braces', () => {
  assert.deepEqual(extractJson('x ```json\n{"a":1}\n``` y ```json\n{"a":2}\n``` z'), { a: 2 });
  assert.deepEqual(extractJson('noise {"b": [1,2]} trailing'), { b: [1, 2] });
  assert.equal(extractJson('no json here'), undefined);
});
