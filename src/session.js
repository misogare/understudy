// Session identity — keeps concurrent Claude Code sessions (or terminals)
// from trampling each other's runs and handoff files.
//
// Resolution order: explicit --session flag > UNDERSTUDY_SESSION env >
// CLAUDE_CODE_SESSION_ID env (set automatically inside every Claude Code
// shell) > null. Runs are tagged with it, `collect` scopes to it by default,
// and `understudy scratch` hands each session a private directory under
// .understudy/manual/<session>/ for instruction/handoff files.

export function resolveSession(flagValue = null, env = process.env) {
  const raw = flagValue || env.UNDERSTUDY_SESSION || env.CLAUDE_CODE_SESSION_ID || null;
  if (!raw) return null;
  const clean = String(raw).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '').slice(0, 64);
  return clean || null;
}

export function shortSession(s) {
  return s ? String(s).slice(0, 8) : '-';
}
