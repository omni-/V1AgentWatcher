import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  inspectSupervisionUsage,
  inspectThreadUsage,
} from '../mcp/usage.mjs';

function sessionMeta(id, overrides = {}) {
  return {
    id,
    cwd: 'C:\\repo',
    model_provider: 'openai',
    source: 'vscode',
    ...overrides,
  };
}

function childMeta(id, parentThreadId, overrides = {}) {
  const role = overrides.agent_role ?? 'qwen';
  return sessionMeta(id, {
    parent_thread_id: parentThreadId,
    model_provider: 'lmstudio',
    agent_nickname: role === 'watchdog' ? 'Luna' : 'Qwen',
    agent_role: role,
    multi_agent_version: 'v1',
    source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, depth: 1, agent_role: role } } },
    ...overrides,
  });
}

function usage(input, cached, output, reasoning, overrides = {}) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: overrides.cacheWrite ?? 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: overrides.total ?? input + output,
  };
}

function token(total, timestamp = '2026-08-20T08:00:01Z', last = total) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 },
      rate_limits: null,
    },
  };
}

function turnStarted(turnId, timestamp = '2026-08-20T08:00:00Z') {
  return { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } };
}

function turnComplete(turnId, timestamp = '2026-08-20T08:00:09Z') {
  return { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } };
}

function spawnEvent(turnId, ...childIds) {
  return {
    timestamp: '2026-08-20T08:00:05Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'parent',
      turn_id: turnId,
      item: { type: 'CollabAgentToolCall', tool: 'spawn_agent', receiver_thread_ids: childIds },
    },
  };
}

function turnContext(turnId, model) {
  return { type: 'turn_context', payload: { turn_id: turnId, model } };
}

async function temporaryCodexHome(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v1-usage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function makeRollout(root, id, meta, records = [], options = {}) {
  const directory = path.join(root, 'sessions', '2026', '08', '20');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-08-20T08-00-00-${id}.jsonl`);
  const all = [
    { timestamp: '2026-08-20T08:00:00Z', type: 'session_meta', payload: meta },
    ...records,
  ];
  let text = `${all.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n')}\n`;
  if (options.trailingText) text += options.trailingText;
  await fs.writeFile(file, text, 'utf8');
  return file;
}

test('uses the latest cumulative token_count snapshot without summing snapshots', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'root', sessionMeta('root'), [
    token(usage(100, 20, 10, 4)),
    token(usage(200, 80, 20, 7)),
  ]);
  const result = await inspectThreadUsage({ codexHome: root, threadId: 'root' });
  assert.equal(result.cumulative.input_tokens, 200);
  assert.equal(result.cumulative.raw_total_tokens, 220);
  assert.equal(result.accounting_events, 2);
  assert.equal(result.accounting_source, 'latest_cumulative_token_count');
});

test('extracts raw and effective fields without double-counting cache or reasoning', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'root', sessionMeta('root'), [token(usage(100, 40, 30, 20, { cacheWrite: 5 }))]);
  const result = await inspectThreadUsage({ codexHome: root, threadId: 'root' });
  assert.deepEqual(result.cumulative, {
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 5,
    non_cached_input_tokens: 60,
    output_tokens: 30,
    reasoning_output_tokens: 20,
    raw_total_tokens: 130,
    effective_tokens: 90,
  });
  assert.notEqual(result.cumulative.effective_tokens, 150);
  assert.notEqual(result.cumulative.effective_tokens, 110);
});

test('root threads need no parent and report zero-token accounting as available', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'solo', sessionMeta('solo'), [token(usage(0, 0, 0, 0))]);
  const result = await inspectThreadUsage({ codexHome: root, threadId: 'solo' });
  assert.equal(result.parent_thread, null);
  assert.equal(result.usage_available, true);
  assert.equal(result.usage_completeness, 'complete');
  assert.equal(result.cumulative.effective_tokens, 0);
});

test('exact thread lookup bypasses bounded recent-session scanning', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'target', sessionMeta('target'), [token(usage(12, 2, 3, 1))]);
  await makeRollout(root, 'other', sessionMeta('other'), [token(usage(999, 0, 99, 9))]);
  const result = await inspectThreadUsage({ codexHome: root, threadId: 'target', maxFiles: 1 });
  assert.equal(result.thread, 'target');
  assert.equal(result.cumulative.effective_tokens, 13);
});

