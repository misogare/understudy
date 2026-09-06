// Reading runs back — the Claude Code handoff side.
// `understudy runs` lists runs; `understudy collect [id]` prints a digest a
// Claude session (or a human) can consume to continue the work.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function listRuns(outRoot) {
  const runsDir = join(outRoot);
  if (!existsSync(runsDir)) return [];
  const out = [];
  for (const id of readdirSync(runsDir)) {
    const dir = join(runsDir, id);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const recordFile = firstRecord(dir);
    let rec = null;
    if (recordFile) {
      try { rec = JSON.parse(readFileSync(recordFile, 'utf8')); } catch { /* torn */ }
    }
    out.push({
      runId: id,
      name: rec?.workflowName || '?',
      status: rec?.status || (recordFile ? '?' : 'incomplete'),
      agents: rec?.agentCount ?? null,
      tokens: rec?.totalTokens ?? null,
      provider: rec?.defaultModel || rec?.provider || '?',
      session: rec?.session || null,
      mtime: st.mtimeMs,
      dir,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// With no runId: prefer the latest run belonging to `session` (so concurrent
// sessions each collect their own work); fall back to the global latest with
// an explicit flag when the session has no runs yet.
export function collectRun(outRoot, runId = null, session = null) {
  const runs = listRuns(outRoot);
  if (runs.length === 0) return { error: `no runs found under ${outRoot}` };
  let run;
  let sessionFallback = false;
  if (runId) {
    run = runs.find((r) => r.runId === runId);
    if (!run) return { error: `run ${runId} not found; latest is ${runs[0].runId}` };
  } else if (session) {
    run = runs.find((r) => r.session === session);
    if (!run) { run = runs[0]; sessionFallback = true; }
  } else {
    run = runs[0];
  }

  const recordFile = firstRecord(run.dir);
  let record = null;
  let recordError = null;
  if (recordFile) {
    try { record = JSON.parse(readFileSync(recordFile, 'utf8')); } catch (e) { recordError = `run record is corrupt (${e.message})`; }
  }
  const failures = readFailures(join(run.dir, 'journal.jsonl'));
  return {
    run,
    record,
    recordError,
    sessionFallback,
    failures,
    files: {
      record: recordFile,
      result: existsSync(join(run.dir, 'result.json')) ? join(run.dir, 'result.json') : null,
      summary: existsSync(join(run.dir, 'summary.md')) ? join(run.dir, 'summary.md') : null,
      journal: existsSync(join(run.dir, 'journal.jsonl')) ? join(run.dir, 'journal.jsonl') : null,
      agentsDir: existsSync(join(run.dir, 'agents')) ? join(run.dir, 'agents') : null,
    },
  };
}

function firstRecord(dir) {
  try {
    const f = readdirSync(dir).find((n) => /^wf_.*\.json$/.test(n));
    return f ? join(dir, f) : null;
  } catch { return null; }
}

function readFailures(journalPath) {
  if (!existsSync(journalPath)) return [];
  const failures = [];
  for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === 'failed') failures.push({ agentId: rec.agentId, error: rec.error || null });
    } catch { /* torn line */ }
  }
  return failures;
}
