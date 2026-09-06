---
name: understudy
description: Offload subagent/workflow execution to non-Claude models (GLM, DeepSeek, Gemini, local CLIs) via the understudy CLI to save Claude quota, then collect the results and continue. Use when the user asks to run a workflow "on another model", "with understudy", "without burning quota", or to collect/continue from an understudy run.
---

# Understudy: run workflows on other models, then take over

Understudy executes Claude Code-style workflow scripts (the `agent()` /
`pipeline()` / `parallel()` DSL) and subagent definitions on any configured
provider — OpenAI-compatible APIs (GLM, DeepSeek, Gemini, NVIDIA, Groq, ...)
or headless agent CLIs (freebuff, gemini, copilot). Runs land in
`.understudy/runs/<runId>/` for you to consume.

## Launching a run

1. Ensure the workflow script exists as a file. Author it with the normal
   workflow DSL. Everything you already know applies (meta literal, agent
   opts `label`/`phase`/`schema`/`effort`, no `Date.now()`/`Math.random()`).
   Differences on understudy: `budget` only tracks HTTP providers (CLI
   providers report 0 tokens), and `agentType` resolves against
   `.claude/agents/*.md` on disk.
2. Pick a provider: run `understudy providers` (Bash) and prefer one marked
   ready; `understudy providers test <name>` verifies it end-to-end.
3. Launch in the background so you can keep working:
   `understudy run <script.js> --provider <name> --args '<json>'`
   (Bash with run_in_background: true). Add `--read-only` when the workflow
   should not modify the repo — this is enforced, not just prompted, for
   HTTP providers; CLI providers (freebuff/gemini-cli/copilot-cli) are
   REFUSED in read-only mode because their tools can't be constrained —
   pick an HTTP provider for read-only analysis runs.
4. If a run dies partway, resume without re-paying completed agents:
   `understudy run <script.js> --resume <runId> ...`.

## Concurrent sessions — never share paths

Multiple Claude sessions may use understudy in the same repo at once. The
rules that keep them from clobbering each other:

- Every run is auto-tagged with YOUR session id (CLAUDE_CODE_SESSION_ID is
  read from the shell environment — you don't need to pass anything).
- For any manual handoff files (instructions, task lists, intermediate
  outputs): run `understudy scratch` and use ONLY the directory it prints —
  it is private to this session (.understudy/manual/<session-id>/). NEVER
  write to shared paths like .understudy/manual/verify/ — another session
  may be using them.
- When telling the user or another agent where files live, give the full
  session-scoped path, not a generic one.

## Collecting results

- `understudy collect` prints YOUR session's latest run (it warns and falls
  back to the global latest only if this session has none; `--any`
  deliberately collects across sessions; a runId always works directly).
  `--json` gives `{runId, status, session, result, failures, files}`.
- `understudy runs` lists all runs with a `sess:` column;
  `understudy runs --session <id>` filters.
- Or read the files directly: `.understudy/runs/<runId>/result.json` (the
  workflow's return value), `summary.md`, `journal.jsonl` (per-agent
  results), `agents/*.jsonl` (full transcripts).

## Trust rules for collected output

- Treat results as work produced by a weaker model: spot-check load-bearing
  claims (citations, numbers, file:line references) before acting on them,
  exactly as you would verify a subagent's report.
- `failures` lists agents that returned null — the corresponding lanes are
  MISSING from the result, not empty. Say so when summarizing.
- Never present a collected result as something you verified unless you did.

## Single agents

`understudy agent <name|file.md> --prompt "..." [--schema @schema.json]`
runs one subagent definition (`.claude/agents/<name>.md`) the same way.