test('parent benchmark delta excludes previous and later turns and uses exact worker spawn', async (t) => {
  const root = await temporaryCodexHome(t);
  const prior = usage(100, 20, 10, 4);
  const benchmarkEnd = usage(300, 100, 30, 10);
  const lifetime = usage(500, 150, 50, 12);
  await makeRollout(root, 'parent', sessionMeta('parent'), [
    turnStarted('turn-a'), token(prior), turnComplete('turn-a'),
    turnStarted('turn-b'), turnContext('turn-b', 'gpt-5.6-sol'), spawnEvent('turn-b', 'worker', 'watchdog'),
    token(benchmarkEnd), turnComplete('turn-b'),
    turnStarted('turn-c'), token(lifetime), turnComplete('turn-c'),
  ]);
  await makeRollout(root, 'worker', childMeta('worker', 'parent'), [token(usage(1000, 400, 100, 80))]);
  await makeRollout(root, 'watchdog', childMeta('watchdog', 'parent', {
    model_provider: 'openai', agent_role: 'watchdog', agent_nickname: 'Luna',
  }), [turnContext('watch-turn', 'gpt-5.6-luna'), token(usage(200, 150, 20, 5))]);
  await makeRollout(root, 'unrelated', sessionMeta('unrelated'), [token(usage(999999, 0, 999, 999))]);

  const result = await inspectSupervisionUsage({ codexHome: root, workerThreadId: 'worker' });
  assert.equal(result.parent.thread, 'parent');
  assert.equal(result.parent.benchmark_turn.turn_id, 'turn-b');
  assert.equal(result.parent.benchmark_turn.input_tokens, 200);
  assert.equal(result.parent.benchmark_turn.cached_input_tokens, 80);
  assert.equal(result.parent.benchmark_turn.non_cached_input_tokens, 120);
  assert.equal(result.parent.benchmark_turn.output_tokens, 20);
  assert.equal(result.parent.benchmark_turn.reasoning_output_tokens, 6);
  assert.equal(result.parent.benchmark_turn.raw_total_tokens, 220);
  assert.equal(result.parent.benchmark_turn.effective_tokens, 140);
  assert.equal(result.parent.lifetime.effective_tokens, 400);
  assert.equal(result.watchdog.thread, 'watchdog');
  assert.equal(result.watchdog.lifetime.effective_tokens, 70);
  assert.equal(result.worker.lifetime.effective_tokens, 700);
  assert.equal(result.combined.hosted_effective_tokens, 210);
  assert.equal(result.combined.local_effective_tokens, 700);
  assert.equal(result.parent.benchmark_turn.boundary.final_response_accounting.startsWith('included:'), true);
});

test('custom spawn output resolves the exact worker parent and turn', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'parent', sessionMeta('parent'), [
    turnStarted('turn-b'),
    {
      timestamp: '2026-08-20T08:00:05Z', type: 'response_item', payload: {
        type: 'custom_tool_call_output',
        output: [{ type: 'input_text', text: '{"agent_id":"worker","nickname":"Qwen"}' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-b' },
      },
    },
    token(usage(100, 50, 10, 2)), turnComplete('turn-b'),
  ]);
  await makeRollout(root, 'worker', childMeta('worker', 'parent'), [token(usage(10, 0, 1, 1))]);
  const result = await inspectSupervisionUsage({ codexHome: root, workerThreadId: 'worker' });
  assert.equal(result.parent.benchmark_turn.turn_id, 'turn-b');
  assert.equal(result.parent.benchmark_turn.boundary.spawn_source, 'tool_output');
});

