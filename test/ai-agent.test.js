'use strict';

// GChat AI backend tests — MiMo V2.6 Flash through OpenCode Go, fixed low
// reasoning effort, free web search and the per-user model profile. Upstream
// providers are stubbed; history tools execute in the browser, so these cover
// the request shape, tool relay, search budgets, transcript caps and billing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, test } = require('node:test');
const request = require('supertest');
const crypto = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-ai-agent-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.SESSION_SECRET = 'ai-agent-test-session-secret-at-least-32';
process.env.GROUP_CODE_PEPPER = 'ai-agent-test-group-code-pepper-32-chars';
process.env.NODE_ENV = 'test';
process.env.AI_ENABLED = '1';
process.env.OPENCODE_ZEN_API_KEY = 'test-opencode-key';
delete process.env.LANGSEARCH_API_KEY;
delete process.env.TAVILY_API_KEY;
delete process.env.AI_SEARCH_USER_DAILY_LIMIT;
delete process.env.AI_SEARCH_GLOBAL_DAILY_LIMIT;
process.env.GROUP_KEY_ESCROW_MASTER_KEY = Buffer.alloc(32, 6).toString('base64url');

const { app, db, io, stmts } = require('../server');
const { clearSearchCache } = require('../src/server/ai/search');

const OPENCODE_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
const LANGSEARCH_URL = 'https://api.langsearch.com/v1/web-search';
const TAVILY_URL = 'https://api.tavily.com/search';

async function csrf(agent) {
  const response = await agent.get('/api/auth/csrf').expect(200);
  return response.body.csrfToken;
}

let owner;
let group;
let token;

// Every upstream request the stubs saw: { url, body }.
let upstreamCalls = [];
function stubFetch(handler) {
  global.fetch = async (url, init) => {
    const call = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
    upstreamCalls.push(call);
    return handler(call);
  };
}

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function answer(text, { prompt = 100, completion = 50 } = {}) {
  return jsonResponse({
    id: 'resp-1',
    model: 'mimo-v2.6-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  });
}

function toolCalls(calls, usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }) {
  return jsonResponse({
    id: 'resp-tools',
    model: 'mimo-v2.6-flash',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })),
      },
    }],
    usage,
  });
}

const searchHit = () => jsonResponse({
  code: 200,
  data: { webPages: { value: [
    { url: 'https://example.com/a', name: 'Example A', snippet: 'First result about the thing.' },
    { url: 'https://example.org/b', name: 'Example B', snippet: 'Second result.' },
    { url: 'javascript:alert(1)', name: 'Bad scheme', snippet: 'dropped' },
  ] } },
});

before(async () => {
  owner = request.agent(app);
  const registered = await owner.post('/api/auth/register').send({ username: 'ai-owner-test', password: 'secure-password-123' }).expect(201);
  const ownerCsrf = await csrf(owner);
  const groupSecret = Buffer.alloc(32, 9).toString('base64url');
  const keyCommitment = crypto.createHash('sha256').update(Buffer.from(groupSecret, 'base64url')).digest('base64url');
  const created = await owner
    .post('/api/groups/create')
    .set('X-CSRF-Token', ownerCsrf)
    .send({ name: 'AI room', code: 'airoom', secret: groupSecret, keyCommitment })
    .expect(201);
  group = { ...created.body, ownerId: registered.body.id };
  stmts.updateGroupAiEnabled.run(1, group.id);
  token = await csrf(owner);
});

beforeEach(() => {
  upstreamCalls = [];
  clearSearchCache();
  process.env.OPENCODE_ZEN_API_KEY = 'test-opencode-key';
  delete process.env.LANGSEARCH_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.AI_SEARCH_USER_DAILY_LIMIT;
  delete process.env.AI_SEARCH_GLOBAL_DAILY_LIMIT;
  stmts.setUserAiProfile.run(null, group.ownerId);
});

after(() => {
  io.close();
  db.close();
  delete global.fetch;
});

const post = (payload) => owner.post(`/api/groups/${group.id}/ai/chat`).set('X-CSRF-Token', token).send(payload);
const ask = (prompt, extra = {}) => post({ prompt, groupName: 'AI room', channel: 'main', ...extra });
const putProfile = (profile) => owner.put('/api/ai/profile').set('X-CSRF-Token', token).send({ profile });

