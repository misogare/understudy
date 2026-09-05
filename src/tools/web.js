// WebFetch: fetch a URL and return readable text (HTML stripped) for the
// model to work with directly.
// WebSearch: available only when config.search is set (e.g. Tavily) — many
// Claude Code workflow prompts reference WebSearch, so when it is not
// configured the tool is absent and the harness prompt says so.

const FETCH_TIMEOUT_MS = 30000;
const MAX_CHARS = 50000;

export async function toolWebFetch({ url }) {
  let u;
  try { u = new URL(url); } catch { return { error: `invalid URL: ${url}` }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'only http/https URLs are supported' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(u, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'user-agent': 'understudy-cli (+https://github.com; agent-workflow-runner)' },
    });
    const type = res.headers.get('content-type') || '';
    const body = await res.text();
    const text = /html/i.test(type) ? stripHtml(body) : body;
    const clamped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + `\n…[truncated, ${text.length} chars total]` : text;
    return { result: `HTTP ${res.status} ${type}\n\n${clamped}` };
  } catch (e) {
    return { error: `fetch failed: ${e.name === 'AbortError' ? 'timeout' : e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

export function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export async function toolWebSearch({ query }, searchCfg) {
  if (!searchCfg || searchCfg.type !== 'tavily') return { error: 'WebSearch is not configured (set config.search = {type:"tavily", apiKeyEnv:"TAVILY_API_KEY"})' };
  const key = process.env[searchCfg.apiKeyEnv || 'TAVILY_API_KEY'];
  if (!key) return { error: `WebSearch key env var ${searchCfg.apiKeyEnv || 'TAVILY_API_KEY'} is not set` };
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: 8, include_answer: true }),
    });
    if (!res.ok) return { error: `search failed: HTTP ${res.status}` };
    const data = await res.json();
    const lines = [];
    if (data.answer) lines.push(`Answer: ${data.answer}\n`);
    for (const r of data.results || []) lines.push(`- ${r.title}\n  ${r.url}\n  ${String(r.content || '').slice(0, 300)}`);
    return { result: lines.join('\n') || 'No results.' };
  } catch (e) {
    return { error: `search failed: ${e.message}` };
  }
}