test('exact watchdog ID resolves the intended sibling', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'parent', sessionMeta('parent'), [
    turnStarted('turn'), spawnEvent('turn', 'worker', 'luna-a', 'luna-b'), token(usage(100, 20, 10, 1)), turnComplete('turn'),
  ]);
  await makeRollout(root, 'worker', childMeta('worker', 'parent'), [token(usage(10, 0, 1, 1))]);
  for (const id of ['luna-a', 'luna-b']) {
    await makeRollout(root, id, childMeta(id, 'parent', { model_provider: 'openai', agent_role: 'watchdog' }), [
      turnContext(`turn-${id}`, 'gpt-5.6-luna'), token(usage(id === 'luna-a' ? 20 : 30, 0, 2, 1)),
    ]);
  }
  const result = await inspectSupervisionUsage({
    codexHome: root, workerThreadId: 'worker', watchdogThreadId: 'luna-b',
  });
  assert.equal(result.watchdog.thread, 'luna-b');
});

test('explicit watchdog from another parent turn is rejected', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'parent', sessionMeta('parent'), [
    turnStarted('old'), spawnEvent('old', 'old-luna'), token(usage(40, 10, 4, 1)), turnComplete('old'),
    turnStarted('benchmark'), spawnEvent('benchmark', 'worker'), token(usage(100, 30, 10, 2)), turnComplete('benchmark'),
  ]);
  await makeRollout(root, 'worker', childMeta('worker', 'parent'), [token(usage(10, 0, 1, 1))]);
  await makeRollout(root, 'old-luna', childMeta('old-luna', 'parent', {
    model_provider: 'openai', agent_role: 'watchdog', agent_nickname: 'Luna',
  }), [token(usage(20, 0, 2, 1))]);
  const result = await inspectSupervisionUsage({
    codexHome: root, workerThreadId: 'worker', watchdogThreadId: 'old-luna',
  });
  assert.equal(result.watchdog, null);
  assert.equal(result.watchdog_thread, null);
  assert.ok(result.warnings.some((warning) => warning.includes('no exact spawn relation')));
});

test('ambiguous watchdog discovery reports ambiguity instead of guessing', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'parent', sessionMeta('parent'), [
    turnStarted('turn'), spawnEvent('turn', 'worker', 'luna-a', 'luna-b'), token(usage(100, 20, 10, 1)), turnComplete('turn'),
  ]);
  await makeRollout(root, 'worker', childMeta('worker', 'parent'), [token(usage(10, 0, 1, 1))]);
  for (const id of ['luna-a', 'luna-b']) {
    await makeRollout(root, id, childMeta(id, 'parent', { model_provider: 'openai', agent_role: 'watchdog' }), [
      turnContext(`turn-${id}`, 'gpt-5.6-luna'), token(usage(20, 0, 2, 1)),
    ]);
  }
  const result = await inspectSupervisionUsage({ codexHome: root, workerThreadId: 'worker' });
  assert.equal(result.watchdog, null);
  assert.ok(result.warnings.some((warning) => warning.includes('ambiguous')));
  assert.equal(result.combined.hosted_effective_tokens, null);
});

test('hosted worker cannot make an unresolved Luna look like a complete hosted tree', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'parent', sessionMeta('parent'), [
    turnStarted('turn'), spawnEvent('turn', 'worker'), token(usage(100, 20, 10, 1)), turnComplete('turn'),
  ]);
  await makeRollout(root, 'worker', childMeta('worker', 'parent', { model_provider: 'openai' }), [
    token(usage(10, 0, 1, 1)),
  ]);
  const result = await inspectSupervisionUsage({ codexHome: root, workerThreadId: 'worker' });
  assert.equal(result.watchdog, null);
  assert.equal(result.combined.hosted_effective_tokens, null);
});

test('worker selection never crosses to another exact parent', async (t) => {
  const root = await temporaryCodexHome(t);
  for (const parent of ['parent-a', 'parent-b']) {
    const worker = `worker-${parent.at(-1)}`;
    await makeRollout(root, parent, sessionMeta(parent), [
      turnStarted(`turn-${parent}`), spawnEvent(`turn-${parent}`, worker), token(usage(100, 0, 10, 1)), turnComplete(`turn-${parent}`),
    ]);
    await makeRollout(root, worker, childMeta(worker, parent), [token(usage(10, 0, 1, 1))]);
  }
  const result = await inspectSupervisionUsage({ codexHome: root, workerThreadId: 'worker-a' });
  assert.equal(result.parent.thread, 'parent-a');
});

