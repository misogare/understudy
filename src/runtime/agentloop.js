// One agent() call = one run of this loop.
//
// For 'openai'/'mock' providers: a standard function-calling tool loop —
// Understudy executes Read/Write/Edit/Glob/Grep/Bash/WebFetch locally and
// feeds results back until the model returns its answer (or calls
// StructuredOutput when a schema was requested).
//
// For 'cli' providers (freebuff, gemini CLI, copilot CLI): the whole task is
// delegated — the CLI has its own tools and loop. We compose one prompt, run
// it in the workspace, and parse stdout (fenced JSON for schemas, with one
// validation-feedback retry).

import { appendFileSync } from 'node:fs';
import { validate } from './schema.js';

const MAX_TURNS_DEFAULT = 40;
const CLAMP_CHARS_DEFAULT = 30000;
const SCHEMA_NUDGES = 2;

export function buildSystemPrompt({ toolset, schema, cwd, label, agentBody, delegated, mode = 'workspace' }) {
  const lines = [];
  lines.push(`You are "${label || 'subagent'}", an autonomous subagent inside an automated workflow (run by Understudy, a model-agnostic runner for Claude Code-style workflows).`);
  lines.push('You are not talking to a human. Your final output is machine-read as your return value.');
  lines.push('');
  lines.push(`Working directory: ${cwd}`);
  lines.push(`Platform: ${process.platform}`);
  lines.push('');
  lines.push('Rules:');
  if (delegated) {
    lines.push('- Use your own tools to inspect files and do the work in the working directory.');
    if (mode === 'read-only') lines.push('- READ-ONLY: do NOT create, modify or delete any file, and do not run state-changing commands.');
    else if (mode === 'workspace') lines.push('- Only create or modify files INSIDE the working directory; never outside it.');
  } else {
    const names = toolset.defs.map((d) => d.function.name).filter((n) => n !== 'StructuredOutput');
    lines.push(`- Use the provided function tools to inspect files and do the work: ${names.join(', ')}.`);
    lines.push('- Tool names match Claude Code conventions — if the task says "use the Write tool", that means the function tool named Write.');
    if (!names.includes('WebSearch')) lines.push('- WebSearch is NOT available. If the task requires it, say so in your result instead of guessing.');
    if (toolset.mode === 'read-only') lines.push('- READ-ONLY mode: you cannot write files, edit files, or run shell commands.');
  }
  lines.push('- Never fabricate file contents, data, numbers, or citations. Read the actual files. If something is not found, report that.');
  lines.push('- Work autonomously; do not ask questions. When done, return the result.');
  if (schema) {
    if (delegated) {
      lines.push('');
      lines.push('OUTPUT FORMAT (mandatory): end your reply with a single fenced code block labeled json containing ONLY a JSON value that validates against this JSON Schema:');
      lines.push(JSON.stringify(schema));
    } else {
      lines.push('- When you are done you MUST call the StructuredOutput tool exactly once with your final answer matching its schema. Do not print the JSON as plain text.');
    }
  }
  if (agentBody) {
    lines.push('');
    lines.push('--- Agent definition ---');
    lines.push(agentBody.trim());
  }
  return lines.join('\n');
}