test('answers directly with MiMo V2.6 Flash, thinking off, a reply cap and no sampling overrides', async () => {
  stubFetch(() => answer('42'));
  const res = await ask('What is 2+2?');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'answer');
  assert.equal(res.body.answer, '42');
  assert.equal(res.body.model, 'mimo-v2.6-flash');
  assert.equal(res.body.aiMeta.model, 'mimo-v2.6-flash');
  assert.equal(res.body.aiMeta.totalTokens, 150);
  assert.equal(res.body.aiMeta.webSearchRequests, 0);
  assert.ok(res.body.aiMeta.estimatedCostUsd > 0);
  assert.equal('tone' in res.body.aiMeta, false);

  assert.equal(upstreamCalls.length, 1);
  const call = upstreamCalls[0];
  assert.equal(call.url, OPENCODE_URL);
  assert.equal(call.headers.Authorization, 'Bearer test-opencode-key');
  assert.equal(call.body.model, 'mimo-v2.6-flash');
  assert.deepEqual(call.body.thinking, { type: 'disabled' });
  assert.equal(call.body.max_tokens, 1500);
  for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) {
    assert.equal(key in call.body, false, `${key} must not be sent`);
  }
  assert.equal(call.body.messages[0].role, 'system');
  assert.match(call.body.messages[0].content, /#main/);
  assert.match(call.body.messages[0].content, /no web access/i);
  assert.deepEqual(call.body.tools.map((t) => t.function.name), ['get_channel_history', 'get_channel_list']);

  const usage = stmts.getUserAiUsageInWindow.get(group.ownerId, res.body.aiUsage.window.startIso, res.body.aiUsage.window.endIso);
  assert.ok(usage.total_tokens >= 150);
});

test('the reply cap can be tuned from the environment within bounds', async () => {
  process.env.AI_MAX_OUTPUT_TOKENS = '999999';
  stubFetch(() => answer('ok'));
  await ask('hi');
  delete process.env.AI_MAX_OUTPUT_TOKENS;
  assert.equal(upstreamCalls[0].body.max_tokens, 4000);
});

test('history tool calls are relayed to the browser and the follow-up round completes', async () => {
  stubFetch(() => toolCalls([['call_1', 'get_channel_history', { channel: 'main', limit: 10 }]]));
  const first = await ask('What did we say about the party?');
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'tool_calls');
  assert.deepEqual(first.body.toolCalls, [{ id: 'call_1', name: 'get_channel_history', input: { channel: 'main', limit: 10 } }]);
  assert.equal(first.body.transcriptAdditions.length, 1);
  assert.equal(first.body.transcriptAdditions[0].role, 'assistant');
  assert.equal(first.body.transcriptAdditions[0].tool_calls[0].function.name, 'get_channel_history');

  stubFetch(() => answer('You talked about snacks.'));
  const transcript = [
    { role: 'user', content: 'What did we say about the party?' },
    ...first.body.transcriptAdditions,
    { role: 'tool', tool_call_id: 'call_1', content: '{"messages":[{"content":"snacks"}]}' },
  ];
  const second = await ask('What did we say about the party?', { transcript });
  assert.equal(second.body.status, 'answer');
  assert.equal(second.body.answer, 'You talked about snacks.');
  const sent = upstreamCalls[upstreamCalls.length - 1].body.messages;
  assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(sent[3].tool_call_id, 'call_1');
});

test('web search is offered only when a free search key is configured, and runs on the server', async () => {
  process.env.LANGSEARCH_API_KEY = 'ls-key';
  const upstreamBodies = [];
  stubFetch((call) => {
    if (call.url === LANGSEARCH_URL) return searchHit();
    upstreamBodies.push(call.body);
    return upstreamBodies.length === 1
      ? toolCalls([['s1', 'web_search', { query: 'latest node lts version' }]])
      : answer('Node 24 is the current LTS.\nSources: https://example.com/a');
  });

  const res = await ask('What is the latest Node LTS?');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'answer');
  assert.match(res.body.answer, /Node 24/);
  assert.equal(res.body.aiMeta.webSearchRequests, 1);
  assert.equal(res.body.aiMeta.totalTokens, 150 + 150);

  assert.deepEqual(upstreamBodies[0].tools.map((t) => t.function.name), ['get_channel_history', 'get_channel_list', 'web_search']);
  assert.match(upstreamBodies[0].messages[0].content, /web_search/);
  const searchCall = upstreamCalls.find((c) => c.url === LANGSEARCH_URL);
  assert.equal(searchCall.body.query, 'latest node lts version');
  assert.equal(searchCall.headers.Authorization, 'Bearer ls-key');

  const toolMessage = upstreamBodies[1].messages.find((m) => m.role === 'tool');
  const parsed = JSON.parse(toolMessage.content);
  assert.equal(parsed.results.length, 2, 'non-http(s) results are dropped');
  assert.match(parsed.note, /untrusted/i);

  const used = stmts.countUserAiSearchesInWindow.get(group.ownerId, '1970-01-01', '9999-01-01');
  assert.ok(used.count >= 1);
});

