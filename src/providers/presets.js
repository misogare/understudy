// Known provider presets. Two adapter types:
//
//   type: 'openai' — any endpoint speaking the OpenAI chat-completions
//     protocol (DeepSeek, GLM/Zhipu, Gemini's compat endpoint, GitHub Models,
//     OpenRouter, NVIDIA NIM, Groq, Cerebras, Mistral, Ollama, LiteLLM
//     proxies, most free relays). Understudy runs the agent tool loop itself
//     (Read/Write/Edit/Glob/Grep/Bash/WebFetch as function tools).
//
//   type: 'cli' — a headless coding-agent CLI (freebuff/codebuff, gemini,
//     copilot). The CLI brings its own tools and agent loop; Understudy hands
//     it the composed prompt in the working directory and parses the output
//     (including fenced-JSON structured output).
//
//   type: 'mock' — built-in deterministic fake for keyless dry runs.
//
// A preset is activated by having its key env var set (or no key needed), or
// by declaring/overriding an entry of the same name in understudy.config.json.
// Config fields: baseUrl, apiKeyEnv (preferred) or apiKey (understudy.config
// is gitignored, but env vars are still safer), models {default, high?,
// medium?, low?} mapping agent() effort tiers to model IDs, headers?,
// effortBody? {high: {...extra request body}}, modelMap? {claudeName:
// providerModel}. CLI type: command, args (with {prompt}/{model}
// placeholders), promptVia ('arg'|'stdin'), timeoutMs.

export const PRESETS = {
  // ── OpenAI-protocol HTTP providers ────────────────────────────────────
  deepseek: {
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: { default: 'deepseek-chat', high: 'deepseek-reasoner' },
  },
  glm: {
    // Zhipu AI / bigmodel.cn (GLM family), also served by many free relays.
    type: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'ZHIPUAI_API_KEY',
    models: { default: 'glm-4.6', low: 'glm-4-flash' },
  },
  gemini: {
    // Google's official OpenAI-compatibility endpoint for the Gemini API.
    type: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    models: { default: 'gemini-2.5-flash', high: 'gemini-2.5-pro', low: 'gemini-2.5-flash-lite' },
  },
  'github-models': {
    // GitHub Models inference endpoint — free tier with a GitHub token.
    type: 'openai',
    baseUrl: 'https://models.github.ai/inference',
    apiKeyEnv: 'GITHUB_TOKEN',
    models: { default: 'openai/gpt-4.1-mini', high: 'openai/gpt-4.1' },
  },
  openrouter: {
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: { default: 'z-ai/glm-5.3-flash' },
  },
  nvidia: {
    // NVIDIA NIM / integrate.api.nvidia.com — free credits tier.
    type: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    models: { default: 'deepseek-ai/deepseek-v4-pro' },
  },
  groq: {
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    models: { default: 'llama-3.3-70b-versatile' },
  },
  cerebras: {
    type: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    models: { default: 'zai-glm-4.7' },
  },
  mistral: {
    type: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    models: { default: 'mistral-large-latest' },
  },
  litellm: {
    // A local LiteLLM proxy (model routing/fallbacks/Anthropic-name mapping).
    type: 'openai',
    baseUrl: 'http://localhost:4000/v1',
    apiKeyEnv: 'LITELLM_MASTER_KEY',
    models: { default: 'claude-3-5-sonnet-20241022' },
  },
  ollama: {
    // Local models — no key needed (placeholder satisfies the protocol).
    type: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    models: { default: 'qwen3' },
  },
  openai: {
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: { default: 'gpt-4.1-mini', high: 'gpt-4.1' },
  },

  // ── Headless agent CLIs (bring their own tools + auth) ────────────────
  freebuff: {
    // freebuff.exe (a Codebuff rebrand) — free GLM/DeepSeek tier, own login.
    // CLI shape (from the binary): freebuff [options] [prompt...] with
    // --free | --lite | --max tier flags. If `freebuff` is not on PATH,
    // point `command` at the binary (understudy init auto-detects
    // ~/.config/manicode/freebuff.exe). Verify with:
    //   understudy providers test freebuff
    type: 'cli',
    command: 'freebuff',
    staticArgs: ['--free'],
    promptArgs: ['{prompt}'],
    promptVia: 'arg',
    timeoutMs: 900000,
    models: { default: 'cli-default' },
  },
  'gemini-cli': {
    // Google's gemini CLI — works with OAuth login, no API key required.
    type: 'cli',
    command: 'gemini',
    modelArgs: ['-m', '{model}'],
    promptVia: 'stdin',
    timeoutMs: 900000,
    models: { default: 'gemini-2.5-flash', high: 'gemini-2.5-pro' },
  },
  'copilot-cli': {
    // GitHub Copilot CLI in programmatic mode. Tool auto-approval is only
    // granted under --mode full; in workspace mode the CLI's own approval
    // rules apply (it may refuse or hang until timeout — prefer --mode full
    // or an HTTP provider for unattended runs).
    type: 'cli',
    command: 'copilot',
    promptArgs: ['-p', '{prompt}'],
    fullModeArgs: ['--allow-all-tools'],
    promptVia: 'arg',
    timeoutMs: 900000,
    models: { default: 'cli-default' },
  },

  mock: {
    type: 'mock',
    models: { default: 'mock-1' },
  },
};

// Claude model names that scripts may pass via agent() opts.model.
// Mapped onto the provider's effort tiers rather than any real Claude model.
export const CLAUDE_MODEL_TIERS = {
  opus: 'high', sonnet: 'default', haiku: 'low', fable: 'high',
};