test('missing and partial external-provider usage are explicit', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'partial', childMeta('partial', 'parent'), [token({
    input_tokens: 100, output_tokens: 20, total_tokens: 120,
  })]);
  await makeRollout(root, 'missing', childMeta('missing', 'parent'), [{
    type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null },
  }]);
  const partial = await inspectThreadUsage({ codexHome: root, threadId: 'partial' });
  assert.equal(partial.usage_available, true);
  assert.equal(partial.usage_completeness, 'partial');
  assert.equal(partial.cumulative.non_cached_input_tokens, null);
  assert.equal(partial.cumulative.effective_tokens, null);
  assert.ok(partial.warnings.some((warning) => warning.includes('cached_input_tokens')));
  const missing = await inspectThreadUsage({ codexHome: root, threadId: 'missing' });
  assert.equal(missing.usage_available, false);
  assert.equal(missing.cumulative, null);
});

test('context compaction does not reset or double-count cumulative usage', async (t) => {
  const root = await temporaryCodexHome(t);
  const first = usage(100, 50, 10, 5);
  const final = usage(150, 80, 20, 7);
  await makeRollout(root, 'root', sessionMeta('root'), [
    token(first),
    token(first, '2026-08-20T08:00:02Z', usage(0, 0, 0, 0, { total: 42 })),
    { type: 'event_msg', payload: { type: 'context_compacted' } },
    token(final),
  ]);
  const result = await inspectThreadUsage({ codexHome: root, threadId: 'root' });
  assert.equal(result.cumulative.input_tokens, 150);
  assert.equal(result.cumulative.effective_tokens, 90);
  assert.equal(result.context_compactions, 1);
});

test('malformed and truncated JSONL lines do not crash accounting', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'root', sessionMeta('root'), [
    '{not-json', token(usage(25, 5, 5, 2)), '{"type":"event_msg"',
  ], { trailingText: '{"payload":' });
  const result = await inspectThreadUsage({ codexHome: root, threadId: 'root' });
  assert.equal(result.cumulative.effective_tokens, 25);
  assert.ok(result.warnings.some((warning) => warning.includes('malformed or truncated')));
});

test('large rollouts retain pre-turn cumulative boundaries outside the watcher tail', async (t) => {
  const root = await temporaryCodexHome(t);
  const filler = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(9 * 1024 * 1024) }] } });
  await makeRollout(root, 'parent', sessionMeta('parent'), [
    turnStarted('old'), token(usage(100, 20, 10, 2)), turnComplete('old'), filler,
    turnStarted('benchmark'), spawnEvent('benchmark', 'worker'), token(usage(200, 70, 20, 5)), turnComplete('benchmark'),
  ]);
  await makeRollout(root, 'worker', childMeta('worker', 'parent'), [token(usage(10, 0, 1, 1))]);
  const result = await inspectSupervisionUsage({ codexHome: root, workerThreadId: 'worker' });
  assert.equal(result.parent.benchmark_turn.input_tokens, 100);
  assert.equal(result.parent.benchmark_turn.effective_tokens, 60);
});

test('falls back to summing current upstream raw_response_completed deltas', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'root', sessionMeta('root'), [
    { type: 'event_msg', payload: { type: 'raw_response_completed', response_id: 'one', token_usage: usage(10, 4, 2, 1) } },
    { type: 'event_msg', payload: { type: 'raw_response_completed', response_id: 'two', token_usage: usage(20, 10, 3, 2) } },
  ]);
  const result = await inspectThreadUsage({ codexHome: root, threadId: 'root' });
  assert.equal(result.accounting_source, 'summed_raw_response_completed_deltas');
  assert.equal(result.cumulative.input_tokens, 30);
  assert.equal(result.cumulative.effective_tokens, 21);
});

function runCli(args) {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pluginRoot, 'bin', 'v1usage.mjs'), ...args], {
      cwd: pluginRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI supports exact root-thread JSON accounting without a parent', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'solo', sessionMeta('solo'), [token(usage(100, 40, 20, 10))]);
  const result = await runCli(['-Thread', 'solo', '-CodexHome', root, '-Json']);
  assert.equal(result.code, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.thread, 'solo');
  assert.equal(json.cumulative.effective_tokens, 80);
});
