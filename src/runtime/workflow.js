// The workflow DSL host — a faithful re-implementation of the Claude Code
// Workflow script runtime, with agent() dispatching to any provider:
//
//   agent(prompt, {label, phase, schema, model, effort, agentType})
//   parallel(thunks)          — barrier; a thunk that throws resolves null
//   pipeline(items, ...stages)— no barrier; stage gets (prev, item, index);
//                               a throwing stage drops the item to null
//   phase(title) / log(msg) / args / budget / workflow(ref, args)
//
// Scripts are plain JS run in a node:vm context. Date.now(), Math.random()
// and argless new Date() throw — same as Claude Code — because agent-call
// content hashes must be stable across resumes.

import vm from 'node:vm';
import { cpus } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Journal } from './journal.js';
import { runAgentLoop } from './agentloop.js';
import { buildToolset } from '../tools/index.js';
import { loadAgentDef } from '../loader/agentmd.js';
import { writeRunRecord } from './runrecord.js';

export class BudgetExceededError extends Error {
  constructor(total) { super(`token budget exhausted (${total} output tokens)`); this.name = 'BudgetExceededError'; }
}

// ── meta extraction ─────────────────────────────────────────────────────
// Find `export const meta = { ... }` and evaluate just the literal.
export function extractMeta(source) {
  const m = /export\s+const\s+meta\s*=/.exec(source);
  if (!m) return { meta: null, error: 'script has no `export const meta = {...}` block' };
  const start = source.indexOf('{', m.index + m[0].length);
  if (start === -1) return { meta: null, error: '`export const meta =` is not followed by an object literal' };
  const end = findBalanced(source, start);
  if (end === -1) return { meta: null, error: 'could not find the end of the meta object literal' };
  const literal = source.slice(start, end + 1);
  try {
    const meta = vm.runInNewContext(`(${literal})`, {}, { timeout: 1000 });
    if (!meta || typeof meta !== 'object') return { meta: null, error: 'meta did not evaluate to an object' };
    if (!meta.name || !meta.description) return { meta, error: 'meta must declare `name` and `description`' };
    return { meta, error: null };
  } catch (e) {
    return { meta: null, error: `meta is not a pure literal (${e.message})` };
  }
}

