'use strict';

// v1.4 Ask-AI agent tests — exercises the stateless agent relay against a
// stubbed upstream (OpenCode Zen). Tools execute client-side, so the server
// tests cover: request/response shape, tool-call relay, transcript caps,
// provider selection/fallback, quota enforcement, and per-round billing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const request = require('supertest');
const crypto = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-ai-agent-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.SESSION_SECRET = 'ai-agent-test-session-secret-at-least-32';
process.env.GROUP_CODE_PEPPER = 'ai-agent-test-group-code-pepper-32-chars';
process.env.AI_ENABLED = '1';
process.env.OPENCODE_ZEN_API_KEY = 'test-zen-key';
delete process.env.DEEPSEEK_API_KEY;
process.env.GROUP_KEY_ESCROW_MASTER_KEY = Buffer.alloc(32, 6).toString('base64url');

const { app, db, io, stmts } = require('../server');

async function csrf(agent) {
  const response = await agent.get('/api/auth/csrf').expect(200);
  return response.body.csrfToken;
}

async function register(agent, username) {
  return agent.post('/api/auth/register').send({ username, password: 'secure-password-123' }).expect(201);
}

let owner;
let group;
let token;

// Stubbed upstream — records every request body it saw.
const upstreamCalls = [];
function stubUpstream(handler) {
  global.fetch = async (url, init) => {
    upstreamCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return handler(url, init);
  };
}

function openAiJsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function upstreamAnswer(text, usageTokens = 100) {
  return openAiJsonResponse({
    id: 'resp-1',
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: text } }],
    usage: {
      prompt_tokens: usageTokens,
      completion_tokens: 50,
      total_tokens: usageTokens + 50,
    },
  });
}

function upstreamToolCall() {
  return openAiJsonResponse({
    id: 'resp-2',
    model: 'deepseek-v4-flash',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_channel_history', arguments: '{"channel":"main","limit":10}' },
        }],
      },
    }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  });
}

before(async () => {
  owner = request.agent(app);
  const ownerResponse = await register(owner, 'ai-owner-test');
  const ownerCsrf = await csrf(owner);
  const joinCode = 'airoom';
  const groupSecret = Buffer.alloc(32, 9).toString('base64url');
  const keyCommitment = crypto.createHash('sha256').update(Buffer.from(groupSecret, 'base64url')).digest('base64url');
  const createResponse = await owner
    .post('/api/groups/create')
    .set('X-CSRF-Token', ownerCsrf)
    .send({ name: 'AI room', code: joinCode, secret: groupSecret, keyCommitment })
    .expect(201);
  group = { ...createResponse.body, ownerId: ownerResponse.body.id };
  stmts.updateGroupAiEnabled.run(1, group.id);
  token = await csrf(owner);
});

after(() => {
  io.close();
  db.close();
  delete global.fetch;
});

async function postAiChat(payload) {
  return owner
    .post(`/api/groups/${group.id}/ai/chat`)
    .set('X-CSRF-Token', token)
    .send(payload);
}

