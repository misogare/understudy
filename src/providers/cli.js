// The 'cli' adapter: delegate an entire agent task to a headless coding-agent
// CLI (freebuff/codebuff, gemini, copilot, ...). The CLI brings its own tool
// loop and auth; Understudy composes the prompt, runs the CLI in the
// workspace directory, and captures stdout as the agent's answer.
// Structured output is handled by the agent loop asking for fenced JSON and
// validating it (see runDelegated in runtime/agentloop.js).

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 900000;
const MAX_PROMPT_ARG_CHARS = 25000; // Windows argv limit safety margin

export function makeCliProvider(cfg) {
  return {
    name: cfg.name,
    type: 'cli',
    async run({ prompt, model, cwd, onExec }) {
      const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
      const wantsArg = (cfg.promptVia || 'arg') === 'arg' && prompt.length <= MAX_PROMPT_ARG_CHARS;
      const args = [];
      for (const a of cfg.args || []) {
        if (a.includes('{model}')) {
          if (!model || model === 'cli-default') continue; // let the CLI use its own default
          args.push(a.replace('{model}', model));
        } else if (a.includes('{prompt}')) {
          if (wantsArg) args.push(a.replace('{prompt}', prompt));
          // via stdin: drop the {prompt} placeholder AND its preceding flag
          else if (args.length && /^-/.test(args[args.length - 1])) args.pop();
        } else {
          args.push(a);
        }
      }
      const viaStdin = !wantsArg || !(cfg.args || []).some((a) => a.includes('{prompt}'));
      if (onExec) onExec(`${cfg.command} ${args.map((a) => (a.length > 60 ? a.slice(0, 57) + '...' : a)).join(' ')}${viaStdin ? ' <<stdin' : ''}`);

      return new Promise((resolve, reject) => {
        // Windows npm shims (.cmd/.bat) only run under a shell.
        const isShim = /\.(cmd|bat)$/i.test(cfg.command);
        let out = '';
        let err = '';
        let done = false;
        const child = spawn(cfg.command, args, {
          cwd,
          shell: isShim,
          windowsHide: true,
          env: { ...process.env, ...(cfg.env || {}), NO_COLOR: '1', CI: '1' },
        });
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
          reject(new Error(`${cfg.name} CLI timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (d) => { out += d.toString('utf8'); });
        child.stderr.on('data', (d) => { err += d.toString('utf8'); });
        child.on('error', (e) => {
          if (done) return;
          done = true; clearTimeout(timer);
          reject(new Error(`failed to start ${cfg.command}: ${e.message} — check the "command" path in your provider config`));
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
