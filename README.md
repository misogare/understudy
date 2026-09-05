# Understudy

**Run Claude Code subagents & workflow scripts on any model — then hand the
results back to Claude.**

> In theatre, the understudy learns the star's role and goes on when the star
> can't. Understudy does that for Claude Code: the workflows Claude authored
> keep running — on GLM, DeepSeek, Gemini, local models, or free agent CLIs —
> while your Claude quota stays untouched. When the run finishes, Claude picks
> up the results and continues.

Claude Code's multi-agent **Workflow** scripts are plain JavaScript against a
small API (`agent()`, `pipeline()`, `parallel()`, `phase()`, `log()`, `args`,
`budget`). Its **subagents** are markdown files with YAML frontmatter. Neither
is actually Claude-specific — only the runtime was. Understudy is that runtime,
model-agnostic and zero-dependency.

```
Claude Code (authors)          Understudy (executes)              Claude Code (continues)
─────────────────────          ──────────────────────             ───────────────────────
workflow scripts (.js)   ──►   any OpenAI-compatible API     ──►  .understudy/runs/<id>/
.claude/agents/*.md            (GLM, DeepSeek, Gemini,            result.json, summary.md,
                               NVIDIA, Groq, Ollama, ...)         journal.jsonl, transcripts
                               or a headless agent CLI
                               (freebuff, gemini, copilot)
```

## Install

```bash
git clone <this repo> && cd understudy
npm link          # or: node bin/understudy.js ... directly
node --test "test/*.test.js"
```

Requires Node >= 18.17. No dependencies.

## Quickstart

```bash
# 1. Detect what you have (env keys, agent CLIs, ~/.continue providers)
understudy init --from-continue

# 2. See what's ready and verify one provider end-to-end
understudy providers
understudy providers test gemini-cli

# 3. Pull the workflow scripts Claude Code already wrote for you out of its
#    session directories (they're preserved on disk after every run)
understudy harvest --list
understudy harvest --dest workflows

# 4. Dry-run any workflow with zero API calls (built-in mock provider)
understudy run workflows/my-workflow.js --provider mock

# 5. Run it for real on a free model
understudy run workflows/my-workflow.js --provider gemini-cli --args '{"files":["src/a.py"]}'

# 6. Collect the results (or let Claude do it — see Handoff below)
understudy collect
```

## Two ways to run an agent

