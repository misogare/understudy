// understudy — run Claude Code subagents & workflows on any model.

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { loadConfig, detectProviders, importContinueConfig, writeProjectConfig, ensureGitignored, stripBom, PROJECT_CONFIG_NAME } from './config.js';
import { listProviders, resolveProvider } from './providers/index.js';
import { runWorkflow } from './runtime/workflow.js';
import { runAgentLoop } from './runtime/agentloop.js';
import { buildToolset, PERMISSION_MODES } from './tools/index.js';
import { loadAgentDef } from './loader/agentmd.js';
import { findWorkflowScripts, dedupeByName, harvest } from './loader/harvest.js';
import { listRuns, collectRun } from './handoff/collect.js';
import { resolveSession, shortSession } from './session.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `understudy — run Claude Code subagents & workflows on any model

USAGE
  understudy <command> [options]

COMMANDS
  init                 Detect providers, write ${PROJECT_CONFIG_NAME}
                         --from-continue  import providers from ~/.continue/config.yaml
                         --force          overwrite an existing config
  providers            List providers and readiness
  providers test <p>   Send a 1-line ping through provider <p>
  harvest              Copy workflow scripts out of ~/.claude session dirs
                         --list           only list what was found
                         --dest <dir>     destination (default ./workflows)
                         --project <s>    filter by project-slug substring
                         --claude-dir <d> override ~/.claude/projects
  run <script.js>      Run a workflow script
                         --provider <p>   provider name (default from config)
                         --args <json>    workflow args (JSON, or @file.json)
                         --budget <n>     output-token budget (openai providers)
                         --mode <m>       read-only | workspace | full (default workspace)
                         --read-only      shorthand for --mode read-only
                         --effort <e>     default effort tier (low|medium|high)
                         --model <id>     force one model for every agent
                         --concurrency <n> --max-turns <n> --temperature <t>
                         --out <dir>      runs root (default ./.understudy/runs)
                         --resume <runId> reuse completed agents from a prior run
  agent <name|file.md> Run a single subagent definition
                         --prompt <text> | --prompt @file   (required)
                         --schema @file.json   force structured output
                         (accepts the same provider/mode flags as run)
  runs                 List runs under the runs root (--session <id> filters)
  show <runId>         Show one run's record (--json for the raw record)
  collect [runId]      Print the handoff digest. With no runId: the CURRENT
                       SESSION's latest run (falls back to global latest with
                       a warning); --any forces global latest
                         --json           machine-readable output
  scratch              Print (and create) this session's private handoff dir
                       (.understudy/manual/<session>/) — use it instead of
                       shared paths so concurrent sessions never collide
  install-skill        Install the Claude Code skill so Claude can drive this
                         --global         into ~/.claude/skills instead of ./.claude/skills
  --version            Print the version

providers/show also accept --json. The runs root can be set per-invocation
with --out, or via UNDERSTUDY_OUT / config "out".

SESSIONS: every run is tagged with a session id — --session <id>, else
UNDERSTUDY_SESSION, else CLAUDE_CODE_SESSION_ID (set automatically inside
Claude Code shells). Concurrent sessions therefore keep separate runs,
collect their own latest by default, and get private scratch dirs.

Docs & examples: see README.md in this repository.
`;

export async function main(argv = process.argv.slice(2)) {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    strict: false,
    allowPositionals: true,
    options: {
      provider: { type: 'string' }, args: { type: 'string' }, budget: { type: 'string' },
      mode: { type: 'string' }, 'read-only': { type: 'boolean' }, effort: { type: 'string' },
      model: { type: 'string' }, concurrency: { type: 'string' }, 'max-turns': { type: 'string' },
      temperature: { type: 'string' }, out: { type: 'string' }, resume: { type: 'string' },
      prompt: { type: 'string' }, schema: { type: 'string' },
      dest: { type: 'string' }, project: { type: 'string' }, 'claude-dir': { type: 'string' },
      list: { type: 'boolean' }, json: { type: 'boolean' }, force: { type: 'boolean' },
      'from-continue': { type: 'boolean' }, global: { type: 'boolean' },
      session: { type: 'string' }, any: { type: 'boolean' },
      help: { type: 'boolean' }, version: { type: 'boolean' },
    },
  });

  const cmd = positionals[0];
  if (flags.version) return print(pkg().version);
  if (!cmd || flags.help || cmd === 'help') return print(HELP);

  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const outRoot = resolve(flags.out || process.env.UNDERSTUDY_OUT || config.out || join(cwd, '.understudy', 'runs'));

  switch (cmd) {
    case 'init': return cmdInit(cwd, flags);
    case 'providers': return cmdProviders(config, positionals, flags);
    case 'harvest': return cmdHarvest(flags);
    case 'run': return cmdRun(config, cwd, outRoot, positionals, flags);
    case 'agent': return cmdAgent(config, cwd, outRoot, positionals, flags);
    case 'runs': return cmdRuns(outRoot, flags);
    case 'show': return cmdShow(outRoot, positionals, flags);
    case 'collect': return cmdCollect(outRoot, positionals, flags);
    case 'scratch': return cmdScratch(cwd, flags);
    case 'install-skill': return cmdInstallSkill(cwd, flags);
    default:
      fail(`unknown command "${cmd}" — run \`understudy help\``);
  }
}