test('agent answers directly when the model returns content (no tools)', async () => {
  stubUpstream(() => upstreamAnswer('42'));
  const res = await postAiChat({ prompt: 'What is 2+2?', tone: 'casual', groupName: 'AI room', channel: 'main' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'answer');
  assert.equal(res.body.answer, '42');
  assert.equal(res.body.model, 'deepseek-v4-flash');
  assert.equal(res.body.aiMeta.mode, 'agent');
  assert.equal(res.body.aiMeta.tone, 'casual');
  assert.ok(res.body.aiMeta.totalTokens > 0);
  assert.equal(res.body.aiMeta.toolCalls, 0);
  assert.equal(res.body.aiMeta.toolRounds, 0);
  assert.equal(res.body.aiUsage.currentUser.usedTokens > 0, true);

  // The round was billed.
  const usage = stmts.getUserAiUsageInWindow.get(group.ownerId, res.body.aiUsage.window.startIso, res.body.aiUsage.window.endIso);
  assert.ok(usage && usage.total_tokens > 0);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, 'https://opencode.ai/zen/go/v1/chat/completions');
  const sent = upstreamCalls[0].body;
  assert.equal(sent.model, 'deepseek-v4-flash');
  assert.equal(sent.messages[0].role, 'system');
  assert.match(sent.messages[0].content, /#main/);
  assert.equal(sent.messages[1].role, 'user');
  assert.equal(sent.messages[1].content, 'What is 2+2?');
  assert.ok(Array.isArray(sent.tools));
  assert.equal(sent.tools.length, 2);
  assert.deepEqual(sent.tools.map((t) => t.function.name), ['get_channel_history', 'get_channel_list']);
  assert.equal(sent.tool_choice, 'auto');
});

test('agent tool calls are relayed to the client for execution', async () => {
  stubUpstream(() => upstreamToolCall());
  const res = await postAiChat({ prompt: 'What did we say about the party?', tone: 'casual', groupName: 'AI room', channel: 'main' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'tool_calls');
  assert.equal(res.body.toolCalls.length, 1);
  assert.equal(res.body.toolCalls[0].id, 'call_1');
  assert.equal(res.body.toolCalls[0].name, 'get_channel_history');
  assert.deepEqual(res.body.toolCalls[0].input, { channel: 'main', limit: 10 });
  assert.equal(res.body.assistantMessage.role, 'assistant');
  assert.equal(res.body.assistantMessage.content, null);
  assert.equal(res.body.assistantMessage.tool_calls[0].function.name, 'get_channel_history');
  assert.equal(res.body.aiMeta.totalTokens > 0, true);

  // Second round: the client echoes the transcript with a tool result.
  stubUpstream(() => upstreamAnswer('You talked about snacks.'));
  const transcript = [
    { role: 'user', content: 'What did we say about the party?' },
    res.body.assistantMessage,
    { role: 'tool', tool_call_id: 'call_1', content: '{"channel":"main","messages":[{"id":"m1","content":"snacks"}]}' },
  ];
  const round2 = await postAiChat({ prompt: 'What did we say about the party?', tone: 'casual', groupName: 'AI room', channel: 'main', transcript });
  assert.equal(round2.status, 200);
  assert.equal(round2.body.status, 'answer');
  assert.equal(round2.body.answer, 'You talked about snacks.');
  const sentRound2 = upstreamCalls[upstreamCalls.length - 1].body;
  assert.equal(sentRound2.messages.length, 4); // system + user + assistant(tool_calls) + tool
  assert.equal(sentRound2.messages[3].role, 'tool');
  assert.equal(sentRound2.messages[3].tool_call_id, 'call_1');
});

test('transcript with more than the allowed tool rounds is rejected', async () => {
  stubUpstream(() => upstreamAnswer('x'));
  const transcript = [{ role: 'user', content: 'hi' }];
  for (let round = 1; round <= 5; round += 1) {
    transcript.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `call_${round}`, type: 'function', function: { name: 'get_channel_history', arguments: '{}' } }],
    });
    transcript.push({ role: 'tool', tool_call_id: `call_${round}`, content: '{}' });
  }
  const res = await postAiChat({ prompt: 'hi', tone: 'casual', groupName: 'AI room', channel: 'main', transcript });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Too many AI tool rounds');
});

test('oversized or malformed transcripts are rejected', async () => {
  stubUpstream(() => upstreamAnswer('x'));
  const tooMany = Array.from({ length: 45 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const res1 = await postAiChat({ prompt: 'hi', tone: 'casual', groupName: 'AI room', channel: 'main', transcript: tooMany });
  assert.equal(res1.status, 400);
  assert.equal(res1.body.error, 'AI transcript is too long');

  const badRole = await postAiChat({ prompt: 'hi', tone: 'casual', groupName: 'AI room', channel: 'main', transcript: [{ role: 'admin', content: 'x' }] });
  assert.equal(badRole.status, 400);
  assert.equal(badRole.body.error, 'Invalid AI transcript role');

  const noUser = await postAiChat({ prompt: 'hi', tone: 'casual', groupName: 'AI room', channel: 'main', transcript: [{ role: 'tool', tool_call_id: 'c1', content: 'x' }] });
  assert.equal(noUser.status, 400);
  assert.equal(noUser.body.error, 'AI transcript requires a user message');
});

test('fallback to the official DeepSeek API when the Zen key is missing', async () => {
  const previousZenKey = process.env.OPENCODE_ZEN_API_KEY;
  process.env.OPENCODE_ZEN_API_KEY = '';
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  stubUpstream(() => upstreamAnswer('fallback ok'));
  const res = await postAiChat({ prompt: 'hello', tone: 'casual', groupName: 'AI room', channel: 'main' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'answer');
  assert.equal(res.body.answer, 'fallback ok');
  assert.equal(upstreamCalls[upstreamCalls.length - 1].url, 'https://api.deepseek.com/chat/completions');
  process.env.OPENCODE_ZEN_API_KEY = previousZenKey;
  process.env.DEEPSEEK_API_KEY = '';
});

test('v1.4.2: a failing primary provider (HTTP error) falls through to the fallback', async () => {
  const previousZenKey = process.env.OPENCODE_ZEN_API_KEY;
  const previousDeepseekKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('opencode.ai')) {
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'invalid api key' } }),
      };
    }
    return openAiJsonResponse({
      id: 'resp-fb',
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'recovered via fallback' } }],
      usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 },
    });
  };
  const res = await postAiChat({ prompt: 'hello', tone: 'casual', groupName: 'AI room', channel: 'main' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'answer');
  assert.equal(res.body.answer, 'recovered via fallback');
  assert.equal(res.body.debug.providerLabel, 'DeepSeek');
  assert.deepEqual(calls, [
    'https://opencode.ai/zen/go/v1/chat/completions',
    'https://api.deepseek.com/chat/completions',
  ]);
  process.env.OPENCODE_ZEN_API_KEY = previousZenKey;
  process.env.DEEPSEEK_API_KEY = previousDeepseekKey;
});

