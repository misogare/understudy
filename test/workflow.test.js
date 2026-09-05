import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runWorkflow, extractMeta, BudgetExceededError } from '../src/runtime/workflow.js';
import { tmpDir, fakeProvider, textResponse, lastUser } from './helpers.js';

function opts(extra) {
  return {
    outRoot: tmpDir(),
    runId: 'uwf_test',
    mode: 'read-only',
    cwd: process.cwd(),
    config: {},
    ...extra,
  };
}

test('extractMeta: handles nested braces, strings and comments', () => {
  const src = `
// a comment with { braces }
export const meta = {
  name: 'x', // trailing { comment
  description: "has } brace and { brace",
  phases: [{ title: 'A', detail: \`tick { deep } \` }],
}
return 1
`;
  const { meta, error } = extractMeta(src);
  assert.equal(error, null);
  assert.equal(meta.name, 'x');
  assert.equal(meta.phases.length, 1);
});

test('extractMeta: missing meta or missing fields errors', () => {
  assert.match(extractMeta('return 1').error, /no `export const meta/);
  assert.match(extractMeta('export const meta = { name: "x" }').error, /must declare/);
});

test('pipeline: no barrier semantics, throw drops lane to null, stage gets (prev, item, index)', async () => {
  const calls = [];
  const provider = fakeProvider(async ({ messages }) => {
    const p = lastUser(messages);
    calls.push(p);
    if (p.includes('fail-me')) throw Object.assign(new Error('terminal'), { terminal: true });
    return textResponse(`ok:${p}`);
  });
  const source = `
export const meta = { name: 't', description: 'd' }
const out = await pipeline(['a', 'fail-me', 'c'],
  (item) => agent('step1 ' + item, { label: 'one' }),
  (prev, item, i) => prev === null ? null : agent('step2 ' + item + ' idx' + i + ' got:' + prev, { label: 'two' }))
return out
`;
  const { result } = await runWorkflow({ ...opts(), source, provider });
  assert.equal(result.length, 3);
  assert.match(result[0], /^ok:step2 a idx0 got:ok:step1 a/);
  assert.equal(result[1], null); // agent returned null -> stage2 mapped to null
  assert.match(result[2], /idx2/);
});

test('parallel: barrier, thunk throw resolves to null', async () => {
  const provider = fakeProvider(async ({ messages }) => textResponse('r:' + lastUser(messages)));
  const source = `
export const meta = { name: 't', description: 'd' }
const out = await parallel([
  () => agent('one'),
  () => { throw new Error('boom') },
  () => agent('three'),
])
return out
`;
  const { result } = await runWorkflow({ ...opts(), source, provider });
  assert.equal(result[0], 'r:one');
  assert.equal(result[1], null);
  assert.equal(result[2], 'r:three');
});

test('schema: structured value is returned as an object', async () => {
  const provider = fakeProvider(async ({ tools }) => {
    const so = (tools || []).find((t) => t.function.name === 'StructuredOutput');
    assert.ok(so, 'StructuredOutput tool offered');
    const args = JSON.stringify({ n: 7 });
    return {
      text: '', reasoning: null,
      toolCalls: [{ id: 'c1', name: 'StructuredOutput', args }],
      finishReason: 'tool_calls', usage: { input: 1, output: 1 },
      assistantMessage: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'StructuredOutput', arguments: args } }] },
    };
  });
  const source = `
export const meta = { name: 't', description: 'd' }
const v = await agent('give n', { schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } })
return v.n * 2
`;
  const { result } = await runWorkflow({ ...opts(), source, provider });
  assert.equal(result, 14);
});

test('resume: second run reuses journal results without calling the provider', async () => {
  let calls = 0;
  const provider = fakeProvider(async ({ messages }) => { calls++; return textResponse('v:' + lastUser(messages)); });
  const source = `
export const meta = { name: 't', description: 'd' }
const a = await agent('alpha')
const b = await agent('beta')
return [a, b]
`;
  const root = tmpDir();
  const r1 = await runWorkflow({ ...opts({ outRoot: root, runId: 'uwf_one' }), source, provider });
  assert.equal(calls, 2);
  assert.deepEqual(r1.result, ['v:alpha', 'v:beta']);

  const r2 = await runWorkflow({
    ...opts({ outRoot: root, runId: 'uwf_two' }),
    source, provider,
    resumeJournalPath: join(root, 'uwf_one', 'journal.jsonl'),
  });
  assert.equal(calls, 2, 'no new provider calls on resume');
  assert.deepEqual(r2.result, ['v:alpha', 'v:beta']);
});

test('guarded intrinsics: Math.random and Date.now throw inside scripts', async () => {
  const provider = fakeProvider(async () => textResponse('x'));
  for (const expr of ['Math.random()', 'Date.now()', 'new Date()']) {
    const source = `
export const meta = { name: 't', description: 'd' }
return ${expr}
`;
    await assert.rejects(
      runWorkflow({ ...opts(), source, provider }),
      /not available in workflow scripts/,
      expr,
    );
  }
});

test('budget: agent() throws once output budget is exhausted', async () => {
  const provider = fakeProvider(async ({ messages }) => textResponse('v', 10));
  const source = `
export const meta = { name: 't', description: 'd' }
const a = await agent('one')
const b = await agent('two') // budget 5 < 10 spent by now
return [a, b]
`;
  await assert.rejects(
    runWorkflow({ ...opts(), source, provider, budgetTotal: 5 }),
    /budget exhausted/,
  );
});

test('run record: written with result, counts and status', async () => {
  const provider = fakeProvider(async () => textResponse('hi'));
  const source = `
export const meta = { name: 'rec', description: 'd', phases: [{ title: 'P' }] }
phase('P')
log('working')
return await agent('x', { label: 'only', phase: 'P' })
`;
  const root = tmpDir();
  const { record, runDir } = await runWorkflow({ ...opts({ outRoot: root, runId: 'uwf_rec' }), source, provider });
  assert.equal(record.status, 'completed');
  assert.equal(record.workflowName, 'rec');
  assert.equal(record.agentCount, 1);
  assert.equal(record.result, 'hi');
  assert.ok(record.logs.some((l) => l.includes('working')));
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(join(runDir, 'result.json')));
  assert.ok(existsSync(join(runDir, 'summary.md')));
  assert.ok(existsSync(join(runDir, 'wf_rec.json')));
  assert.ok(existsSync(join(runDir, 'journal.jsonl')));
});

test('script errors fail the workflow with a record attached', async () => {
  const provider = fakeProvider(async () => textResponse('x'));
  const source = `
export const meta = { name: 't', description: 'd' }
throw new Error('script exploded')
`;
  await assert.rejects(runWorkflow({ ...opts(), source, provider }), /script exploded/);
});

test('args are exposed and other exports are rejected', async () => {
  const provider = fakeProvider(async () => textResponse('x'));
  const good = `
export const meta = { name: 't', description: 'd' }
return args.items.map((x) => x * 2)
`;
  const { result } = await runWorkflow({ ...opts(), source: good, provider, args: { items: [1, 2] } });
  assert.deepEqual(result, [2, 4]);

  const bad = `
export const meta = { name: 't', description: 'd' }
export const other = 1
return 1
`;
  await assert.rejects(runWorkflow({ ...opts(), source: bad, provider }), /only export/);
});