test('identical searches are served from the cache and do not spend the budget twice', async () => {
  process.env.LANGSEARCH_API_KEY = 'ls-key';
  let searches = 0;
  stubFetch((call) => {
    if (call.url === LANGSEARCH_URL) { searches += 1; return searchHit(); }
    const hasToolResult = call.body.messages.some((m) => m.role === 'tool');
    return hasToolResult ? answer('done') : toolCalls([['s1', 'web_search', { query: 'Cache Me' }]]);
  });
  const before = stmts.countUserAiSearchesInWindow.get(group.ownerId, '1970-01-01', '9999-01-01').count;
  await ask('first');
  await ask('second');
  assert.equal(searches, 1);
  const after = stmts.countUserAiSearchesInWindow.get(group.ownerId, '1970-01-01', '9999-01-01').count;
  assert.equal(after - before, 2, 'each attempt that reaches the search layer is counted');
});

test('a mixed round runs the search on the server and relays only the history call', async () => {
  process.env.LANGSEARCH_API_KEY = 'ls-key';
  stubFetch((call) => (call.url === LANGSEARCH_URL
    ? searchHit()
    : toolCalls([['s1', 'web_search', { query: 'weather' }], ['h1', 'get_channel_history', {}]])));
  const res = await ask('compare the chat with the weather');
  assert.equal(res.body.status, 'tool_calls');
  assert.deepEqual(res.body.toolCalls.map((c) => c.name), ['get_channel_history']);
  assert.deepEqual(res.body.transcriptAdditions.map((m) => m.role), ['assistant', 'tool']);
  assert.equal(res.body.transcriptAdditions[1].tool_call_id, 's1');
  assert.equal(res.body.aiMeta.webSearchRequests, 1);
});

test('a failing search provider becomes a tool error and the model still answers', async () => {
  process.env.LANGSEARCH_API_KEY = 'ls-key';
  stubFetch((call) => {
    if (call.url === LANGSEARCH_URL) return jsonResponse({}, 500);
    const toolMessage = call.body.messages.find((m) => m.role === 'tool');
    return toolMessage ? answer(`could not verify: ${JSON.parse(toolMessage.content).error}`) : toolCalls([['s1', 'web_search', { query: 'x y z' }]]);
  });
  const res = await ask('news?');
  assert.equal(res.body.status, 'answer');
  assert.match(res.body.answer, /temporarily unavailable/);
});

test('Tavily backs up LangSearch when both keys are set', async () => {
  process.env.LANGSEARCH_API_KEY = 'ls-key';
  process.env.TAVILY_API_KEY = 'tv-key';
  stubFetch((call) => {
    if (call.url === LANGSEARCH_URL) return jsonResponse({}, 429);
    if (call.url === TAVILY_URL) return jsonResponse({ results: [{ url: 'https://example.net/t', title: 'Tavily result', content: 'From Tavily.' }] });
    const toolMessage = call.body.messages.find((m) => m.role === 'tool');
    return toolMessage ? answer(JSON.parse(toolMessage.content).results[0].title) : toolCalls([['s1', 'web_search', { query: 'fallback test' }]]);
  });
  const res = await ask('anything');
  assert.equal(res.body.answer, 'Tavily result');
});

test('search is withheld once the daily budget is spent', async () => {
  process.env.LANGSEARCH_API_KEY = 'ls-key';
  process.env.AI_SEARCH_USER_DAILY_LIMIT = '0';
  stubFetch(() => answer('no search for you'));
  await ask('anything');
  assert.deepEqual(upstreamCalls[0].body.tools.map((t) => t.function.name), ['get_channel_history', 'get_channel_list']);
  assert.match(upstreamCalls[0].body.messages[0].content, /no web access/i);
});

test('at most three searches run per request and the model is then forced to answer', async () => {
  process.env.LANGSEARCH_API_KEY = 'ls-key';
  let model = 0;
  stubFetch((call) => {
    if (call.url === LANGSEARCH_URL) return searchHit();
    model += 1;
    if (model <= 2) return toolCalls([[`a${model}`, 'web_search', { query: `q${model} a` }], [`b${model}`, 'web_search', { query: `q${model} b` }]]);
    return answer('final');
  });
  const res = await ask('research this');
  assert.equal(res.body.status, 'answer');
  assert.equal(res.body.aiMeta.webSearchRequests, 3);
  assert.equal(upstreamCalls.filter((c) => c.url === OPENCODE_URL).length, 3);
  const lastModelCall = upstreamCalls.filter((c) => c.url === OPENCODE_URL).pop();
  assert.equal('tools' in lastModelCall.body, false, 'the last call has no tools, so the model has to answer');
});

