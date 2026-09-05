// The 'cli' adapter: delegate an entire agent task to a headless coding-agent
// CLI (freebuff/codebuff, gemini, copilot, ...). The CLI brings its own tool
// loop and auth; Understudy composes the prompt, runs the CLI in the
// workspace directory, and captures stdout as the agent's answer.
// Structured output is handled by the agent loop asking for fenced JSON and
// validating it (see runDelegated in runtime/agentloop.js).
//
// Config fields:
//   command      — binary name or full path
//   staticArgs   — always passed (e.g. ['--free'])
//   modelArgs    — passed only when a concrete model is set (['-m','{model}'])
//   promptArgs   — passed only in arg mode (['-p','{prompt}'] or ['{prompt}']);
//                  dropped wholesale when the prompt goes via stdin
//   fullModeArgs — passed only under --mode full (e.g. ['--allow-all-tools'])
//   promptVia    — 'arg' (default) or 'stdin'
//   timeoutMs, env
//   args         — legacy combined form; split into the groups above at load
//
// Windows safety: npm-installed CLIs are .cmd shims which require shell:true
// (cmd.exe). Because cmd.exe interprets metacharacters, the PROMPT is never
// passed through argv for shims — it always goes via stdin — and static args
// are refused if they contain cmd metacharacters.

import { spawn, spawnSync } from 'node:child_process';
import { killTree } from '../tools/shell.js';

const DEFAULT_TIMEOUT_MS = 900000;
const MAX_PROMPT_ARG_CHARS = 25000; // argv limit safety margin

const resolvedCommands = new Map();

// On Windows, resolve a bare command name to its real target: spawn() without
// a shell only finds .exe/.com, and refuses .cmd/.bat entirely, so npm-shim
// CLIs ('gemini', 'copilot') would fail with ENOENT out of the box.
export function resolveCommand(command, { platform = process.platform, probe } = {}) {
  const key = `${platform}:${command}`;
  if (resolvedCommands.has(key)) return resolvedCommands.get(key);
  let out = { cmd: command, shim: /\.(cmd|bat)$/i.test(command) };
  if (platform === 'win32' && !/[\\/]/.test(command) && !/\.[a-z0-9]+$/i.test(command)) {
    try {
      const run = probe || (() => spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true, timeout: 5000 }));
      const p = run();
      const lines = (p.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        .filter((l) => !/\\WindowsApps\\/i.test(l));
      const exe = lines.find((l) => /\.exe$/i.test(l));
      const shim = lines.find((l) => /\.(cmd|bat)$/i.test(l));
      if (exe) out = { cmd: exe, shim: false };
      else if (shim) out = { cmd: shim, shim: true };
    } catch { /* leave as-is; the spawn error will name the command */ }
  }
  resolvedCommands.set(key, out);
  return out;
}

// Legacy `args` arrays are split into the structured groups: a '{prompt}'
// token (plus an immediately preceding flag token) becomes promptArgs, a
// '{model}' token (plus preceding flag) becomes modelArgs, the rest static.
export function normalizeArgSpec(cfg) {
  if (cfg.staticArgs || cfg.promptArgs || cfg.modelArgs) {
    return {
      staticArgs: cfg.staticArgs || [],
      promptArgs: cfg.promptArgs || [],
      modelArgs: cfg.modelArgs || [],
      fullModeArgs: cfg.fullModeArgs || [],
    };
  }
  const groups = { staticArgs: [], promptArgs: [], modelArgs: [], fullModeArgs: cfg.fullModeArgs || [] };
  const args = cfg.args || [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const target = a.includes('{prompt}') ? 'promptArgs' : a.includes('{model}') ? 'modelArgs' : null;
    if (target) {
      const prev = groups.staticArgs[groups.staticArgs.length - 1];
      if (a === `{${target === 'promptArgs' ? 'prompt' : 'model'}}` && prev && /^-/.test(prev)) {
        groups[target].push(groups.staticArgs.pop());
      }
      groups[target].push(a);
    } else {
      groups.staticArgs.push(a);
    }
  }
  return groups;
}

// Pure arg assembly, exported for tests.
export function buildCliArgs(cfg, { prompt, model, mode, shim }) {
  const g = normalizeArgSpec(cfg);
  const args = [];
  if (model && model !== 'cli-default') for (const a of g.modelArgs) args.push(a.replace('{model}', model));
  args.push(...g.staticArgs);
  if (mode === 'full') args.push(...g.fullModeArgs);
  const canArg = !shim
    && (cfg.promptVia || 'arg') === 'arg'
    && prompt.length <= MAX_PROMPT_ARG_CHARS
    && g.promptArgs.some((a) => a.includes('{prompt}'));
  if (canArg) for (const a of g.promptArgs) args.push(a.replace('{prompt}', prompt));
  return { args, viaStdin: !canArg };
}

export function makeCliProvider(cfg) {
  return {
    name: cfg.name,
    type: 'cli',
    async run({ prompt, model, cwd, onExec, mode = 'workspace' }) {
      const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
      const { cmd, shim } = resolveCommand(cfg.command);
      const { args, viaStdin } = buildCliArgs(cfg, { prompt, model, mode, shim });
      if (shim) {
        // cmd.exe joins argv without quoting — refuse anything it would interpret.
        const bad = args.find((a) => /[&|<>^"%\r\n]/.test(a));
        if (bad) throw new Error(`refusing to pass an argument containing cmd.exe metacharacters through the .cmd shim "${cmd}": ${bad.slice(0, 60)}`);
      }
      if (onExec) onExec(`${cmd} ${args.map((a) => (a.length > 60 ? a.slice(0, 57) + '...' : a)).join(' ')}${viaStdin ? ' <<stdin' : ''}`);

      return new Promise((resolve, reject) => {
        let out = '';
        let err = '';
        let done = false;
        const child = spawn(shim && /\s/.test(cmd) ? `"${cmd}"` : cmd, args, {
          cwd,
          shell: shim, // .cmd/.bat shims only run under cmd.exe
          windowsHide: true,
          env: { ...process.env, ...(cfg.env || {}), NO_COLOR: '1', CI: '1' },
        });
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          killTree(child);
          reject(new Error(`${cfg.name} CLI timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (d) => { out += d.toString('utf8'); });
        child.stderr.on('data', (d) => { err += d.toString('utf8'); });
        child.on('error', (e) => {
          if (done) return;
          done = true; clearTimeout(timer);
          reject(new Error(`failed to start ${cmd}: ${e.message} — check the "command" path in your provider config`));
        });
        child.on('close', (code) => {
          if (done) return;
          done = true; clearTimeout(timer);
          const text = stripAnsi(out).trim();
          if (code !== 0 && !text) {
            reject(new Error(`${cfg.name} CLI exited ${code}: ${stripAnsi(err).slice(0, 400)}`));
          } else {
            resolve({ text, exitCode: code, stderr: stripAnsi(err).slice(0, 2000) });
          }
        });
        if (viaStdin) {
          child.stdin.on('error', () => { /* CLI may close stdin early */ });
          child.stdin.write(prompt);
        }
        child.stdin.end();
      });
    },
  };
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}
