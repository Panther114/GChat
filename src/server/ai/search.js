'use strict';

/**
 * Free web search for the assistant.
 *
 * LangSearch is the primary provider (free API key, no card). Tavily's free
 * plan is an optional second provider. Either key enables the tool; with no
 * key the assistant simply has no search tool.
 *
 * Search queries are the only thing that leaves GChat's encrypted channel, and
 * only when the model decides it needs the web.
 */

const SEARCH_TIMEOUT_MS = 8000;
const MAX_QUERY_CHARS = 200;
const RESULT_COUNT = 5;
const MAX_TITLE_CHARS = 120;
const MAX_SNIPPET_CHARS = 320;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;

const cache = new Map();

function clean(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function normalizeResults(items) {
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    const url = clean(item?.url, 300);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = clean(item?.name ?? item?.title, MAX_TITLE_CHARS);
    const snippet = clean(item?.snippet ?? item?.content ?? item?.summary, MAX_SNIPPET_CHARS);
    if (!title && !snippet) continue;
    results.push({ title: title || url, url, snippet });
    if (results.length >= RESULT_COUNT) break;
  }
  return results;
}

async function postJson(url, key, body, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) return { ok: false, status: response.status };
    return { ok: true, payload };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function viaLangSearch(query, search, fetchImpl) {
  const res = await postJson(`${search.langsearchBaseUrl}/v1/web-search`, search.langsearchKey, { query, count: RESULT_COUNT }, fetchImpl);
  if (!res.ok) return null;
  return normalizeResults(res.payload?.data?.webPages?.value);
}

async function viaTavily(query, search, fetchImpl) {
  const res = await postJson(`${search.tavilyBaseUrl}/search`, search.tavilyKey, { query, max_results: RESULT_COUNT, search_depth: 'basic' }, fetchImpl);
  if (!res.ok) return null;
  return normalizeResults(res.payload?.results);
}

function isSearchConfigured(search) {
  return !!(search && (search.langsearchKey || search.tavilyKey));
}

function normalizeQuery(value) {
  return clean(value, MAX_QUERY_CHARS);
}

/** Returns { ok, results, cached } or { ok: false, error }. Never throws. */
async function runWebSearch(rawQuery, search, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const query = normalizeQuery(rawQuery);
  if (!query) return { ok: false, error: 'Empty search query' };
  if (!isSearchConfigured(search)) return { ok: false, error: 'Web search is not configured' };

  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return { ok: true, results: hit.results, cached: true };

  let results = null;
  if (search.langsearchKey) results = await viaLangSearch(query, search, fetchImpl);
  if (results == null && search.tavilyKey) results = await viaTavily(query, search, fetchImpl);
  if (results == null) return { ok: false, error: 'Web search is temporarily unavailable' };

  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { at: now, results });
  return { ok: true, results, cached: false };
}

function clearSearchCache() {
  cache.clear();
}

module.exports = { isSearchConfigured, normalizeQuery, runWebSearch, clearSearchCache, MAX_QUERY_CHARS };
