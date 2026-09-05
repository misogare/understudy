// Provider registry: merges config-declared providers over built-in presets,
// resolves the active provider + model tiers, and hands back a live client.

import { PRESETS, CLAUDE_MODEL_TIERS } from './presets.js';
import { makeOpenAIProvider, ProviderError } from './openai.js';
import { makeMockProvider } from './mock.js';
import { makeCliProvider } from './cli.js';

export { ProviderError };

export function listProviders(config) {
  const merged = { ...PRESETS, ...(config.providers || {}) };
  return Object.keys(merged).map((name) => {
    const c = { ...PRESETS[name], ...(config.providers || {})[name], name };
    const type = c.type || 'openai';
    const ready =
      type === 'mock' ||
      (type === 'cli' && !!c.command) ||
      (type === 'openai' && (!!c.apiKey || !!(c.apiKeyEnv && process.env[c.apiKeyEnv])));
    return {
      name,
      type,
      target: type === 'cli' ? c.command : c.baseUrl || null,
      apiKeyEnv: c.apiKeyEnv || null,
      ready,
      models: c.models || {},
      declaredInConfig: !!(config.providers || {})[name],
    };
  });
}

export function resolveProvider(config, nameOverride = null) {
  const name = nameOverride || config.defaultProvider || 'mock';
  const declared = (config.providers || {})[name];
  const preset = PRESETS[name];
  if (!declared && !preset) {
    throw new ProviderError(
      `unknown provider "${name}" — declare it in understudy.config.json or use one of: ${Object.keys({ ...PRESETS, ...(config.providers || {}) }).sort().join(', ')}`,
      { terminal: true },
    );
  }
  const cfg = { ...preset, ...declared, name };
  const type = cfg.type || 'openai';
  const client =
    type === 'mock' ? makeMockProvider(cfg)
      : type === 'cli' ? makeCliProvider(cfg)
        : makeOpenAIProvider(cfg);

  const models = cfg.models || {};
  const modelMap = cfg.modelMap || {};
  const effortBody = cfg.effortBody || {};

  return {
    name,
    type,
    cfg,
    client,
    // Resolve the model for one agent() call: explicit opts.model wins (with
    // Claude-name translation), then the effort tier, then default.
    modelFor({ model = null, effort = null } = {}) {
      if (model) {
        if (modelMap[model]) return modelMap[model];
        const claudeTier = CLAUDE_MODEL_TIERS[String(model).toLowerCase().replace(/^claude-/, '').split('-')[0]];
        if (claudeTier) return models[claudeTier] || models.default;
        if (/claude/i.test(model)) return models.high || models.default;
        return model; // assume it's a native model id on this provider
      }
      if (effort && models[effort]) return models[effort];
      if (effort === 'xhigh' || effort === 'max') return models.high || models.default;
      return models.default;
    },
    extraBodyFor(effort) {
      return effortBody[effort] || null;
    },
  };
}
