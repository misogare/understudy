// Harvest workflow scripts that Claude Code persisted inside its session
// directories. Claude Code writes every workflow's source to:
//   ~/.claude/projects/<project-slug>/<session-uuid>/workflows/scripts/<name>-wf_<id>.js
// This finds them all, dedupes by workflow name (newest mtime wins), and can
// copy them into a stable local directory you keep under version control.

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { extractMeta } from '../runtime/workflow.js';

export function findWorkflowScripts({ claudeDir = null, project = null } = {}) {
  const root = claudeDir || join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return [];
  const out = [];
  for (const projectSlug of safeList(root)) {
    if (project && !projectSlug.toLowerCase().includes(project.toLowerCase())) continue;
    const projectDir = join(root, projectSlug);
    for (const session of safeList(projectDir)) {
      const scriptsDir = join(projectDir, session, 'workflows', 'scripts');
      if (!existsSync(scriptsDir)) continue;
      for (const file of safeList(scriptsDir)) {
        if (!file.endsWith('.js')) continue;
        const full = join(scriptsDir, file);
        let mtime = 0;
        try { mtime = statSync(full).mtimeMs; } catch { continue; }
        let name = basename(file, '.js').replace(/-wf_[a-z0-9-]+$/, '');
        let description = '';
        try {
          const { meta } = extractMeta(readFileSync(full, 'utf8'));
          if (meta?.name) name = meta.name;
          if (meta?.description) description = meta.description;
        } catch { /* keep filename-derived name */ }
        out.push({ name, description, path: full, mtime, project: projectSlug, session });
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function dedupeByName(scripts) {
  const seen = new Map();
  for (const s of scripts) {
    const prev = seen.get(s.name);
    if (!prev || s.mtime > prev.mtime) seen.set(s.name, s);
  }
  return [...seen.values()].sort((a, b) => b.mtime - a.mtime);
}

export function harvest({ dest, claudeDir = null, project = null }) {
  const all = findWorkflowScripts({ claudeDir, project });
  const unique = dedupeByName(all);
  mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const s of unique) {
    const target = join(dest, `${s.name}.js`);
    copyFileSync(s.path, target);
    copied.push({ ...s, target });
  }
  return { total: all.length, unique: unique.length, copied };
}

function safeList(dir) {
  try { return readdirSync(dir); } catch { return []; }
}
