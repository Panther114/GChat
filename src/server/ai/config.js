'use strict';

/**
 * GChat AI runtime configuration.
 *
 * One model, one provider: MiMo-V2.6-Flash through the OpenCode Go
 * subscription. Reasoning is fixed to "low": MiMo exposes only an on/off
 * thinking switch (no effort levels), so low means thinking off. Nothing here
 * is user-selectable.
 */

const MODEL = Object.freeze({
  id: 'mimo-v2.6-flash',
  label: 'MiMo V2.6 Flash',
  // OpenCode Go list price, USD per 1M tokens.
  inputCostPerMillion: 0.14,
  outputCostPerMillion: 0.28,
  cachedInputCostPerMillion: 0.0028,
});

const REASONING_EFFORT = 'low';

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';

const PROFILE_MAX_CHARS = 200;

const DEFAULT_MAX_OUTPUT_TOKENS = 1500;
const MIN_MAX_OUTPUT_TOKENS = 256;
const MAX_MAX_OUTPUT_TOKENS = 4000;

// Daily web-search budgets (per user / whole server). The free search tiers are
// small, so these are deliberately conservative and overridable from the env.
const DEFAULT_SEARCH_USER_DAILY_LIMIT = 25;
const DEFAULT_SEARCH_GLOBAL_DAILY_LIMIT = 120;
const MAX_SEARCHES_PER_REQUEST = 3;

function readInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readAiConfig(env = process.env) {
  const trim = (value) => (typeof value === 'string' ? value.trim() : '');
  const baseUrl = (trim(env.OPENCODE_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    model: MODEL,
    effort: REASONING_EFFORT,
    baseUrl,
    // The env var keeps its original name so existing Railway configs work.
    apiKey: trim(env.OPENCODE_ZEN_API_KEY) || trim(env.OPENCODE_API_KEY),
    maxOutputTokens: readInt(env.AI_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, MIN_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS),
    search: {
      langsearchKey: trim(env.LANGSEARCH_API_KEY),
      langsearchBaseUrl: (trim(env.LANGSEARCH_BASE_URL) || 'https://api.langsearch.com').replace(/\/+$/, ''),
      tavilyKey: trim(env.TAVILY_API_KEY),
      tavilyBaseUrl: (trim(env.TAVILY_BASE_URL) || 'https://api.tavily.com').replace(/\/+$/, ''),
      userDailyLimit: readInt(env.AI_SEARCH_USER_DAILY_LIMIT, DEFAULT_SEARCH_USER_DAILY_LIMIT, 0, 1000),
      globalDailyLimit: readInt(env.AI_SEARCH_GLOBAL_DAILY_LIMIT, DEFAULT_SEARCH_GLOBAL_DAILY_LIMIT, 0, 100000),
      perRequestLimit: MAX_SEARCHES_PER_REQUEST,
    },
  };
}

module.exports = {
  MODEL,
  REASONING_EFFORT,
  PROFILE_MAX_CHARS,
  MAX_SEARCHES_PER_REQUEST,
  readAiConfig,
};
