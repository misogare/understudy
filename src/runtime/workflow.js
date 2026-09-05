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
// Find `export const meta = { ... }` and STATICALLY parse the literal — no
// evaluation of any kind, so listing/harvesting untrusted scripts never runs
// their code. The grammar covers what a "pure literal" means: plain objects
// with identifier/string keys, arrays, strings ('/"/` without ${), numbers,
// true/false/null. Computed keys, spreads, calls, template interpolation, or
// any other expression fail the parse.
export function extractMeta(source) {
  const m = /export\s+const\s+meta\s*=/.exec(source);
  if (!m) return { meta: null, error: 'script has no `export const meta = {...}` block' };
  const start = source.indexOf('{', m.index + m[0].length);
  if (start === -1) return { meta: null, error: '`export const meta =` is not followed by an object literal' };
  try {
    const [meta] = parseLiteral(source, start);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { meta: null, error: 'meta did not parse to an object' };
    if (!meta.name || !meta.description) return { meta, error: 'meta must declare `name` and `description`' };
    return { meta, error: null };
  } catch (e) {
    return { meta: null, error: `meta is not a pure literal (${e.message})` };
  }
}

// Recursive-descent parser for pure literals. Returns [value, indexAfter].
function parseLiteral(src, i) {
  i = skipWs(src, i);
  const c = src[i];
  if (c === '{') {
    const obj = {};
    i = skipWs(src, i + 1);
    if (src[i] === '}') return [obj, i + 1];
    for (;;) {
      i = skipWs(src, i);
      let key;
      if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
        [key, i] = parseString(src, i);
      } else {
        const km = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 200));
        if (!km) throw err(src, i, 'expected a property key');
        key = km[0]; i += km[0].length;
      }
      i = skipWs(src, i);
      if (src[i] !== ':') throw err(src, i, 'expected ":" after key (computed keys/shorthand are not literals)');
      let value;
      [value, i] = parseLiteral(src, i + 1);
      obj[key] = value;
      i = skipWs(src, i);
      if (src[i] === ',') { i = skipWs(src, i + 1); if (src[i] === '}') return [obj, i + 1]; continue; }
      if (src[i] === '}') return [obj, i + 1];
      throw err(src, i, 'expected "," or "}"');
    }
  }
  if (c === '[') {
    const arr = [];
    i = skipWs(src, i + 1);
    if (src[i] === ']') return [arr, i + 1];
    for (;;) {
      let value;
      [value, i] = parseLiteral(src, i);
      arr.push(value);
      i = skipWs(src, i);
      if (src[i] === ',') { i = skipWs(src, i + 1); if (src[i] === ']') return [arr, i + 1]; continue; }
      if (src[i] === ']') return [arr, i + 1];
      throw err(src, i, 'expected "," or "]"');
    }
  }
  if (c === '"' || c === "'" || c === '`') return parseString(src, i);
  const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 40));
  if (num) return [Number(num[0]), i + num[0].length];
  if (src.startsWith('true', i)) return [true, i + 4];
  if (src.startsWith('false', i)) return [false, i + 5];
  if (src.startsWith('null', i)) return [null, i + 4];
  throw err(src, i, 'not a literal value (calls, spreads, identifiers and interpolation are not allowed in meta)');
}

function parseString(src, i) {
  const quote = src[i];
  let out = '';
  for (i += 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      if (n === 'u') {
        if (src[i + 2] === '{') throw err(src, i, 'unsupported \\u{...} escape in meta');
        const code = parseInt(src.slice(i + 2, i + 6), 16);
        if (Number.isNaN(code)) throw err(src, i, 'bad \\u escape');
        out += String.fromCharCode(code); i += 5; continue;
      }
      if (n === 'x') {
        const code = parseInt(src.slice(i + 2, i + 4), 16);
        if (Number.isNaN(code)) throw err(src, i, 'bad \\x escape');
        out += String.fromCharCode(code); i += 3; continue;
      }
      const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };
      out += map[n] !== undefined ? map[n] : (n ?? '');
      i += 1; continue;
    }
    if (c === quote) return [out, i + 1];
    if (quote === '`' && c === '$' && src[i + 1] === '{') throw err(src, i, 'template interpolation is not a literal');
    if (quote !== '`' && (c === '\n' || c === '\r')) throw err(src, i, 'unterminated string');
    out += c;
  }
  throw err(src, i, 'unterminated string');
}

function skipWs(src, i) {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src[i] === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end === -1 ? src.length : end + 2; continue; }
    return i;
  }
}

function err(src, i, msg) {
  return new Error(`${msg} at offset ${i}: ...${src.slice(Math.max(0, i - 20), i + 20).replace(/\n/g, '\\n')}...`);
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
  if (provider.type === 'cli' && mode === 'read-only') {
    throw new Error('read-only mode cannot be enforced for CLI providers — their tools run outside understudy. Use an HTTP provider or drop --read-only.');
  }

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
      // Re-emit into THIS run's journal so chained resumes stay complete.
      st.journal.result(key, 'cached', cached);
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
      const toolset = buildToolset({
        cwd, mode, allowPaths: config.allowPaths || [], config,
        // 'bash' events are sub-events of a Bash tool call — don't double-count.
        onEvent: (e) => { if (!e || e.type !== 'bash') st.toolCalls += 1; },
      });
      const out = await runAgentLoop({
        prompt, label, schema: opts.schema, provider, model, effort,
        toolset, cwd, mode,
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

  // Spec conformance: a throwing thunk/stage resolves its lane to null and
  // parallel()/pipeline() themselves never reject — including on budget
  // exhaustion (agent() throws, the lane nulls, and we log why once).
  let budgetWarned = false;
  const laneCatch = (e) => {
    if (e instanceof BudgetExceededError && !budgetWarned) {
      budgetWarned = true;
      log(`warning: ${e.message} — remaining lanes resolve to null`);
    }
    return null;
  };

  async function parallelFn(thunks) {
    if (!Array.isArray(thunks)) throw new Error('parallel() takes an array of zero-argument functions');
    if (thunks.length > 4096) throw new Error('parallel() accepts at most 4096 items');
    return Promise.all(thunks.map(async (t) => {
      try { return await t(); } catch (e) { return laneCatch(e); }
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
          return laneCatch(e);
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
    // Guarded shadows only — everything else (JSON, Promise, Array, Error,
    // parseInt, ...) comes from the vm realm's own intrinsics. Injecting host
    // intrinsics would both mix realms (instanceof surprises) and widen the
    // escape surface. NOTE (documented in README): node:vm is NOT a security
    // boundary — running a workflow script is running code; only run scripts
    // you trust.
    Math: makeGuardedMath(),
    Date: GuardedDate,
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
