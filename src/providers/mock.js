// Deterministic fake provider — dry-run any workflow with zero API calls and
// zero keys. If the request offers a StructuredOutput tool, it "calls" it with
// a minimal instance generated from the schema; otherwise it returns a short
// text acknowledging the prompt. This exercises the full workflow topology
// (phases, pipeline/parallel wiring, journal, run records) for free.

import { mockInstance } from '../runtime/schema.js';

export function makeMockProvider(cfg = {}) {
  return {
    name: cfg.name || 'mock',
    type: 'mock',
    async chat({ messages, tools }) {
      const structured = (tools || []).find((t) => t?.function?.name === 'StructuredOutput');
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const promptHead = String(lastUser?.content ?? '').slice(0, 80).replace(/\s+/g, ' ');
      if (structured) {
        const schema = structured.function.parameters || {};
        return {
          text: '',
          reasoning: null,
          toolCalls: [{ id: 'call_mock_1', name: 'StructuredOutput', args: JSON.stringify(mockInstance(schema)) }],
          finishReason: 'tool_calls',
          usage: { input: 10, output: 10 },
          assistantMessage: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: 'StructuredOutput', arguments: JSON.stringify(mockInstance(schema)) } }],
          },
        };
      }
      const text = `[mock] acknowledged: ${promptHead}`;
      return {
        text, reasoning: null, toolCalls: [], finishReason: 'stop',
        usage: { input: 10, output: 10 },
        assistantMessage: { role: 'assistant', content: text },
      };
    },
  };
}
