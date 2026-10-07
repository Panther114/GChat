'use strict';

const { MODEL } = require('./config');

const REQUEST_TIMEOUT_MS = 45000;
const RETRY_DELAY_MS = 400;

function clip(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function upstreamError(payload) {
  const message = payload && typeof payload === 'object' && payload.error && typeof payload.error === 'object'
    ? clip(payload.error.message, 240)
    : '';
  return message || 'AI provider request failed';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postOnce(url, apiKey, body, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const status = response.status === 429 ? 429 : 502;
      if (response.status === 401 || response.status === 403) {
        // A rejected key is the operator's problem; users only see a generic message.
        console.warn('AI provider rejected the server key:', upstreamError(payload));
        return { ok: false, status, upstreamStatus: response.status, error: 'The AI service is not available right now', payload: null };
      }
      return { ok: false, status, upstreamStatus: response.status, error: upstreamError(payload), payload: null };
    }
    return { ok: true, status: 200, error: null, payload };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, status: 504, upstreamStatus: 0, error: 'AI request timed out', payload: null };
    }
    return { ok: false, status: 502, upstreamStatus: 0, error: 'Failed to contact the AI provider', payload: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One chat-completions call. Reasoning is switched off (fixed "low" effort),
 * sampling parameters are left to the model (MiMo ignores custom ones), and
 * the output length is capped. A transient failure (429, 5xx, timeout,
 * network) is retried once.
 */
async function callModel({ baseUrl, apiKey, messages, tools, maxTokens, fetchImpl = globalThis.fetch }) {
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model: MODEL.id,
    messages,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  let result = await postOnce(url, apiKey, body, fetchImpl);
  if (!result.ok && result.upstreamStatus === 400 && /thinking/i.test(result.error)) {
    // A gateway that rejects the thinking switch must not break chat.
    const withoutThinking = { ...body };
    delete withoutThinking.thinking;
    result = await postOnce(url, apiKey, withoutThinking, fetchImpl);
  }
  if (!result.ok && (result.status === 429 || result.status === 504 || result.upstreamStatus === 0 || result.upstreamStatus >= 500)) {
    await wait(RETRY_DELAY_MS);
    result = await postOnce(url, apiKey, body, fetchImpl);
  }
  return result;
}

function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function readUsage(payload) {
  const usage = payload && typeof payload === 'object' && payload.usage ? payload.usage : {};
  const promptTokens = count(usage.prompt_tokens);
  const completionTokens = count(usage.completion_tokens);
  const cachedTokens = Math.min(promptTokens, count(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens));
  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: Math.max(promptTokens + completionTokens, count(usage.total_tokens)),
  };
}

function estimateCostUsd(usage) {
  const uncached = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (
    (uncached / 1e6) * MODEL.inputCostPerMillion
    + (usage.cachedTokens / 1e6) * MODEL.cachedInputCostPerMillion
    + (usage.completionTokens / 1e6) * MODEL.outputCostPerMillion
  );
}

function messageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : (part && typeof part.text === 'string' ? part.text : '')))
    .join('\n')
    .trim();
}

module.exports = { callModel, readUsage, estimateCostUsd, messageText };
