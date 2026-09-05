import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { globToRegex, toolGlob, toolGrep } from '../src/tools/search.js';
import { toolRead, toolWrite, toolEdit } from '../src/tools/fs.js';
import { parseAgentMd } from '../src/loader/agentmd.js';
import { tmpDir } from './helpers.js';

test('globToRegex: common patterns', () => {
  assert.ok(globToRegex('**/*.js').test('a/b/c.js'));
  assert.ok(globToRegex('**/*.js').test('c.js'));
  assert.ok(!globToRegex('**/*.js').test('c.jsx'));
  assert.ok(globToRegex('src/*.{ts,tsx}').test('src/a.tsx'));
  assert.ok(!globToRegex('src/*.{ts,tsx}').test('src/deep/a.ts'));
  assert.ok(globToRegex('*.py').test('x.py'));
  assert.ok(globToRegex('data?.csv').test('data1.csv'));
});

test('toolGlob finds files recursively, toolGrep JS path modes work', () => {
  const cwd = tmpDir();
  mkdirSync(join(cwd, 'sub'), { recursive: true });
  writeFileSync(join(cwd, 'a.txt'), 'hello alpha\nsecond line\n');
  writeFileSync(join(cwd, 'sub', 'b.txt'), 'hello beta\nhello again\n');
  writeFileSync(join(cwd, 'sub', 'c.md'), 'nothing here\n');

  const g = toolGlob({ pattern: '**/*.txt' }, cwd);
  assert.match(g.result, /a\.txt/);
  assert.match(g.result, /b\.txt/);
  assert.ok(!/c\.md/.test(g.result));

  const files = toolGrep({ pattern: 'hello', output_mode: 'files_with_matches' }, cwd);
  assert.match(files.result, /a\.txt/);
  assert.match(files.result, /b\.txt/);

  const count = toolGrep({ pattern: 'hello', output_mode: 'count', glob: '*.txt' }, cwd);
  assert.match(count.result, /b\.txt:2/);

  const content = toolGrep({ pattern: 'ALPHA', output_mode: 'content', ignoreCase: true }, cwd);
  assert.match(content.result, /a\.txt:1/);
});

test('toolRead numbers lines and honors offset/limit', () => {
  const cwd = tmpDir();
  const p = join(cwd, 'f.txt');
  writeFileSync(p, 'one\ntwo\nthree\nfour\n');
  const r = toolRead({ file_path: p, offset: 2, limit: 2 });
  assert.match(r.result, /^\s+2\ttwo\n\s+3\tthree/);
});

test('toolEdit enforces uniqueness and supports replace_all', () => {
  const cwd = tmpDir();
  const p = join(cwd, 'f.txt');
  writeFileSync(p, 'aaa bbb aaa\n');
  const dup = toolEdit({ file_path: p, old_string: 'aaa', new_string: 'xxx' });
  assert.match(dup.error, /occurs 2 times/);
  const all = toolEdit({ file_path: p, old_string: 'aaa', new_string: 'xxx', replace_all: true });
  assert.match(all.result, /replaced 2/);
  assert.equal(readFileSync(p, 'utf8'), 'xxx bbb xxx\n');
  const gone = toolEdit({ file_path: p, old_string: 'zzz', new_string: 'q' });
  assert.match(gone.error, /not found/);
});

test('toolEdit does not expand $-patterns in replacements', () => {
  const cwd = tmpDir();
  const p = join(cwd, 'f.txt');
  writeFileSync(p, 'value = OLD\n');
  toolEdit({ file_path: p, old_string: 'OLD', new_string: "$' and $& stay literal" });
  assert.equal(readFileSync(p, 'utf8'), "value = $' and $& stay literal\n");
});

test('toolWrite creates parent directories', () => {
  const cwd = tmpDir();
  const p = join(cwd, 'deep', 'nested', 'f.txt');
  const r = toolWrite({ file_path: p, content: 'x' });
  assert.match(r.result, /wrote 1 bytes/);
  assert.equal(readFileSync(p, 'utf8'), 'x');
});

test('parseAgentMd: frontmatter + body', () => {
  const { frontmatter, body } = parseAgentMd(`---
name: reviewer
description: Reviews things carefully
tools: Read, Grep
model: sonnet
---
You are a careful reviewer.
Check everything twice.`);
  assert.equal(frontmatter.name, 'reviewer');
  assert.deepEqual(frontmatter.tools, ['Read', 'Grep']);
  assert.equal(frontmatter.model, 'sonnet');
  assert.match(body, /^You are a careful reviewer/);
});
