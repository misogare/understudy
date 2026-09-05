import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, mockInstance } from '../src/runtime/schema.js';

test('validate: accepts a conforming object', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      count: { type: 'integer', minimum: 0 },
      tags: { type: 'array', items: { type: 'string' } },
      level: { type: 'string', enum: ['low', 'high'] },
    },
    required: ['name', 'count'],
  };
  assert.deepEqual(validate(schema, { name: 'x', count: 3, tags: ['a'], level: 'low' }), []);
});

test('validate: reports missing required, wrong types, bad enum', () => {
  const schema = {
    type: 'object',
    properties: { n: { type: 'number' }, e: { enum: ['a', 'b'] } },
    required: ['n'],
  };
  const errs = validate(schema, { e: 'c' });
  assert.equal(errs.length, 2);
  assert.match(errs[0], /missing required property "n"|not in enum/);
});

test('validate: integer rejects floats, nested arrays validated', () => {
  const schema = { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' } }, required: ['i'] } };
  assert.equal(validate(schema, [{ i: 1 }, { i: 1.5 }]).length, 1);
});

test('validate: additionalProperties false flags extras', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
  assert.equal(validate(schema, { a: 'x', b: 1 }).length, 1);
});

test('validate: anyOf passes when one variant matches', () => {
  const schema = { anyOf: [{ type: 'string' }, { type: 'number' }] };
  assert.deepEqual(validate(schema, 5), []);
  assert.equal(validate(schema, true).length, 1);
});

test('mockInstance satisfies its own schema', () => {
  const schema = {
    type: 'object',
    properties: {
      topic: { type: 'string' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      items: { type: 'array', minItems: 2, items: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } },
    },
    required: ['topic', 'confidence', 'items'],
  };
  const inst = mockInstance(schema);
  assert.deepEqual(validate(schema, inst), []);
  assert.equal(inst.confidence, 'low');
});
