// Load Claude Code subagent definitions (.claude/agents/<name>.md):
// YAML frontmatter (name, description, tools, model) + markdown body used as
// the agent's system-prompt extension. Zero-dep frontmatter parsing covering
// the simple scalar/list fields these files actually use.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

export function parseAgentMd(text) {
  const m = text.match(/^---\r?\n([^]*?)\r?\n---\r?\n?([^]*)$/);
  if (!m) return { frontmatter: {}, body: text };
  const frontmatter = {};
  let lastKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      lastKey = kv[1];
      const v = kv[2].trim();
      frontmatter[lastKey] = v === '' ? '' : parseScalar(v);
    } else if (lastKey && /^\s*-\s+/.test(line)) {
      if (!Array.isArray(frontmatter[lastKey])) frontmatter[lastKey] = frontmatter[lastKey] ? [frontmatter[lastKey]] : [];
      frontmatter[lastKey].push(parseScalar(line.replace(/^\s*-\s+/, '').trim()));
    }
  }
  if (typeof frontmatter.tools === 'string' && frontmatter.tools.includes(',')) {
    frontmatter.tools = frontmatter.tools.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return { frontmatter, body: m[2].trim() };
}

function parseScalar(v) {
  const unquoted = v.replace(/^["']|["']$/g, '');
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return unquoted;
}

// Resolve an agent by name or path: an explicit .md path, then
// <cwd>/.claude/agents/<name>.md, then ~/.claude/agents/<name>.md.
export function loadAgentDef(nameOrPath, cwd = process.cwd()) {
  const candidates = [];
  if (nameOrPath.endsWith('.md')) candidates.push(isAbsolute(nameOrPath) ? nameOrPath : join(cwd, nameOrPath));
  candidates.push(join(cwd, '.claude', 'agents', `${nameOrPath}.md`));
  candidates.push(join(homedir(), '.claude', 'agents', `${nameOrPath}.md`));
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const { frontmatter, body } = parseAgentMd(readFileSync(p, 'utf8'));
    return {
      name: frontmatter.name || nameOrPath.replace(/\.md$/, ''),
      description: frontmatter.description || '',
      tools: frontmatter.tools || null,
      model: frontmatter.model || null,
      body,
      path: p,
    };
  }
  return null;
}
