// The toolset an 'openai'-type agent gets: local implementations of the tools
// Claude Code workflow prompts name — Read, Write, Edit, Glob, Grep, Bash,
// WebFetch, WebSearch — exposed via provider function calling, with a
// declarative permission policy the corpus never had.
//
// Modes:
//   read-only  — Read/Glob/Grep/WebFetch(/WebSearch) only.
//   workspace  — everything; Write/Edit confined to the working directory
//                (+allowPaths). Bash is available and NOT confined — this is
//                a policy default, not a sandbox; documented in the README.
//   full       — everything, no confinement.

import { resolve, relative, isAbsolute } from 'node:path';
import { toolRead, toolWrite, toolEdit } from './fs.js';
import { toolGlob, toolGrep } from './search.js';
import { toolBash } from './shell.js';
import { toolWebFetch, toolWebSearch } from './web.js';

const S = (desc, props, required) => ({
  type: 'object',
  description: desc,
  properties: props,
  required,
});

function defsFor(mode, searchConfigured) {
  const str = (d) => ({ type: 'string', description: d });
  const int = (d) => ({ type: 'integer', description: d });
  const all = [
    {
      name: 'Read',
      description: 'Read a file from the filesystem. Returns numbered lines.',
      parameters: S('', { file_path: str('absolute or workspace-relative path'), offset: int('1-based line to start from'), limit: int('max lines to return') }, ['file_path']),
    },
    {
      name: 'Glob',
      description: 'Find files by glob pattern (e.g. "**/*.js"). Returns paths, newest first.',
      parameters: S('', { pattern: str('glob pattern'), path: str('directory to search (default: workspace)') }, ['pattern']),
    },
    {
      name: 'Grep',
      description: 'Search file contents with a regex. output_mode: files_with_matches (default) | content | count.',
      parameters: S('', {
        pattern: str('regular expression'),
        path: str('file or directory to search (default: workspace)'),
        glob: str('filter files by glob, e.g. "*.py"'),
        output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
        context: int('lines of context around matches (content mode)'),
        ignoreCase: { type: 'boolean' },
      }, ['pattern']),
    },
    {
      name: 'WebFetch',
      description: 'Fetch a URL and return its readable text content.',
      parameters: S('', { url: str('http(s) URL') }, ['url']),
    },
  ];
  if (searchConfigured) {
    all.push({
      name: 'WebSearch',
      description: 'Search the web. Returns result titles, URLs and snippets.',
      parameters: S('', { query: str('search query') }, ['query']),
    });
  }
  if (mode !== 'read-only') {
    all.push(
      {
        name: 'Write',
        description: 'Write a file (creates parent directories, overwrites existing content).',
        parameters: S('', { file_path: str('absolute or workspace-relative path'), content: str('full file content') }, ['file_path', 'content']),
      },
      {
        name: 'Edit',
        description: 'Replace an exact string in a file. old_string must match exactly and be unique unless replace_all.',
        parameters: S('', { file_path: str(''), old_string: str('exact text to replace'), new_string: str('replacement text'), replace_all: { type: 'boolean' } }, ['file_path', 'old_string', 'new_string']),
      },
      {
        name: 'Bash',
        description: 'Run a shell command in the workspace (Git Bash on Windows, bash elsewhere). Returns combined output.',
        parameters: S('', { command: str('the command to run'), timeout: int('milliseconds, max 600000'), description: str('what this command does') }, ['command']),
      },
    );
  }
  return all.map((t) => ({ type: 'function', function: t }));
}

export function buildToolset({ cwd, mode = 'workspace', allowPaths = [], config = {}, onEvent = null }) {
  const searchConfigured = !!(config.search && config.search.type);
  const roots = [resolve(cwd), ...allowPaths.map((p) => resolve(p))];
  const state = { toolCalls: 0 };

  const resolvePath = (p) => (isAbsolute(p) ? resolve(p) : resolve(cwd, p));
  const inRoots = (p) => roots.some((r) => {
    const rel = relative(r, p);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });

  async function execute(name, args) {
    state.toolCalls += 1;
    if (onEvent) onEvent({ type: 'tool', name, args: previewArgs(args) });
    try {
      switch (name) {
        case 'Read': return wrap(toolRead({ ...args, file_path: resolvePath(args.file_path) }));
        case 'Glob': return wrap(toolGlob({ ...args, path: args.path ? resolvePath(args.path) : undefined }, cwd));
        case 'Grep': return wrap(toolGrep({ ...args, path: args.path ? resolvePath(args.path) : undefined }, cwd));
        case 'WebFetch': return wrap(await toolWebFetch(args));
        case 'WebSearch': return wrap(await toolWebSearch(args, config.search));
        case 'Write': {
          if (mode === 'read-only') return { content: 'ERROR: Write is not available in read-only mode', isError: true };
          const p = resolvePath(args.file_path);
          if (mode === 'workspace' && !inRoots(p)) return { content: `ERROR: writes outside the workspace are not allowed (${p})`, isError: true };
          return wrap(toolWrite({ ...args, file_path: p }));
        }
        case 'Edit': {
          if (mode === 'read-only') return { content: 'ERROR: Edit is not available in read-only mode', isError: true };
          const p = resolvePath(args.file_path);
          if (mode === 'workspace' && !inRoots(p)) return { content: `ERROR: edits outside the workspace are not allowed (${p})`, isError: true };
          return wrap(toolEdit({ ...args, file_path: p }));
        }
        case 'Bash': {
          if (mode === 'read-only') return { content: 'ERROR: Bash is not available in read-only mode', isError: true };
          return wrap(await toolBash(args, cwd, { onExec: (c) => onEvent && onEvent({ type: 'bash', command: c.slice(0, 200) }) }));
        }
        default:
          return { content: `ERROR: unknown tool "${name}"`, isError: true };
      }
    } catch (e) {
      return { content: `ERROR: ${name} failed: ${e.message}`, isError: true };
    }
  }

  return {
    mode,
    defs: defsFor(mode, searchConfigured),
    execute,
    get toolCallCount() { return state.toolCalls; },
  };
}

function wrap(r) {
  if (r && r.error) return { content: `ERROR: ${r.error}`, isError: true };
  return { content: (r && r.result) || '[ok]', isError: !!(r && r.isError) };
}

function previewArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    out[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 117) + '...' : v;
  }
  return out;
}
