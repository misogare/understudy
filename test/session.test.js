import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveSession, shortSession } from '../src/session.js';
import { runWorkflow } from '../src/runtime/workflow.js';
import { listRuns, collectRun } from '../src/handoff/collect.js';
import { tmpDir, fakeProvider, textResponse } from './helpers.js';

test('resolveSession: flag > UNDERSTUDY_SESSION > CLAUDE_CODE_SESSION_ID > null, sanitized', () => {
  const env = { UNDERSTUDY_SESSION: 'env-one', CLAUDE_CODE_SESSION_ID: 'claude-two' };
  assert.equal(resolveSession('flag/../evil id', env), 'flag-..-evil-id'); // path chars sanitized away
  assert.equal(resolveSession(null, env), 'env-one');
  assert.equal(resolveSession(null, { CLAUDE_CODE_SESSION_ID: 'claude-two' }), 'claude-two');
  assert.equal(resolveSession(null, {}), null);
  assert.equal(resolveSession('....', {}), null, 'nothing but stripped chars -> null');
  assert.equal(shortSession('b345f3a9-e6f5'), 'b345f3a9');
  assert.equal(shortSession(null), '-');
});

test('runs are tagged with session and collect scopes to it', async () => {
  const provider = fakeProvider(async () => textResponse('x'));
  const source = `
export const meta = { name: 't', description: 'd' }
return await agent('a')
`;
  const root = tmpDir();
  const base = { source, provider, mode: 'read-only', cwd: process.cwd(), config: {}, outRoot: root };
  await runWorkflow({ ...base, runId: 'uwf_s1a', session: 'sess-one' });
  await new Promise((r) => setTimeout(r, 20)); // distinct mtimes
  await runWorkflow({ ...base, runId: 'uwf_s2a', session: 'sess-two' });

  const runs = listRuns(root);
  assert.deepEqual(runs.map((r) => r.session).sort(), ['sess-one', 'sess-two']);

  // Latest overall is sess-two's run; sess-one still collects its own.
  const mine = collectRun(root, null, 'sess-one');
  assert.equal(mine.run.runId, 'uwf_s1a');
  assert.equal(mine.sessionFallback, false);

  const theirs = collectRun(root, null, 'sess-two');
  assert.equal(theirs.run.runId, 'uwf_s2a');

  // Unknown session falls back to global latest, flagged.
  const fresh = collectRun(root, null, 'sess-three');
  assert.equal(fresh.sessionFallback, true);
  assert.equal(fresh.run.runId, 'uwf_s2a');

  // No session: plain global latest, no flag.
  const any = collectRun(root, null, null);
  assert.equal(any.run.runId, 'uwf_s2a');
  assert.equal(any.sessionFallback, false);

  // Explicit runId always wins regardless of session.
  const exact = collectRun(root, 'uwf_s1a', 'sess-two');
  assert.equal(exact.run.runId, 'uwf_s1a');
});
