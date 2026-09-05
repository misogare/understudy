// Regression tests for the findings confirmed by the adversarial review.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toolEdit } from '../src/tools/fs.js';
import { buildToolset } from '../src/tools/index.js';
import { stripBom } from '../src/config.js';
import { buildCliArgs, normalizeArgSpec } from '../src/providers/cli.js';
import { extractMeta, runWorkflow } from '../src/runtime/workflow.js';
import { runAgentLoop } from '../src/runtime/agentloop.js';
import { Journal } from '../src/runtime/journal.js';
import { tmpDir, fakeProvider, textResponse, toolCallResponse, lastUser } from './helpers.js';

// ── CRLF editing ────────────────────────────────────────────────────────

test('CRLF: multi-line old_string with LF endings matches a CRLF file and preserves CRLF', () => {
  const p = join(tmpDir(), 'f.txt');
  writeFileSync(p, 'alpha\r\nbeta\r\ngamma\r\n');
  const r = toolEdit({ file_path: p, old_string: 'alpha\nbeta', new_string: 'one\ntwo' });
  assert.match(r.result, /replaced 1/);
  assert.equal(readFileSync(p, 'utf8'), 'one\r\ntwo\r\ngamma\r\n');
});

test('CRLF: single-line edit with multi-line replacement adapts new_string EOLs', () => {
  const p = join(tmpDir(), 'f.txt');
  writeFileSync(p, 'header\r\nbody\r\n');
  toolEdit({ file_path: p, old_string: 'header', new_string: 'header\nsubtitle' });
  assert.equal(readFileSync(p, 'utf8'), 'header\r\nsubtitle\r\nbody\r\n');
});

// ── permission modes ────────────────────────────────────────────────────

test('buildToolset fails CLOSED on an unknown mode', () => {
  assert.throws(() => buildToolset({ cwd: tmpDir(), mode: 'ful' }), /invalid permission mode/);
});