function findBalanced(src, start) {
  let depth = 0;
  let i = start;
  let inStr = null; // ', ", or `
  let inLine = false;
  let inBlock = false;
  for (; i < src.length; i++) {
    const c = src[i];
    const prev = src[i - 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (prev === '*' && c === '/') inBlock = false; continue; }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { inLine = true; continue; }
    if (c === '/' && src[i + 1] === '*') { inBlock = true; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ── guarded intrinsics (mirror Claude Code's restrictions) ──────────────
function makeGuardedMath() {
  const g = Object.create(Math);
  g.random = () => { throw new Error('Math.random() is not available in workflow scripts (it would break resume); vary prompts by index instead'); };
  return g;
}
const GuardedDate = class extends Date {
  constructor(...a) {
    if (a.length === 0) throw new Error('argless new Date() is not available in workflow scripts; pass timestamps in via args');
    super(...a);
  }
  static now() { throw new Error('Date.now() is not available in workflow scripts; pass timestamps in via args'); }
};

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise((r) => this.q.push(r));
  }
  release() {
    const next = this.q.shift();
    if (next) next(); else this.n++;
  }
}

const AGENT_LIFETIME_CAP = 1000;

// ── the runner ──────────────────────────────────────────────────────────
export async function runWorkflow({
  source, scriptPath = null, args = undefined, provider, config = {},
  outRoot, runId, budgetTotal = null, mode = 'workspace', cwd = process.cwd(),
  resumeJournalPath = null, onLog = () => {}, defaultEffort = null,
  temperature = undefined, maxTurns = undefined, concurrency = undefined,
  depth = 0, shared = null,
}) {
  const { meta, error: metaError } = extractMeta(source);
  if (metaError && !meta) throw new Error(metaError);
  if (metaError) onLog(`warning: ${metaError}`);

  const runDir = join(outRoot, runId);
  mkdirSync(join(runDir, 'agents'), { recursive: true });

  const st = shared || {
    sem: new Semaphore(Math.max(1, Math.min(16, cpus().length - 2, concurrency || config.concurrency || 16))),
    journal: new Journal(join(runDir, 'journal.jsonl'), resumeJournalPath),
    usage: { input: 0, output: 0 },
    agentSeq: 0,
    toolCalls: 0,
    startTime: Date.now(),
  };

  const logs = [];
  let currentPhase = null;
  const log = (msg) => { const s = String(msg); logs.push(s); onLog(s); };

  const budget = {
    total: budgetTotal,
    spent: () => st.usage.output,
    remaining: () => (budgetTotal == null ? Infinity : Math.max(0, budgetTotal - st.usage.output)),
  };

  async function agentFn(prompt, opts = {}) {
    if (budgetTotal != null && st.usage.output >= budgetTotal) throw new BudgetExceededError(budgetTotal);
    if (st.agentSeq >= AGENT_LIFETIME_CAP) throw new Error(`agent lifetime cap (${AGENT_LIFETIME_CAP}) reached — likely a runaway loop`);
    prompt = String(prompt);
    const effort = opts.effort ?? defaultEffort ?? null;
    const payload = {
      prompt,
      schema: opts.schema ?? null,
      effort,
      model: opts.model ?? null,
      agentType: opts.agentType ?? null,
    };
    const key = st.journal.keyFor(payload);
    const label = opts.label || `agent-${st.agentSeq + 1}`;
    const phaseName = opts.phase || currentPhase;

    const cached = st.journal.lookup(key);
    if (cached !== undefined) {
      onLog(`[${phaseName || '-'}] ${label}: cached (resume)`);
      return cached;
    }

    st.agentSeq += 1;
    const agentId = `agent-${String(st.agentSeq).padStart(3, '0')}`;
    st.journal.started(key, agentId);
    await st.sem.acquire();
    const model = provider.modelFor({ model: opts.model, effort });
    onLog(`[${phaseName || '-'}] ${label} → ${provider.name}:${model}`);
    try {
      let agentBody = null;
      if (opts.agentType) {
        const def = loadAgentDef(opts.agentType, cwd);
        if (def) agentBody = def.body;
        else onLog(`warning: agentType "${opts.agentType}" not found in .claude/agents — running without it`);
      }
      const toolset = buildToolset({ cwd, mode, allowPaths: config.allowPaths || [], config, onEvent: () => { st.toolCalls += 1; } });
      const out = await runAgentLoop({
        prompt, label, schema: opts.schema, provider, model, effort,
        toolset, cwd,
        maxTurns: maxTurns || config.maxTurnsPerAgent || undefined,
        clampChars: config.toolResultClampChars || undefined,
        transcriptPath: join(runDir, 'agents', `${agentId}.jsonl`),
        usage: st.usage, agentBody, temperature,
      });
      if (!out.ok) {
        st.journal.failed(key, agentId, out.error);
        onLog(`[${phaseName || '-'}] ${label}: FAILED (${out.error})`);
        return null; // matches Claude Code: terminal agent failure resolves to null
      }
      const value = out.value !== undefined ? out.value : out.text;
      st.journal.result(key, agentId, value);
      onLog(`[${phaseName || '-'}] ${label}: done`);
      return value;
    } catch (e) {
      st.journal.failed(key, agentId, e.message);
      if (e instanceof BudgetExceededError) throw e;
      onLog(`[${phaseName || '-'}] ${label}: ERROR ${e.message}`);
      return null;
    } finally {
      st.sem.release();
    }
  }

  async function parallelFn(thunks) {
    if (!Array.isArray(thunks)) throw new Error('parallel() takes an array of zero-argument functions');
    if (thunks.length > 4096) throw new Error('parallel() accepts at most 4096 items');
    return Promise.all(thunks.map(async (t) => {
      try { return await t(); } catch (e) {
        if (e instanceof BudgetExceededError) throw e;
        return null;
      }
    }));
  }

  async function pipelineFn(items, ...stages) {
    if (!Array.isArray(items)) throw new Error('pipeline() takes an array of items');
    if (items.length > 4096) throw new Error('pipeline() accepts at most 4096 items');
    return Promise.all(items.map(async (item, index) => {
      let prev = item;
      for (const stage of stages) {
        try {
          prev = await stage(prev, item, index);
        } catch (e) {
          if (e instanceof BudgetExceededError) throw e;
          return null;
        }
      }
      return prev;
    }));
  }

  function phaseFn(title) { currentPhase = String(title); onLog(`— phase: ${currentPhase} —`); }

  async function workflowFn(ref, childArgs) {
    if (depth >= 1) throw new Error('workflow() nesting is one level only');
    const { readFileSync } = await import('node:fs');
    let childSource;
    let childPath;
    if (ref && typeof ref === 'object' && ref.scriptPath) childPath = ref.scriptPath;
    else if (typeof ref === 'string') childPath = ref.endsWith('.js') ? ref : null;
    if (!childPath) throw new Error('workflow() needs a {scriptPath} or a path to a .js script');
    try { childSource = readFileSync(childPath, 'utf8'); } catch (e) { throw new Error(`workflow(): cannot read ${childPath}: ${e.message}`); }
    const child = await runWorkflow({
      source: childSource, scriptPath: childPath, args: childArgs, provider, config,
      outRoot, runId: `${runId}-sub${st.agentSeq}`, budgetTotal, mode, cwd,
      onLog: (m) => onLog(`  ▸ ${m}`), defaultEffort, temperature, maxTurns,
      depth: depth + 1, shared: st,
    });
    return child.result;
  }

  const sandbox = {
    agent: agentFn,
    parallel: parallelFn,
    pipeline: pipelineFn,
    phase: phaseFn,
    log,
    args: args === undefined ? undefined : JSON.parse(JSON.stringify(args)),
    budget,
    workflow: workflowFn,
    console: { log: (...a) => log(a.map(String).join(' ')), error: (...a) => log(a.map(String).join(' ')), warn: (...a) => log(a.map(String).join(' ')) },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math: makeGuardedMath(),
    Date: GuardedDate,
    JSON, Promise, Array, Object, String, Number, Boolean, RegExp, Map, Set,
    Error, TypeError, RangeError, SyntaxError,
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    structuredClone: globalThis.structuredClone,
    URL, TextEncoder, TextDecoder,
  };
  const context = vm.createContext(sandbox);

  const transformed = source.replace(/^\s*export\s+const\s+meta\s*=/m, 'const meta =');
  if (/^\s*export\s/m.test(transformed)) {
    throw new Error('workflow scripts may only export `const meta` — remove other export statements');
  }

  const startISO = new Date().toISOString();
  const t0 = Date.now();
  let result;
  let status = 'completed';
  let errorMsg = null;
  try {
    const script = new vm.Script(`(async () => {\n${transformed}\n})()`, { filename: scriptPath || `${meta.name}.js` });
    result = await script.runInContext(context);
    // Values built inside the vm realm carry foreign prototypes; a JSON
    // round-trip re-homes them (and mirrors what the run record stores).
    try { result = result === undefined ? null : JSON.parse(JSON.stringify(result)); } catch { /* keep as-is */ }
  } catch (e) {
    status = 'failed';
    errorMsg = e.message;
    result = null;
    onLog(`workflow FAILED: ${e.message}`);
  }

  const record = {
    runId,
    timestamp: startISO,
    script: source,
    scriptPath,
    result: result === undefined ? null : result,
    agentCount: st.agentSeq,
    logs,
    durationMs: Date.now() - t0,
    summary: errorMsg ? `FAILED: ${errorMsg}` : summarize(result),
    workflowName: meta.name,
    status,
    ...(errorMsg ? { error: errorMsg } : {}),
    startTime: startISO,
    phases: meta.phases || [],
    defaultModel: `${provider.name}:${provider.modelFor({ effort: defaultEffort })}`,
    provider: provider.name,
    totalTokens: st.usage.input + st.usage.output,
    usage: { ...st.usage },
    totalToolCalls: st.toolCalls,
    runner: 'understudy',
  };
  if (depth === 0) writeRunRecord(runDir, record);
  if (status === 'failed' && depth === 0) {
    const err = new Error(errorMsg);
    err.record = record;
    throw err;
  }
  return { result, record, runDir };
}

function summarize(result) {
  if (result == null) return 'completed (no return value)';
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  return s.length > 400 ? s.slice(0, 397) + '...' : s;
}
