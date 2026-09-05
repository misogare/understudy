// Config loading and `understudy init` detection.
//
// Sources, later wins:
//   1. ~/.understudy/config.json          (user-global)
//   2. <walk up from cwd>/understudy.config.json   (project)
//   3. env: UNDERSTUDY_PROVIDER, UNDERSTUDY_OUT (runs root; read in cli.js)
//
// understudy.config.json shape:
// {
//   "defaultProvider": "gemini-cli",
//   "providers": { "<name>": { ...same fields as presets... } },
//   "concurrency": 8, "maxTurnsPerAgent": 40, "toolResultClampChars": 30000,
//   "allowPaths": [], "search": {"type": "tavily", "apiKeyEnv": "TAVILY_API_KEY"}
// }

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PRESETS } from './providers/presets.js';

export const PROJECT_CONFIG_NAME = 'understudy.config.json';

export function findProjectConfig(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    const p = join(dir, PROJECT_CONFIG_NAME);
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Windows editors and PowerShell redirection commonly stamp a UTF-8 BOM.
export function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function readJson(p) {
  try { return JSON.parse(stripBom(readFileSync(p, 'utf8'))); } catch (e) {
    throw new Error(`invalid JSON in ${p}: ${e.message}`);
  }
}

export function loadConfig(cwd = process.cwd()) {
  const globalPath = join(homedir(), '.understudy', 'config.json');
  const projectPath = findProjectConfig(cwd);
  const g = existsSync(globalPath) ? readJson(globalPath) : {};
  const p = projectPath ? readJson(projectPath) : {};
  const merged = {
    ...g, ...p,
    providers: { ...(g.providers || {}), ...(p.providers || {}) },
  };
  if (process.env.UNDERSTUDY_PROVIDER) merged.defaultProvider = process.env.UNDERSTUDY_PROVIDER;
  merged._projectConfigPath = projectPath;
  merged._globalConfigPath = existsSync(globalPath) ? globalPath : null;
  return merged;
}

// ── init detection ──────────────────────────────────────────────────────

export function detectProviders() {
  const found = [];
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (preset.type === 'openai' && preset.apiKeyEnv && process.env[preset.apiKeyEnv]) {
      found.push({ name, why: `env ${preset.apiKeyEnv} is set` });
    }
  }
  // freebuff/codebuff binary in its known home
  for (const [name, rel] of [
    ['freebuff', join('.config', 'manicode', 'freebuff.exe')],
    ['freebuff', join('.config', 'manicode', 'freebuff')],
  ]) {
    const p = join(homedir(), rel);
    if (existsSync(p)) { found.push({ name, why: `binary at ${p}`, override: { command: p } }); break; }
  }
  // gemini CLI OAuth state
  if (existsSync(join(homedir(), '.gemini', 'oauth_creds.json'))) {
    found.push({ name: 'gemini-cli', why: 'OAuth credentials in ~/.gemini' });
  }
  // copilot CLI
  if (existsSync(join(homedir(), '.copilot'))) {
    found.push({ name: 'copilot-cli', why: '~/.copilot exists' });
  }
  return found;
}

// Best-effort scrape of ~/.continue/config.yaml (Continue's model list) —
// enough YAML to lift name/provider/model/apiBase/apiKey without a parser.
export function importContinueConfig(home = homedir()) {
  const path = ['config.yaml', 'config.yml'].map((f) => join(home, '.continue', f)).find(existsSync);
  if (!path) return { path: null, providers: {} };
  const text = readFileSync(path, 'utf8');
  const modelsSection = text.split(/^models:\s*$/m)[1];
  if (!modelsSection) return { path, providers: {} };

  const entries = [];
  let cur = null;
  for (const raw of modelsSection.split('\n')) {
    if (/^\S/.test(raw) && raw.trim() !== '') break; // left the models: block
    const item = raw.match(/^\s*-\s+name:\s*(.+)$/);
    if (item) { cur = { name: strip(item[1]) }; entries.push(cur); continue; }
    if (!cur) continue;
    const kv = raw.match(/^\s+(provider|model|apiBase|apiKey):\s*(.+)$/);
    if (kv) cur[kv[1]] = strip(kv[2]);
  }

  const PROVIDER_BASE = {
    groq: 'https://api.groq.com/openai/v1',
    mistral: 'https://api.mistral.ai/v1',
    cerebras: 'https://api.cerebras.ai/v1',
    deepseek: 'https://api.deepseek.com/v1',
    openai: null, // needs apiBase
  };

  const providers = {};
  for (const e of entries) {
    if (!e.model || !e.provider) continue;
    if (e.provider === 'ollama') continue; // covered by the ollama preset
    const baseUrl = e.apiBase || PROVIDER_BASE[e.provider];
    if (!baseUrl) continue;
    const slug = ('continue-' + e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 40);
    providers[slug] = {
      type: 'openai',
      baseUrl: baseUrl.replace(/\/+$/, ''),
      models: { default: e.model },
      ...(e.apiKey ? { apiKey: e.apiKey } : {}),
      comment: `imported from ${path} (${e.name})`,
    };
  }
  return { path, providers };
}

export function writeProjectConfig(cwd, config) {
  const path = join(cwd, PROJECT_CONFIG_NAME);
  const { _projectConfigPath, _globalConfigPath, ...clean } = config;
  writeFileSync(path, JSON.stringify(clean, null, 2) + '\n');
  return path;
}

export function ensureGlobalDir() {
  const dir = join(homedir(), '.understudy');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Make the "your config stays out of git" promise true: append the entries to
// the project's .gitignore (idempotent). Returns what was done for reporting.
export function ensureGitignored(cwd, entries = [PROJECT_CONFIG_NAME, '.understudy/']) {
  if (!existsSync(join(cwd, '.git'))) return { action: 'no-git-repo', added: [] };
  const path = join(cwd, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const added = entries.filter((e) => !lines.has(e) && !lines.has(e.replace(/\/$/, '')));
  if (added.length) {
    const suffix = current && !current.endsWith('\n') ? '\n' : '';
    writeFileSync(path, current + suffix + added.join('\n') + '\n');
  }
  return { action: added.length ? 'appended' : 'already-present', added, path };
}

function strip(s) {
  return s.trim().replace(/^["']|["']$/g, '');
}