test('read-only + CLI provider is refused, not silently bypassed', async () => {
  const provider = { name: 'x', type: 'cli', client: { run: async () => { throw new Error('must not be called'); } }, modelFor: () => 'm', extraBodyFor: () => null };
  const out = await runAgentLoop({
    prompt: 'p', label: 'l', provider, model: 'm', effort: null,
    toolset: buildToolset({ cwd: tmpDir(), mode: 'read-only', config: {} }),
    cwd: tmpDir(), usage: { input: 0, output: 0 }, mode: 'read-only',
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /read-only mode cannot be enforced/);
});

// ── structured output ───────────────────────────────────────────────────

test('hallucinated StructuredOutput without a schema is rejected, not returned', async () => {
  let step = 0;
  const provider = fakeProvider(async ({ messages }) => {
    step++;
    if (step === 1) return toolCallResponse('StructuredOutput', { sneaky: true });
    assert.match(messages[messages.length - 1].content, /no structured output was requested/);
    return textResponse('proper answer');
  });
  const cwd = tmpDir();
  const out = await runAgentLoop({
    prompt: 'p', label: 'l', provider, model: 'm', effort: null,
    toolset: buildToolset({ cwd, mode: 'workspace', config: {} }),
    cwd, usage: { input: 0, output: 0 },
  });
  assert.equal(out.ok, true);
  assert.equal(out.text, 'proper answer');
});

test('delegated CLI schema retry actually delivers the validation feedback', async () => {
  const prompts = [];
  const provider = {
    name: 'fakecli', type: 'cli',
    client: {
      run: async ({ prompt }) => {
        prompts.push(prompt);
        return prompts.length === 1
          ? { text: 'not json at all', exitCode: 0, stderr: '' }
          : { text: '```json\n{"n": 4}\n```', exitCode: 0, stderr: '' };
      },
    },
    modelFor: () => 'm', extraBodyFor: () => null,
  };
  const out = await runAgentLoop({
    prompt: 'give n', label: 'l', provider, model: 'm', effort: null,
    schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
    toolset: buildToolset({ cwd: tmpDir(), mode: 'workspace', config: {} }),
    cwd: tmpDir(), usage: { input: 0, output: 0 }, mode: 'workspace',
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, { n: 4 });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /did not contain valid JSON/, 'second attempt carries the feedback');
  assert.match(prompts[1], /not json at all/, 'second attempt echoes the failed output');
});

// ── resume chains ───────────────────────────────────────────────────────

test('cache hits are re-emitted so a chained resume stays complete', async () => {
  let calls = 0;
  const provider = fakeProvider(async ({ messages }) => { calls++; return textResponse('v:' + lastUser(messages)); });
  const source = `
export const meta = { name: 't', description: 'd' }
return [await agent('a1'), await agent('a2')]
`;
  const root = tmpDir();
  const base = { source, provider, mode: 'read-only', cwd: process.cwd(), config: {}, outRoot: root };
  await runWorkflow({ ...base, runId: 'uwf_r1' });
  await runWorkflow({ ...base, runId: 'uwf_r2', resumeJournalPath: join(root, 'uwf_r1', 'journal.jsonl') });
  assert.equal(calls, 2);
  // Third run resumes from the SECOND run's journal — previously empty.
  await runWorkflow({ ...base, runId: 'uwf_r3', resumeJournalPath: join(root, 'uwf_r2', 'journal.jsonl') });
  assert.equal(calls, 2, 'chained resume must not re-run completed agents');
});

// ── budget conformance ──────────────────────────────────────────────────

test('budget exhaustion inside parallel resolves lanes to null; the call never rejects', async () => {
  const provider = fakeProvider(async () => textResponse('v', 10));
  const source = `
export const meta = { name: 't', description: 'd' }
const first = await agent('warmup') // spends 10 >= budget 5
const out = await parallel([() => agent('a'), () => agent('b')])
return { first, out }
`;
  const { result } = await runWorkflow({
    source, provider, mode: 'read-only', cwd: process.cwd(), config: {},
    outRoot: tmpDir(), runId: 'uwf_b', budgetTotal: 5,
  });
  assert.equal(result.first, 'v');
  assert.deepEqual(result.out, [null, null]);
});

// ── static meta parser ──────────────────────────────────────────────────

test('extractMeta never evaluates: computed keys, calls and interpolation are rejected', () => {
  globalThis.__pwned = false;
  const evil1 = `export const meta = { [ (globalThis.__pwned = true, 'name') ]: 'x', description: 'd' }`;
  const evil2 = 'export const meta = { name: `a${globalThis.__pwned = true}`, description: "d" }';
  const evil3 = `export const meta = { name: pwn(), description: 'd' }`;
  for (const src of [evil1, evil2, evil3]) {
    const { meta, error } = extractMeta(src);
    assert.equal(meta, null, src);
    assert.match(error, /pure literal/);
  }
  assert.equal(globalThis.__pwned, false, 'no code ran during meta extraction');
});

test('extractMeta still parses real-world meta literals statically', () => {
  const { meta, error } = extractMeta(`
export const meta = {
  name: 'review-changes', // trailing comment
  description: "has } brace and 'quotes'",
  phases: [
    { title: 'Find', detail: 'a\\nb' },
    { title: 'Verify' },
  ],
}
`);
  assert.equal(error, null);
  assert.equal(meta.name, 'review-changes');
  assert.equal(meta.phases.length, 2);
  assert.equal(meta.phases[0].detail, 'a\nb');
});

// ── CLI arg assembly ────────────────────────────────────────────────────

test('buildCliArgs: freebuff keeps --free when the prompt moves to stdin (shim)', () => {
  const cfg = { staticArgs: ['--free'], promptArgs: ['{prompt}'], promptVia: 'arg' };
  const viaArg = buildCliArgs(cfg, { prompt: 'hello world', model: 'cli-default', mode: 'workspace', shim: false });
  assert.deepEqual(viaArg.args, ['--free', 'hello world']);
  assert.equal(viaArg.viaStdin, false);
  const viaStdin = buildCliArgs(cfg, { prompt: 'hello world', model: 'cli-default', mode: 'workspace', shim: true });
  assert.deepEqual(viaStdin.args, ['--free'], 'tier flag survives; prompt never enters cmd.exe argv');
  assert.equal(viaStdin.viaStdin, true);
});

test('buildCliArgs: model flag pair dropped wholesale when no concrete model; fullModeArgs gated', () => {
  const cfg = { modelArgs: ['-m', '{model}'], promptVia: 'stdin', fullModeArgs: ['--allow-all-tools'] };
  const none = buildCliArgs(cfg, { prompt: 'p', model: 'cli-default', mode: 'workspace', shim: false });
  assert.deepEqual(none.args, [], 'no dangling -m');
  const withModel = buildCliArgs(cfg, { prompt: 'p', model: 'gemini-2.5-pro', mode: 'full', shim: false });
  assert.deepEqual(withModel.args, ['-m', 'gemini-2.5-pro', '--allow-all-tools']);
});

test('normalizeArgSpec splits legacy args, pairing flags with their placeholders', () => {
  const g = normalizeArgSpec({ args: ['--free', '-p', '{prompt}', '-m', '{model}', '--quiet'] });
  assert.deepEqual(g.staticArgs, ['--free', '--quiet']);
  assert.deepEqual(g.promptArgs, ['-p', '{prompt}']);
  assert.deepEqual(g.modelArgs, ['-m', '{model}']);
});

// ── misc ────────────────────────────────────────────────────────────────

test('stripBom removes a UTF-8 BOM', () => {
  assert.equal(stripBom('﻿{"a":1}'), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
});

test('journal: failed entries do not block a later identical successful key', () => {
  const dir = tmpDir();
  const j1 = new Journal(join(dir, 'j.jsonl'));
  const k = j1.keyFor({ prompt: 'x' });
  j1.failed(k, 'agent-001', 'quota');
  j1.result(j1.keyFor({ prompt: 'x' }), 'agent-002', 'ok'); // occurrence #1
  const j2 = new Journal(join(dir, 'j2.jsonl'), join(dir, 'j.jsonl'));
  const k2 = j2.keyFor({ prompt: 'x' });
  assert.equal(j2.lookup(k2), undefined, 'occurrence 0 failed, stays uncached');
  assert.equal(j2.lookup(j2.keyFor({ prompt: 'x' })), 'ok', 'occurrence 1 cached');
});