// ── commands ────────────────────────────────────────────────────────────

function cmdInit(cwd, flags) {
  const target = join(cwd, PROJECT_CONFIG_NAME);
  if (existsSync(target) && !flags.force) fail(`${target} already exists (use --force to overwrite)`);

  const detected = detectProviders();
  const providers = {};
  for (const d of detected) if (d.override) providers[d.name] = { ...d.override };

  let continueNote = '';
  if (flags['from-continue']) {
    const imported = importContinueConfig();
    Object.assign(providers, imported.providers);
    continueNote = imported.path
      ? `Imported ${Object.keys(imported.providers).length} provider(s) from ${imported.path}.`
      : 'No ~/.continue/config.yaml found.';
    const withKeys = Object.values(imported.providers).filter((p) => p.apiKey).length;
    if (withKeys) continueNote += `\n  NOTE: ${withKeys} imported entr${withKeys === 1 ? 'y carries' : 'ies carry'} an inline apiKey copied from Continue's config. init adds ${PROJECT_CONFIG_NAME} to your .gitignore, but moving keys to env vars (apiKeyEnv) is safer.`;
  }

  const defaultProvider = detected.find((d) => d.name !== 'copilot-cli')?.name
    || Object.keys(providers)[0] || 'mock';
  const cfg = {
    defaultProvider,
    providers,
    concurrency: 8,
    maxTurnsPerAgent: 40,
    toolResultClampChars: 30000,
  };
  writeProjectConfig(cwd, cfg);
  print(`Wrote ${target}`);
  const gi = ensureGitignored(cwd);
  if (gi.action === 'appended') print(`Added ${gi.added.join(', ')} to ${gi.path}`);
  else if (gi.action === 'no-git-repo') print(`NOTE: no git repo here — if you later init one, add ${PROJECT_CONFIG_NAME} and .understudy/ to its .gitignore.`);
  if (detected.length) {
    print('Detected:');
    for (const d of detected) print(`  - ${d.name}  (${d.why})`);
  } else {
    print('No providers auto-detected — defaultProvider set to "mock" (keyless dry runs).');
    print('Set an API key env var (e.g. GEMINI_API_KEY, DEEPSEEK_API_KEY) or edit the config.');
  }
  if (continueNote) print(continueNote);
  print(`Default provider: ${defaultProvider}. Verify with: understudy providers test ${defaultProvider}`);
}

function cmdProviders(config, positionals, flags) {
  if (positionals[1] === 'test') return testProvider(config, positionals[2], flags);
  const rows = listProviders(config);
  if (flags.json) return print(JSON.stringify(rows, null, 2));
  const w = Math.max(...rows.map((r) => r.name.length)) + 2;
  print('PROVIDER'.padEnd(w) + 'TYPE'.padEnd(8) + 'READY'.padEnd(7) + 'TARGET');
  for (const r of rows.sort((a, b) => (b.ready - a.ready) || a.name.localeCompare(b.name))) {
    const target = r.target || '-';
    const key = !r.ready && r.apiKeyEnv ? `  (set ${r.apiKeyEnv})` : '';
    print(r.name.padEnd(w) + r.type.padEnd(8) + (r.ready ? 'yes' : 'no').padEnd(7) + target + key);
  }
  print('\n"ready" = key env var set / CLI command configured. Verify with: understudy providers test <name>');
}