export async function runAgentLoop(opts) {
  const {
    prompt, label, schema, provider, model, effort, toolset, cwd,
    maxTurns = MAX_TURNS_DEFAULT, clampChars = CLAMP_CHARS_DEFAULT,
    transcriptPath = null, usage, agentBody = null, temperature,
  } = opts;
  const mode = opts.mode || (toolset && toolset.mode) || 'workspace';

  const record = (ev) => {
    if (!transcriptPath) return;
    try { appendFileSync(transcriptPath, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n'); } catch { /* best-effort */ }
  };
  record({ type: 'start', label, model, effort, provider: provider.name, promptChars: prompt.length });

  if (provider.type === 'cli') {
    if (mode === 'read-only') {
      // Understudy cannot constrain an external CLI's tools; refuse rather
      // than silently dropping the guarantee.
      record({ type: 'error', error: 'read-only mode with a CLI provider' });
      return { ok: false, terminal: true, error: 'read-only mode cannot be enforced for CLI providers — use an HTTP provider or drop --read-only', text: '' };
    }
    return runDelegated({ ...opts, mode }, record);
  }

  const system = buildSystemPrompt({ toolset, schema, cwd, label, agentBody, delegated: false });
  const tools = [...toolset.defs];
  if (schema) {
    tools.push({
      type: 'function',
      function: {
        name: 'StructuredOutput',
        description: 'Return your final structured answer. Call exactly once, when the task is complete.',
        parameters: schema,
      },
    });
  }
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];

  let nudges = 0;
  let lastText = '';
  for (let turn = 0; turn < maxTurns; turn++) {
    let resp;
    try {
      resp = await provider.client.chat({
        model, messages, tools,
        temperature,
        extraBody: provider.extraBodyFor(effort),
      });
    } catch (e) {
      record({ type: 'error', error: String(e.message) });
      return { ok: false, error: `provider error: ${e.message}`, terminal: true, text: lastText };
    }
    usage.input += resp.usage.input;
    usage.output += resp.usage.output;
    record({ type: 'response', turn, text: clip(resp.text, 2000), toolCalls: resp.toolCalls.map((t) => t.name), usage: resp.usage });

    if (resp.toolCalls.length > 0) {
      messages.push(resp.assistantMessage);
      for (const call of resp.toolCalls) {
        let args;
        try { args = JSON.parse(call.args || '{}'); } catch (e) {
          messages.push(toolMsg(call.id, `ERROR: your tool arguments were not valid JSON (${e.message}). Retry the call with valid JSON.`));
          continue;
        }
        if (call.name === 'StructuredOutput') {
          if (!schema) {
            // Hallucinated call — no schema was requested; never accept it as the answer.
            messages.push(toolMsg(call.id, 'ERROR: no structured output was requested for this task. Finish with a normal text answer instead.'));
            continue;
          }
          const errors = validate(schema, args);
          if (errors.length === 0) {
            record({ type: 'done', via: 'structured', turns: turn + 1 });
            return { ok: true, value: args, text: resp.text, turns: turn + 1 };
          }
          record({ type: 'schema-reject', errors: errors.slice(0, 10) });
          messages.push(toolMsg(call.id, `Your structured output failed validation:\n- ${errors.slice(0, 10).join('\n- ')}\nCall StructuredOutput again with a corrected value.`));
          continue;
        }
        const out = await toolset.execute(call.name, args);
        record({ type: 'tool', name: call.name, isError: !!out.isError, chars: out.content.length });
        messages.push(toolMsg(call.id, clip(out.content, clampChars)));
      }
      continue;
    }

    // Text-only response.
    lastText = resp.text || lastText;
    if (!schema) {
      if (!resp.text || !resp.text.trim()) {
        if (nudges++ < 1) {
          messages.push({ role: 'assistant', content: resp.text || '' });
          messages.push({ role: 'user', content: 'Your response was empty. Provide your final answer.' });
          continue;
        }
        record({ type: 'done', via: 'empty' });
        return { ok: false, error: 'model returned no content', text: '' };
      }
      record({ type: 'done', via: 'text', turns: turn + 1 });
      return { ok: true, text: resp.text, turns: turn + 1 };
    }
    // Schema requested but no StructuredOutput call — try to salvage JSON
    // from the text, else nudge.
    const salvaged = extractJson(resp.text);
    if (salvaged !== undefined && validate(schema, salvaged).length === 0) {
      record({ type: 'done', via: 'salvaged-json', turns: turn + 1 });
      return { ok: true, value: salvaged, text: resp.text, turns: turn + 1 };
    }
    if (nudges++ < SCHEMA_NUDGES) {
      messages.push({ role: 'assistant', content: resp.text || '' });
      messages.push({ role: 'user', content: 'You must finish by calling the StructuredOutput tool with your final answer matching its schema. Call it now.' });
      continue;
    }
    record({ type: 'done', via: 'schema-unsatisfied' });
    return { ok: false, error: 'model never produced valid structured output', text: resp.text };
  }
  record({ type: 'done', via: 'max-turns' });
  return { ok: false, error: `exceeded ${maxTurns} turns`, text: lastText };
}

async function runDelegated(opts, record) {
  const { prompt, label, schema, provider, model, cwd, usage, agentBody, onExec, mode } = opts;
  const system = buildSystemPrompt({ toolset: null, schema, cwd, label, agentBody, delegated: true, mode });
  // Rebuilt EVERY attempt so validation feedback actually reaches the CLI.
  let taskPrompt = prompt;

  for (let attempt = 0; attempt < 2; attempt++) {
    const composed = `${system}\n\n--- Task ---\n${taskPrompt}`;
    let out;
    try {
      out = await provider.client.run({ prompt: composed, model, cwd, onExec, mode });
    } catch (e) {
      record({ type: 'error', error: String(e.message) });
      return { ok: false, error: `CLI provider error: ${e.message}`, terminal: true, text: '' };
    }
    // CLI usage is not reported by most agent CLIs; tracked as 0.
    record({ type: 'response', attempt, text: clip(out.text, 2000), exitCode: out.exitCode });
    usage.input += 0; usage.output += 0;

    if (!schema) {
      if (out.text.trim()) { record({ type: 'done', via: 'cli-text' }); return { ok: true, text: out.text }; }
      return { ok: false, error: `CLI produced no output (exit ${out.exitCode}); stderr: ${out.stderr || 'none'}`, text: '' };
    }
    const value = extractJson(out.text);
    const errors = value === undefined ? ['no JSON found in output'] : validate(schema, value);
    if (errors.length === 0) { record({ type: 'done', via: 'cli-json' }); return { ok: true, value, text: out.text }; }
    record({ type: 'schema-reject', errors: errors.slice(0, 10) });
    if (attempt === 0) {
      taskPrompt = `${prompt}\n\nYour previous output did not contain valid JSON for the required schema (${errors.slice(0, 5).join('; ')}). Previous output (may be truncated):\n${clip(out.text, 4000)}\n\nRedo the final answer: reply with ONLY a fenced json code block that validates against the schema.`;
      continue;
    }
    return { ok: false, error: `CLI output failed schema validation: ${errors.slice(0, 5).join('; ')}`, text: out.text };
  }
  return { ok: false, error: 'unreachable' };
}

function toolMsg(id, content) {
  return { role: 'tool', tool_call_id: id, content };
}

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n / 2) + `\n…[${s.length - n} chars clipped]…\n` + s.slice(-n / 2) : s;
}

// Pull a JSON value out of free text: prefer the LAST fenced ```json block,
// then the last fenced block of any kind, then the widest braced/bracketed
// span that parses.
export function extractJson(text) {
  if (!text) return undefined;
  const fences = [...text.matchAll(/```(?:json)?\s*\n?([^]*?)```/gi)].map((m) => m[1]);
  for (let i = fences.length - 1; i >= 0; i--) {
    try { return JSON.parse(fences[i]); } catch { /* try next */ }
  }
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
    }
  }
  return undefined;
}
