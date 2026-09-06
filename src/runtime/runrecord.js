// Writes the on-disk handoff bundle for one workflow run:
//   <runDir>/wf_<id>.json    — full run record (Claude Code-compatible keys)
//   <runDir>/result.json     — just the workflow's return value
//   <runDir>/summary.md      — short human/Claude-readable digest
// journal.jsonl and agents/*.jsonl are appended live during the run.

import { writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export function writeRunRecord(runDir, record) {
  try {
    writeFileSync(join(runDir, `wf_${record.runId.replace(/^uwf_/, '')}.json`), JSON.stringify(record, null, 2));
    writeFileSync(join(runDir, 'result.json'), JSON.stringify(record.result, null, 2));
    writeFileSync(join(runDir, 'summary.md'), renderSummary(record));
  } catch (e) {
    // The run itself succeeded; surface the write problem loudly but don't throw away the result.
    process.stderr.write(`understudy: failed to write run record in ${runDir}: ${e.message}\n`);
  }
}

function renderSummary(r) {
  const lines = [];
  lines.push(`# Workflow run: ${r.workflowName}`);
  lines.push('');
  lines.push(`- run id: ${r.runId}`);
  lines.push(`- status: ${r.status}${r.error ? ` — ${r.error}` : ''}`);
  lines.push(`- provider: ${r.defaultModel}`);
  if (r.session) lines.push(`- session: ${r.session}`);
  lines.push(`- agents run: ${r.agentCount}, tool calls: ${r.totalToolCalls}, tokens: ${r.totalTokens} (in ${r.usage?.input ?? '?'} / out ${r.usage?.output ?? '?'})`);
  lines.push(`- duration: ${Math.round(r.durationMs / 1000)}s, started ${r.startTime}`);
  if (r.scriptPath) lines.push(`- script: ${basename(r.scriptPath)}`);
  lines.push('');
  lines.push('## Result');
  lines.push('');
  const res = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
  const clipped = res && res.length > 8000 ? res.slice(0, 8000) + '\n…[clipped — full value in result.json]' : res;
  lines.push('```json');
  lines.push(clipped ?? 'null');
  lines.push('```');
  lines.push('');
  if (r.logs && r.logs.length) {
    lines.push('## Log tail');
    lines.push('');
    for (const l of r.logs.slice(-30)) lines.push(`- ${l}`);
  }
  lines.push('');
  return lines.join('\n');
}