async function testProvider(config, name, flags) {
  if (!name) fail('usage: understudy providers test <name>');
  const provider = resolveProvider(config, name);
  const t0 = Date.now();
  try {
    if (provider.type === 'cli') {
      const out = await provider.client.run({ prompt: 'Reply with exactly the single word: OK', model: provider.modelFor({}), cwd: process.cwd() });
      print(`OK (${Date.now() - t0}ms) — ${provider.name} replied: ${out.text.slice(0, 200)}`);
    } else {
      const resp = await provider.client.chat({
        model: provider.modelFor({}),
        messages: [{ role: 'user', content: 'Reply with exactly the single word: OK' }],
      });
      print(`OK (${Date.now() - t0}ms) — ${provider.name}:${provider.modelFor({})} replied: ${resp.text.slice(0, 200)} [tokens in ${resp.usage.input} / out ${resp.usage.output}]`);
    }
  } catch (e) {
    fail(`provider ${name} failed: ${e.message}`);
  }
}

function cmdHarvest(flags) {
  const opts = { claudeDir: flags['claude-dir'] || null, project: flags.project || null };
  if (flags.list) {
    const all = dedupeByName(findWorkflowScripts(opts));
    if (!all.length) return print('No workflow scripts found in Claude Code session directories.');
    for (const s of all) {
      print(`${s.name}`);
      print(`    ${s.description || '(no description)'}`);
      print(`    ${s.path}`);
    }
    print(`\n${all.length} unique workflow(s). Copy them with: understudy harvest --dest workflows`);
    return;
  }
  const dest = resolve(flags.dest || 'workflows');
  const { total, unique, copied } = harvest({ dest, ...opts });
  for (const c of copied) print(`  ${c.name}.js  <- session ${c.session.slice(0, 8)}`);
  print(`Harvested ${unique} unique workflow(s) (${total} versions found) into ${dest}`);
}

async function cmdRun(config, cwd, outRoot, positionals, flags) {
  const scriptArg = positionals[1];
  if (!scriptArg) fail('usage: understudy run <script.js> [options]');
  const scriptPath = resolve(scriptArg);
  if (!existsSync(scriptPath)) fail(`script not found: ${scriptPath}`);
  const source = readFileSync(scriptPath, 'utf8');

  const provider = resolveProvider(config, flags.provider);
  if (flags.model) {
    // --model FORCES one model for every agent, as documented — including
    // agents that pass their own opts.model.
    const forced = flags.model;
    provider.modelFor = () => forced;
  }
  const args = parseArgsFlag(flags.args);
  const runId = 'uwf_' + randomBytes(5).toString('hex');
  const mode = flags['read-only'] ? 'read-only' : (flags.mode || config.mode || 'workspace');
  if (!PERMISSION_MODES.includes(mode)) fail(`invalid --mode "${mode}" — use one of: ${PERMISSION_MODES.join(' | ')}`);
  if (provider.type === 'cli' && mode === 'read-only') {
    fail('read-only mode cannot be enforced for CLI providers (their tools run outside understudy). Use an HTTP provider such as deepseek/gemini/glm, or drop --read-only.');
  }
  let budgetTotal = null;
  if (flags.budget != null) {
    budgetTotal = Number(flags.budget);
    if (!Number.isFinite(budgetTotal) || budgetTotal <= 0) fail(`--budget must be a positive number of output tokens (got "${flags.budget}")`);
  }
  mkdirSync(outRoot, { recursive: true });

  const resumeJournalPath = flags.resume ? join(outRoot, flags.resume, 'journal.jsonl') : null;
  if (flags.resume && !existsSync(resumeJournalPath)) fail(`no journal for run ${flags.resume} under ${outRoot}`);

  const session = resolveSession(flags.session);
  print(`run ${runId}: ${scriptPath}`);
  print(`provider ${provider.name} | mode ${mode} | session ${shortSession(session)} | out ${join(outRoot, runId)}`);
  const t0 = Date.now();
  try {
    const { result, record, runDir } = await runWorkflow({
      source, scriptPath, args, provider, config, outRoot, runId,
      budgetTotal,
      mode, cwd, session,
      resumeJournalPath,
      onLog: (m) => print(`  ${m}`),
      defaultEffort: flags.effort || null,
      temperature: flags.temperature ? Number(flags.temperature) : undefined,
      maxTurns: flags['max-turns'] ? Number(flags['max-turns']) : undefined,
      concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
    });
    print('');
    print(`DONE in ${Math.round((Date.now() - t0) / 1000)}s — ${record.agentCount} agents, ${record.totalToolCalls} tool calls, ${record.totalTokens} tokens`);
    print(`result:  ${join(runDir, 'result.json')}`);
    print(`summary: ${join(runDir, 'summary.md')}`);
    const s = typeof result === 'string' ? result : JSON.stringify(result);
    if (s != null) print(`return value: ${s.length > 600 ? s.slice(0, 600) + '…' : s}`);
    // Force exit: a script that leaked a timer must not hang the CLI.
    flushThenExit(0);
  } catch (e) {
    print('');
    fail(`workflow failed after ${Math.round((Date.now() - t0) / 1000)}s: ${e.message}\n(partial journal + record in ${join(outRoot, runId)}; fix and resume with --resume ${runId})`);
  }
}