**HTTP providers (`type: "openai"`)** — anything speaking the OpenAI
chat-completions protocol. Understudy runs the agent loop itself and gives the
model real, local implementations of the tools Claude Code prompts name:
`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch` (+ `WebSearch` if
configured), plus `StructuredOutput` enforcing the `schema:` option with
validation-and-retry. Prompts written for Claude subagents ("use the Write
tool", "grep for X") work unmodified.

**Agent CLIs (`type: "cli"`)** — headless coding agents that bring their own
tools and auth: `freebuff` (free GLM/DeepSeek tier), `gemini` (works on OAuth,
no API key), `copilot`. Understudy composes the prompt, runs the CLI in your
workspace, and parses the output — including fenced-JSON structured output
with one validation-feedback retry.

Built-in presets (activate by setting the env var, or override in config):

| Provider | Type | Needs |
|---|---|---|
| `deepseek`, `glm`, `gemini`, `github-models`, `openrouter`, `nvidia`, `groq`, `cerebras`, `mistral`, `openai` | openai | their API key env var |
| `litellm` | openai | a LiteLLM proxy on localhost:4000 |
| `ollama` | openai | Ollama running locally |
| `freebuff`, `gemini-cli`, `copilot-cli` | cli | the CLI installed & logged in |
| `mock` | mock | nothing — deterministic dry runs |

`understudy init` auto-detects env keys, the freebuff binary, gemini OAuth
state, and (with `--from-continue`) imports every OpenAI-compatible endpoint
from `~/.continue/config.yaml`.

## What a workflow script gets

The same contract Claude Code documents, faithfully:

- `agent(prompt, {label, phase, schema, model, effort, agentType})` — returns
  the agent's text, or the schema-validated object; `null` if the agent dies
  on a terminal error (`.filter(Boolean)` your arrays).
- `pipeline(items, ...stages)` — per-item chains, **no barrier** between
  stages; a stage callback receives `(prevResult, originalItem, index)`; a
  throwing stage drops that item to `null`.
- `parallel(thunks)` — barrier; a throwing thunk resolves to `null`.
- `phase(title)`, `log(msg)`, `args`, `budget.{total,spent(),remaining()}`,
  one level of `workflow({scriptPath}, args)`.
- Concurrency capped at `min(16, cpus-2)` (configurable); 1000-agent lifetime
  cap; `Math.random()` / `Date.now()` / argless `new Date()` throw, because
  agent-call hashes must be stable across resumes.
- `journal.jsonl` uses Claude Code's format (`v2:<sha256>` content-hash keys)
  — `--resume <runId>` replays completed agents instantly and re-runs only
  what changed. (Hashes are self-consistent within Understudy, not
  byte-identical to Claude's.)

Honest differences: `effort` maps to your provider's model tiers
(`models: {low, default, high}`) rather than Claude reasoning effort;
`opts.model` with a Claude name ("opus", "sonnet") maps to those tiers too;
CLI providers report 0 tokens so `budget` only constrains HTTP providers;
`agentType` resolves against `.claude/agents/*.md` on disk.

## Handoff: letting Claude take over

Every run writes `.understudy/runs/<runId>/`:

| File | Contents |
|---|---|
| `result.json` | the workflow's return value |
| `summary.md` | status, counts, tokens, result digest, log tail |
| `wf_<id>.json` | full run record (Claude Code-compatible keys) |
| `journal.jsonl` | per-agent results — the resume ledger |
| `agents/*.jsonl` | full per-agent transcripts |

Install the bundled Claude Code skill so Claude knows how to drive this:

```bash
understudy install-skill            # into ./.claude/skills/understudy
understudy install-skill --global   # into ~/.claude/skills
```

Then, in a Claude Code session: *"run the review workflow with understudy on
gemini and pick up the results"* — Claude launches the run in the background,
reads `result.json` when it's done, and continues with its own (stronger)
analysis on top. The skill also tells Claude to treat collected output as
work from a weaker model: spot-check load-bearing claims, and report failed
agents as missing lanes rather than empty results.

## Permissions

The corpus of real Claude workflows enforces safety by prompt text only
("STRICTLY READ-ONLY..."). Understudy adds an enforced policy:

- `--read-only` — no Write/Edit/Bash tools at all.
- `workspace` (default) — Write/Edit confined to the working directory;
  Bash available but **not** confined (it's a policy default, not a sandbox —
  don't run untrusted workflows against models you don't trust).
- `--mode full` — no confinement.

## Single agents

```bash
understudy agent reviewer --prompt "Review src/app.py for bugs" --provider deepseek
understudy agent path/to/agent.md --prompt @task.txt --schema @findings.schema.json
```

Resolves `.claude/agents/<name>.md` (project, then `~/.claude`), uses its body
as the system-prompt extension and its `model:` field via the tier mapping.

## Security notes

- Keys belong in env vars (`apiKeyEnv`); `understudy.config.json` is
  gitignored by default because `init --from-continue` may copy inline keys
  from Continue's config — move them to env vars when you can.
- A model with the Bash tool can run arbitrary commands in your workspace.
  Use `--read-only` for analysis workflows, and prefer trusted providers for
  anything with write access.
- Treat model output as untrusted data everywhere downstream.

## Limitations (v0.1)

- No streaming; agent transcripts are written as JSONL events, not live UI.
- `WebSearch` needs a search API config (Tavily-style); otherwise agents are
  told it's unavailable.
- CLI providers can't report token usage; budget enforcement is HTTP-only.
- Provider tool-calling quality varies — the schema salvage/nudge path papers
  over a lot, but a model that can't function-call reliably will do better via
  a `cli` provider or a stronger free tier.

MIT. Built to make agent workflows portable — the orchestration is yours, not
your vendor's.
