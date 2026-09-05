import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'understudy-test-'));
}

// A scripted provider whose chat() is a plain function you control.
// Return shape must match providers/openai.js normalize().
export function fakeProvider(handler, { name = 'fake' } = {}) {
  return {
    name,
    type: 'mock',
    cfg: {},
    client: { name, type: 'mock', chat: handler },
    modelFor: () => 'fake-model',
    extraBodyFor: () => null,
  };
}

export function textResponse(text, out = 5) {
  return {
    text, reasoning: null, toolCalls: [], finishReason: 'stop',
    usage: { input: 5, output: out },
    assistantMessage: { role: 'assistant', content: text },
  };
}

export function toolCallResponse(name, args, id = 'call_1') {
  const argStr = JSON.stringify(args);
  return {
    text: '', reasoning: null,
    toolCalls: [{ id, name, args: argStr }],
    finishReason: 'tool_calls',
    usage: { input: 5, output: 5 },
    assistantMessage: {
      role: 'assistant', content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: argStr } }],
    },
  };
}

export function lastUser(messages) {
  return [...messages].reverse().find((m) => m.role === 'user')?.content || '';
}
