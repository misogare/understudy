// Glob + Grep without dependencies. Grep shells out to ripgrep when
// available (fast, handles huge files); otherwise falls back to a pure-JS
// line scanner.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const SKIP_DIRS = new Set(['node_modules', '.git', '.understudy', '.venv', '__pycache__', 'dist', 'build']);
const MAX_RESULTS = 250;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Convert a glob to a RegExp. Supports **, *, ?, {a,b}, [chars].
export function globToRegex(glob) {
  let re = '';
  let i = 0;
  const g = glob.replace(/\\/g, '/');
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += (g[i + 2] === '/') ? '(?:[^/]+/)*' : '.*';
        i += (g[i + 2] === '/') ? 3 : 2;
      } else { re += '[^/]*'; i += 1; }
    } else if (c === '?') { re += '[^/]'; i += 1; }
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) { re += '\\{'; i += 1; }
      else {
        const alts = g.slice(i + 1, end).split(',').map((a) => a.replace(/[.+^$()|[\]\\]/g, '\\$&'));
        re += '(?:' + alts.join('|') + ')';
        i = end + 1;
      }
    } else if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end === -1) { re += '\\['; i += 1; }
      else { re += g.slice(i, end + 1); i = end + 1; }
    } else { re += c.replace(/[.+^$()|\\]/g, '\\$&'); i += 1; }
  }
  return new RegExp('^(?:' + re + ')$');
}

export function walkFiles(root, { includeDirs = false } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (includeDirs) out.push(full);
        stack.push(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

export function toolGlob({ pattern, path: base }, cwd) {
  const root = base || cwd;
  const rx = globToRegex(pattern);
  const matches = [];
  for (const f of walkFiles(root)) {
    const rel = relative(root, f).split(sep).join('/');
    if (rx.test(rel)) {
      let mtime = 0;
      try { mtime = statSync(f).mtimeMs; } catch { /* race */ }
      matches.push({ f, mtime });
    }
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  const shown = matches.slice(0, MAX_RESULTS).map((m) => m.f);
  const note = matches.length > MAX_RESULTS ? `\n[${matches.length - MAX_RESULTS} more matches not shown]` : '';
  return { result: shown.length ? shown.join('\n') + note : 'No files matched.' };
}

function rgAvailable() {
  try {
    const p = spawnSync('rg', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return p.status === 0;
  } catch { return false; }
}
let RG = null;
function useRg() { if (RG === null) RG = rgAvailable(); return RG; }

export function toolGrep({ pattern, path: base, glob, output_mode, '-i': ci, ignoreCase, context }, cwd) {
  const root = base || cwd;
  const mode = output_mode || 'files_with_matches';
  const insensitive = !!(ci || ignoreCase);

  if (useRg()) {
    const args = ['--no-config', '--max-count', '500', '--max-filesize', '10M'];
    if (insensitive) args.push('-i');
    if (glob) args.push('--glob', glob);
    if (mode === 'files_with_matches') args.push('-l');
    else if (mode === 'count') args.push('--count');
    else { args.push('-n'); if (context) args.push('-C', String(context)); }
    args.push('-e', pattern, root);
    const p = spawnSync('rg', args, { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    if (p.error) return { error: `ripgrep failed: ${p.error.message}` };
    if (p.status !== 0 && p.status !== 1) return { error: `ripgrep exited ${p.status}: ${(p.stderr || '').slice(0, 300)}` };
    const lines = (p.stdout || '').split('\n').filter(Boolean);
    const shown = lines.slice(0, MAX_RESULTS);
    const note = lines.length > MAX_RESULTS ? `\n[${lines.length - MAX_RESULTS} more lines not shown]` : '';
    return { result: shown.length ? shown.join('\n') + note : 'No matches.' };
  }

  // Pure-JS fallback.
  let rx;
  try { rx = new RegExp(pattern, insensitive ? 'i' : ''); } catch (e) { return { error: `invalid regex: ${e.message}` }; }
  const fileFilter = glob ? globToRegex(glob) : null;
  const out = [];
  let total = 0;
  const rootIsFile = (() => { try { return statSync(root).isFile(); } catch { return false; } })();
  for (const f of rootIsFile ? [root] : walkFiles(root)) {
    if (fileFilter) {
      const rel = relative(rootIsFile ? cwd : root, f).split(sep).join('/');
      if (!fileFilter.test(rel) && !fileFilter.test(rel.split('/').pop())) continue;
    }
    let size = 0;
    try { size = statSync(f).size; } catch { continue; }
    if (size > MAX_FILE_BYTES) continue;
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue; // binary
    const lines = text.split(/\r?\n/);
    let fileCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (rx.test(lines[i])) {
        fileCount++;
        total++;
        if (mode === 'content' && out.length < MAX_RESULTS) out.push(`${f}:${i + 1}:${lines[i].slice(0, 500)}`);
        if (mode === 'files_with_matches') break;
      }
    }
    if (fileCount > 0) {
      if (mode === 'files_with_matches') out.push(f);
      else if (mode === 'count') out.push(`${f}:${fileCount}`);
    }
    if (out.length >= MAX_RESULTS) break;
  }
  const note = out.length >= MAX_RESULTS ? `\n[result truncated at ${MAX_RESULTS} entries]` : '';
  return { result: out.length ? out.join('\n') + note : 'No matches.' };
}