test('the saved model profile reaches the system prompt, and only for its owner', async () => {
  const saved = await putProfile('Answer in two short lines.\n\nNo emoji.');
  assert.equal(saved.status, 200);
  assert.equal(saved.body.profile.text, 'Answer in two short lines. No emoji.');
  assert.equal(saved.body.profile.maxChars, 200);

  stubFetch(() => answer('ok'));
  await ask('hello');
  assert.match(upstreamCalls[0].body.messages[0].content, /Answer in two short lines\. No emoji\./);

  const cleared = await putProfile('   ');
  assert.equal(cleared.body.profile.text, '');
  await ask('hello again');
  assert.doesNotMatch(upstreamCalls[1].body.messages[0].content, /preference/i);
});

test('profiles over 200 characters or of the wrong type are rejected', async () => {
  const tooLong = await putProfile('x'.repeat(201));
  assert.equal(tooLong.status, 400);
  const exact = await putProfile('y'.repeat(200));
  assert.equal(exact.status, 200);
  const wrongType = await owner.put('/api/ai/profile').set('X-CSRF-Token', token).send({ profile: { a: 1 } });
  assert.equal(wrongType.status, 400);
});

test('the config endpoint exposes the fixed model, effort, caps and search status', async () => {
  process.env.LANGSEARCH_API_KEY = 'ls-key';
  const res = await owner.get('/api/ai/config').expect(200);
  assert.equal(res.body.model.id, 'mimo-v2.6-flash');
  assert.equal(res.body.model.label, 'MiMo V2.6 Flash');
  assert.equal(res.body.effort, 'low');
  assert.equal(res.body.replyTokenCap, 1500);
  assert.equal(res.body.webSearch.available, true);
  assert.equal(res.body.webSearch.dailyLimit, 25);
  assert.ok(res.body.usage.currentUser.dailyLimit > 0);
  assert.equal(res.body.profile.maxChars, 200);
  await owner.get('/api/ai/tones').expect(404);
});

test('a gateway that rejects the thinking switch is retried without it', async () => {
  let attempts = 0;
  stubFetch((call) => {
    attempts += 1;
    if ('thinking' in call.body) return jsonResponse({ error: { message: 'Unknown parameter: thinking' } }, 400);
    return answer('works anyway');
  });
  const res = await ask('hi');
  assert.equal(res.body.answer, 'works anyway');
  assert.equal(attempts, 2);
});

test('a transient upstream failure is retried once', async () => {
  let attempts = 0;
  stubFetch(() => {
    attempts += 1;
    return attempts === 1 ? jsonResponse({ error: { message: 'busy' } }, 502) : answer('second time lucky');
  });
  const res = await ask('hi');
  assert.equal(res.body.answer, 'second time lucky');
});

test('provider errors surface as errors and an empty answer is not posted', async () => {
  stubFetch(() => jsonResponse({ error: { message: 'invalid api key' } }, 401));
  const failed = await ask('hi');
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, 'The AI service is not available right now');

  stubFetch(() => answer(''));
  const empty = await ask('hi');
  assert.equal(empty.status, 502);
  assert.equal(empty.body.error, 'AI returned an empty response');
});

test('AI chat returns 503 when the OpenCode key is not configured', async () => {
  process.env.OPENCODE_ZEN_API_KEY = '';
  const res = await ask('hello');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'AI assistant is not configured on this server');
});

test('transcripts with too many tool rounds, too many messages or bad roles are rejected', async () => {
  stubFetch(() => answer('x'));
  const transcript = [{ role: 'user', content: 'hi' }];
  for (let round = 1; round <= 13; round += 1) {
    transcript.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${round}`, type: 'function', function: { name: 'get_channel_history', arguments: '{}' } }] });
    transcript.push({ role: 'tool', tool_call_id: `c${round}`, content: '{}' });
  }
  const rounds = await ask('hi', { transcript });
  assert.equal(rounds.body.error, 'Too many AI tool rounds');

  const tooMany = Array.from({ length: 45 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  assert.equal((await ask('hi', { transcript: tooMany })).body.error, 'AI transcript is too long');
  assert.equal((await ask('hi', { transcript: [{ role: 'admin', content: 'x' }] })).body.error, 'Invalid AI transcript role');
  assert.equal((await ask('hi', { transcript: [{ role: 'tool', tool_call_id: 'c1', content: 'x' }] })).body.error, 'AI transcript requires a user message');
});

test('AI chat is blocked when the user daily token quota is exhausted', async () => {
  stubFetch(() => answer('x'));
  const user = stmts.findUserById.get(group.ownerId);
  const update = (limit) => stmts.updateUser.run({
    username: null, iconColor: null, aiDailyTokenLimit: limit, profilePicture: null, hasProfilePicture: 0, userId: user.id,
  });
  update(0);
  try {
    const res = await ask('hello');
    assert.equal(res.status, 429);
    assert.match(res.body.error, /daily AI token limit/);
    assert.equal(upstreamCalls.length, 0);
  } finally {
    update(null);
  }
});