async function cmdAgent(config, cwd, outRoot, positionals, flags) {
  const ref = positionals[1];
  if (!ref) fail('usage: understudy agent <name|file.md> --prompt "..."');
  if (!flags.prompt) fail('--prompt is required');
  const prompt = flags.prompt.startsWith('@') ? stripBom(readFileSync(flags.prompt.slice(1), 'utf8')) : flags.prompt;
  const schema = flags.schema ? JSON.parse(stripBom(readFileSync(flags.schema.replace(/^@/, ''), 'utf8'))) : undefined;
  const def = loadAgentDef(ref, cwd);
  if (!def) {
    fail(`agent definition "${ref}" not found — looked for ${ref.endsWith('.md') ? ref : `.claude/agents/${ref}.md`} in the project and in ~/.claude. Pass a .md path or create the definition.`);
  }

  const provider = resolveProvider(config, flags.provider);
  const mode = flags['read-only'] ? 'read-only' : (flags.mode || config.mode || 'workspace');
  if (!PERMISSION_MODES.includes(mode)) fail(`invalid --mode "${mode}" — use one of: ${PERMISSION_MODES.join(' | ')}`);
  if (provider.type === 'cli' && mode === 'read-only') {
    fail('read-only mode cannot be enforced for CLI providers (their tools run outside understudy). Use an HTTP provider, or drop --read-only.');
  }
  const runId = 'uag_' + randomBytes(5).toString('hex');
  const runDir = join(outRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const usage = { input: 0, output: 0 };
  const toolset = buildToolset({ cwd, mode, allowPaths: config.allowPaths || [], config });
  const out = await runAgentLoop({
    prompt, label: def.name || ref, schema, provider,
    model: provider.modelFor({ model: flags.model || def.model, effort: flags.effort }),
    effort: flags.effort || null, toolset, cwd, mode,
    maxTurns: flags['max-turns'] ? Number(flags['max-turns']) : config.maxTurnsPerAgent,
    transcriptPath: join(runDir, 'transcript.jsonl'),
    usage, agentBody: def.body || null,
    temperature: flags.temperature ? Number(flags.temperature) : undefined,
  });
  const value = out.value !== undefined ? out.value : out.text;
  const session = resolveSession(flags.session);
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({ ok: out.ok, error: out.error || null, ...(session ? { session } : {}), value }, null, 2));
  if (!out.ok) fail(`agent failed: ${out.error}\n(transcript in ${runDir})`);
  print(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  print(`\n[tokens in ${usage.input} / out ${usage.output}] transcript: ${runDir}`);
  flushThenExit(0);
}

function cmdRuns(outRoot, flags = {}) {
  let runs = listRuns(outRoot);
  const filter = flags.session ? resolveSession(flags.session) : null;
  if (filter) runs = runs.filter((r) => r.session === filter);
  if (!runs.length) return print(`No runs${filter ? ` for session ${filter}` : ''} under ${outRoot}`);
  for (const r of runs) {
    print(`${r.runId}  ${String(r.status).padEnd(10)} ${String(r.name).padEnd(30)} sess:${shortSession(r.session)} agents:${r.agents ?? '?'} tokens:${r.tokens ?? '?'}  ${r.provider}`);
  }
}

function cmdShow(outRoot, positionals, flags) {
  const session = flags.any ? null : resolveSession(flags.session);
  const c = collectRun(outRoot, positionals[1] || null, session);
  if (c.error) fail(c.error);
  if (c.sessionFallback) print(`NOTE: no runs for session ${shortSession(session)} — showing the latest run overall (session ${shortSession(c.run.session)}). Use --any to silence this.`);
  if (flags.json) return print(JSON.stringify(c.record, null, 2));
  const r = c.record;
  if (!r) fail(`run ${c.run.runId} has no readable record${c.recordError ? ` (${c.recordError})` : ' (crashed early?)'} — journal: ${c.files.journal}`);
  print(`${r.workflowName} (${r.runId}) — ${r.status}`);
  print(`provider ${r.defaultModel} | agents ${r.agentCount} | tokens ${r.totalTokens} | ${Math.round(r.durationMs / 1000)}s`);
  if (c.failures.length) {
    print(`failed agents: ${c.failures.length}`);
    for (const f of c.failures.slice(0, 10)) print(`  - ${f.agentId}: ${f.error || '?'}`);
  }
  print(`summary: ${c.files.summary}`);
}

function cmdCollect(outRoot, positionals, flags) {
  const session = flags.any ? null : resolveSession(flags.session);
  const c = collectRun(outRoot, positionals[1] || null, session);
  if (c.error) fail(c.error);
  if (flags.json) {
    return print(JSON.stringify({
      runId: c.run.runId, status: c.run.status, workflowName: c.run.name,
      session: c.run.session || null, sessionFallback: !!c.sessionFallback,
      result: c.record?.result ?? null, failures: c.failures, files: c.files,
    }, null, 2));
  }
  if (c.sessionFallback) print(`NOTE: no runs for session ${shortSession(session)} — collecting the latest run overall (session ${shortSession(c.run.session)}). Use --any to silence this.`);
  if (c.recordError) print(`WARNING: ${c.recordError}`);
  if (c.files.summary) print(readFileSync(c.files.summary, 'utf8'));
  else print(`Run ${c.run.runId}: status ${c.run.status}; no summary written. Journal: ${c.files.journal}`);
  if (c.failures.length) print(`\nNOTE: ${c.failures.length} agent(s) failed — treat missing sections accordingly.`);
  print(`\nFull result: ${c.files.result}`);
}

function cmdScratch(cwd, flags) {
  const session = resolveSession(flags.session);
  if (!session) {
    fail('no session id available — pass --session <id> or set UNDERSTUDY_SESSION. (Inside Claude Code shells, CLAUDE_CODE_SESSION_ID is picked up automatically.)');
  }
  const dir = join(cwd, '.understudy', 'manual', session);
  mkdirSync(dir, { recursive: true });
  print(dir);
}

function cmdInstallSkill(cwd, flags) {
  const src = join(HERE, '..', 'skills', 'understudy', 'SKILL.md');
  if (!existsSync(src)) fail(`skill source missing: ${src}`);
  const destDir = flags.global
    ? join(homedir(), '.claude', 'skills', 'understudy')
    : join(cwd, '.claude', 'skills', 'understudy');
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, join(destDir, 'SKILL.md'));
  print(`Installed skill to ${join(destDir, 'SKILL.md')}`);
  print('Claude Code will list it as "understudy" — it teaches Claude to offload workflows here and collect the results.');
}

// ── helpers ─────────────────────────────────────────────────────────────

function parseArgsFlag(v) {
  if (v == null) return undefined;
  const text = v.startsWith('@') ? stripBom(readFileSync(v.slice(1), 'utf8')) : v;
  try { return JSON.parse(text); } catch { return text; }
}

// process.exit() can truncate pending stdout on pipes — flush first. Forcing
// the exit matters: a workflow script that leaked a setInterval/setTimeout
// would otherwise keep the CLI alive after DONE.
function flushThenExit(code) {
  process.stdout.write('', () => process.exit(code));
}

function pkg() {
  return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
}

function print(s) { process.stdout.write(s + '\n'); }
function fail(s) { process.stderr.write('understudy: ' + s + '\n'); process.exit(1); }