test('v1.4.2: an empty primary answer falls through to the fallback', async () => {
  const previousZenKey = process.env.OPENCODE_ZEN_API_KEY;
  const previousDeepseekKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('opencode.ai')) {
      return openAiJsonResponse({
        id: 'resp-empty',
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: '' } }],
        usage: { prompt_tokens: 80, completion_tokens: 0, total_tokens: 80 },
      });
    }
    return upstreamAnswer('fallback answered');
  };
  const res = await postAiChat({ prompt: 'hello', tone: 'casual', groupName: 'AI room', channel: 'main' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'answer');
  assert.equal(res.body.answer, 'fallback answered');
  assert.equal(calls.length, 2);
  process.env.OPENCODE_ZEN_API_KEY = previousZenKey;
  process.env.DEEPSEEK_API_KEY = previousDeepseekKey;
});

test('v1.4.2: when every provider fails the round reports the failures', async () => {
  const previousZenKey = process.env.OPENCODE_ZEN_API_KEY;
  const previousDeepseekKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  global.fetch = async (url) => {
    if (String(url).includes('opencode.ai')) {
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'invalid api key' } }),
      };
    }
    return {
      ok: false,
      status: 502,
      json: async () => ({ error: { message: 'upstream exploded' } }),
    };
  };
  const res = await postAiChat({ prompt: 'hello', tone: 'casual', groupName: 'AI room', channel: 'main' });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'upstream exploded');
  assert.equal(res.body.debug.providerFailures.length, 2);
  assert.equal(res.body.debug.providerFailures[0].provider, 'OpenCode Go');
  assert.equal(res.body.debug.providerFailures[1].provider, 'DeepSeek');
  process.env.OPENCODE_ZEN_API_KEY = previousZenKey;
  process.env.DEEPSEEK_API_KEY = previousDeepseekKey;
});

test('AI chat returns 503 when no provider key is configured', async () => {
  const previousZenKey = process.env.OPENCODE_ZEN_API_KEY;
  process.env.OPENCODE_ZEN_API_KEY = '';
  process.env.DEEPSEEK_API_KEY = '';
  const res = await postAiChat({ prompt: 'hello', tone: 'casual', groupName: 'AI room', channel: 'main' });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'AI assistant is not configured on this server');
  process.env.OPENCODE_ZEN_API_KEY = previousZenKey;
});

test('AI chat is blocked when the user daily quota is exhausted', async () => {
  stubUpstream(() => upstreamAnswer('x'));
  const user = stmts.findUserById.get(group.ownerId);
  stmts.updateUser.run({
    username: null,
    iconColor: null,
    aiDailyTokenLimit: 0,
    profilePicture: null,
    hasProfilePicture: 0,
    userId: user.id,
  });
  try {
    const res = await postAiChat({ prompt: 'hello', tone: 'casual', groupName: 'AI room', channel: 'main' });
    assert.equal(res.status, 429);
    assert.match(res.body.error, /daily AI token limit/);
  } finally {
    stmts.updateUser.run({
      username: null,
      iconColor: null,
      aiDailyTokenLimit: null,
      profilePicture: null,
      hasProfilePicture: 0,
      userId: user.id,
    });
  }
});
