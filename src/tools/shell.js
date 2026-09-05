// Bash tool: runs shell commands. On Windows it prefers Git Bash (matching
// the environment Claude Code workflow prompts assume — "Windows Git Bash",
// PYTHONIOENCODING, etc.), falling back to PowerShell.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const MAX_OUTPUT_CHARS = 30000;

let SHELL = null;
export function resolveShell() {
  if (SHELL) return SHELL;
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];
    for (const c of candidates) if (existsSync(c)) return (SHELL = { cmd: c, argsFor: (s) => ['-c', s], kind: 'bash' });
    try {
      const p = spawnSync('where.exe', ['bash.exe'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      // Skip WindowsApps stubs AND System32\bash.exe (that one is WSL, which
      // may have no distro installed and has a different filesystem view).
      const found = (p.stdout || '').split(/\r?\n/).find((l) => l.trim() && !/WindowsApps|\\System32\\/i.test(l));
      if (found) return (SHELL = { cmd: found.trim(), argsFor: (s) => ['-c', s], kind: 'bash' });
    } catch { /* fall through */ }
    return (SHELL = { cmd: 'powershell.exe', argsFor: (s) => ['-NoProfile', '-NonInteractive', '-Command', s], kind: 'powershell' });
  }
  return (SHELL = { cmd: '/bin/bash', argsFor: (s) => ['-c', s], kind: 'bash' });
}

export function toolBash({ command, timeout }, cwd, { onExec } = {}) {
  const shell = resolveShell();
  const ms = Math.min(Math.max(Number(timeout) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  if (onExec) onExec(command);
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn(shell.cmd, shell.argsFor(command), {
      cwd, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killTree(child);
      resolve({ error: `command timed out after ${ms}ms\n${clamp(out)}` });
    }, ms);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ error: `failed to start shell (${shell.cmd}): ${e.message}` });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const body = clamp(out) || '[no output]';
      resolve(code === 0 ? { result: body } : { result: `[exit code ${code}]\n${body}`, isError: true });
    });
  });
}

function clamp(s) {
  return s.length > MAX_OUTPUT_CHARS
    ? s.slice(0, MAX_OUTPUT_CHARS / 2) + `\n…[${s.length - MAX_OUTPUT_CHARS} chars truncated]…\n` + s.slice(-MAX_OUTPUT_CHARS / 2)
    : s;
}

// Kill a spawned process AND its descendants. On Windows, child.kill() only
// terminates the direct child (the shell), orphaning the real worker — use
// taskkill /T instead.
export function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch { /* fall through */ }
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  } else {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }
}
