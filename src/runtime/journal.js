// journal.jsonl — the resume/memoization ledger, format-compatible with the
// one Claude Code writes for its own Workflow runs:
//   {"type":"started","key":"v2:<sha256>","agentId":"..."}
//   {"type":"result","key":"v2:<sha256>","agentId":"...","result":<any>}
//   {"type":"failed","key":"v2:<sha256>","agentId":"..."}
// The key is a content hash of the agent() call payload, so a resumed run
// skips agents that already completed with an identical (prompt, opts).
// Note: our hash input is self-consistent but not guaranteed byte-identical
// to Claude Code's — resume works within Understudy runs.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export class Journal {
  constructor(filePath, resumeFromPath = null) {
    this.filePath = filePath;
    this.occurrences = new Map(); // base key -> count handed out this run
    this.cache = new Map();       // full key -> result (from a prior journal)
    if (resumeFromPath && existsSync(resumeFromPath)) {
      for (const line of readFileSync(resumeFromPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.type === 'result' && rec.key != null) this.cache.set(rec.key, rec.result);
        } catch { /* tolerate a torn last line */ }
      }
    }
  }

  // One key per agent() invocation. Identical payloads get an occurrence
  // suffix so N identical calls map to N distinct journal entries.
  keyFor(payload) {
    const base = 'v2:' + createHash('sha256').update(stableStringify(payload)).digest('hex');
    const n = this.occurrences.get(base) || 0;
    this.occurrences.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  }

  lookup(key) {
    return this.cache.has(key) ? this.cache.get(key) : undefined;
  }

  _append(rec) {
    try { appendFileSync(this.filePath, JSON.stringify(rec) + '\n'); } catch { /* journal is best-effort */ }
  }
  started(key, agentId) { this._append({ type: 'started', key, agentId }); }
  result(key, agentId, result) { this._append({ type: 'result', key, agentId, result: result === undefined ? null : result }); }
  failed(key, agentId, error) { this._append({ type: 'failed', key, agentId, ...(error ? { error: String(error).slice(0, 500) } : {}) }); }
}
