// The single HTTP adapter: OpenAI chat-completions protocol.
// Covers DeepSeek, GLM/Zhipu, Gemini (openai-compat endpoint), GitHub Models,
// OpenRouter, Ollama, OpenAI itself, and any aggregator/relay that follows
// the protocol.

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class ProviderError extends Error {
  constructor(message, { status = null, terminal = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.terminal = terminal;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function makeOpenAIProvider(cfg) {
  const baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new ProviderError(`provider "${cfg.name}" has no baseUrl`, { terminal: true });
  const apiKey = cfg.apiKey || (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : null);
  if (!apiKey) {
    throw new ProviderError(
      `provider "${cfg.name}" has no API key — set the ${cfg.apiKeyEnv || 'apiKey'} environment variable`,
      { terminal: true },
    );
  }

  return {
    name: cfg.name,
    type: 'openai',
    async chat({ model, messages, tools, temperature, maxTokens, extraBody, signal }) {
      const body = {
        model,
        messages,
        ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
        ...(temperature != null ? { temperature } : {}),
        ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
        ...(extraBody || {}),
      };
      const headers = {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(cfg.headers || {}),
      };

      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(attempt === 1 ? 1500 : 6000);
        let res;
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST', headers, body: JSON.stringify(body), signal,
          });
        } catch (e) {
          if (e.name === 'AbortError') throw new ProviderError('request aborted', { terminal: true });
          lastErr = new ProviderError(`network error calling ${cfg.name}: ${e.message}`);
          continue;
        }
        if (!res.ok) {
          const text = (await res.text().catch(() => '')).slice(0, 500);
          const err = new ProviderError(`${cfg.name} HTTP ${res.status}: ${text}`, {
            status: res.status, terminal: !RETRYABLE.has(res.status),
          });
          if (err.terminal) throw err;
          lastErr = err;
          const retryAfter = Number(res.headers.get('retry-after'));
          if (retryAfter > 0 && retryAfter <= 120) await sleep(retryAfter * 1000);
          continue;
        }
        const data = await res.json().catch(() => null);
        if (!data || !Array.isArray(data.choices) || !data.choices[0]) {
          lastErr = new ProviderError(`${cfg.name} returned an unparseable response`);
          continue;
        }
        return normalize(data);
      }
      lastErr = lastErr || new ProviderError(`${cfg.name}: exhausted retries`);
      lastErr.terminal = true;
      throw lastErr;
    },
  };
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  return String(content);
}

function normalize(data) {
  const choice = data.choices[0];
  const msg = choice.message || {};
  const toolCalls = (msg.tool_calls || [])
    .filter((tc) => tc && tc.function)
    .map((tc) => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      name: tc.function.name,
      // Some providers return arguments as an object instead of a string.
      args: typeof tc.function.arguments === 'string'
        ? tc.function.arguments
        : JSON.stringify(tc.function.arguments ?? {}),
    }));
  return {
    text: contentToText(msg.content),
    reasoning: msg.reasoning_content || null, // DeepSeek R1-style field, informational only
    toolCalls,
    finishReason: choice.finish_reason || null,
    usage: {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    },
    assistantMessage: msg, // pushed back verbatim so tool_call ids stay consistent
  };
}
