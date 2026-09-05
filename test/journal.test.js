import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Journal, stableStringify } from '../src/runtime/journal.js';
import { tmpDir } from './helpers.js';

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test('identical payloads get distinct occurrence-suffixed keys', () => {
  const j = new Journal(join(tmpDir(), 'j.jsonl'));
  const p = { prompt: 'x', schema: null, effort: null, model: null, agentType: null };
  const k1 = j.keyFor(p);
  const k2 = j.keyFor(p);
  const k3 = j.keyFor({ ...p, prompt: 'y' });
  assert.notEqual(k1, k2);
  assert.equal(k2, `${k1}#1`);
  assert.notEqual(k1, k3);
  assert.match(k1, /^v2:[0-9a-f]{64}$/);
});

test('resume: results written by one journal are readable by the next', () => {
  const dir = tmpDir();
  const path = join(dir, 'journal.jsonl');
  const j1 = new Journal(path);
  const key = j1.keyFor({ prompt: 'a' });
  j1.started(key, 'agent-001');
  j1.result(key, 'agent-001', { answer: 42 });
  const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].type, 'result');

  const j2 = new Journal(join(dir, 'journal2.jsonl'), path);
  const key2 = j2.keyFor({ prompt: 'a' });
  assert.equal(key2, key);
  assert.deepEqual(j2.lookup(key2), { answer: 42 });
  assert.equal(j2.lookup(j2.keyFor({ prompt: 'b' })), undefined);
});

test('failed entries are not served as cached results', () => {
  const dir = tmpDir();
  const path = join(dir, 'journal.jsonl');
  const j1 = new Journal(path);
  const key = j1.keyFor({ prompt: 'a' });
  j1.failed(key, 'agent-001', 'boom');
  const j2 = new Journal(join(dir, 'j2.jsonl'), path);
  assert.equal(j2.lookup(j2.keyFor({ prompt: 'a' })), undefined);
});
