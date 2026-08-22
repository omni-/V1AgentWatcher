import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  accumulateHealthWindow,
  analyzeAgentHealth,
  collectProgressFacts,
  formatHealthWindow,
  inspectAgentHealth,
  inspectAgentSession,
  listAgentSessions,
  normalizeWaitTimeoutMs,
  summarizeRolloutLines,
  TRANSPORT_SAFE_WAIT_TIMEOUT_MS,
  waitForAgent,
} from '../mcp/watcher.mjs';

function v1ChildMeta(overrides = {}) {
  const id = overrides.id ?? 'child';
  const parentThreadId = overrides.parent_thread_id ?? 'root';
  return {
    id,
    parent_thread_id: parentThreadId,
    cwd: 'C:\\repo',
    model_provider: 'lmstudio',
    agent_nickname: 'qwen',
    multi_agent_version: 'v1',
    source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, depth: 1 } } },
    ...overrides,
  };
}

async function makeRollout(root, name, meta, lines = [], datePath = ['2026', '08', '20']) {
  const dir = path.join(root, 'sessions', ...datePath);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const records = [
    { timestamp: '2026-08-20T08:00:00Z', type: 'session_meta', payload: meta },
    ...lines,
  ];
  await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return file;
}

async function temporaryCodexHome(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v1-agent-watcher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('selects a real V1 LM Studio collaboration child and excludes internal and V2 sessions', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-root.jsonl', {
    id: 'root', parent_thread_id: null, cwd: 'C:\\repo', model_provider: 'openai',
  });
  await makeRollout(root, 'rollout-review.jsonl', {
    id: 'review', parent_thread_id: 'root', cwd: 'C:\\repo', model_provider: 'openai',
    multi_agent_version: 'v1', source: { subagent: 'review' }, agent_role: 'reviewer',
  });
  await makeRollout(root, 'rollout-guardian.jsonl', {
    id: 'guardian', parent_thread_id: 'root', cwd: 'C:\\repo', model_provider: 'openai',
    multi_agent_version: 'disabled', source: { subagent: { other: 'guardian' } },
  });
  await makeRollout(root, 'rollout-v2.jsonl', v1ChildMeta({
    id: 'v2', model_provider: 'openai', multi_agent_version: 'v2', agent_nickname: 'luna',
  }));
  await makeRollout(root, 'rollout-qwen.jsonl', v1ChildMeta());

  const agents = await listAgentSessions({ codexHome: root });
  assert.deepEqual(agents.map((agent) => agent.threadId), ['child']);
  assert.equal(agents[0].modelProvider, 'lmstudio');

  const requestedCwd = process.platform === 'win32' ? 'c:\\REPO\\' : 'C:\\repo';
  const providerMatch = await listAgentSessions({ codexHome: root, provider: 'lmstudio', cwd: requestedCwd });
  assert.equal(providerMatch.length, 1);
  assert.equal((await listAgentSessions({ codexHome: root, provider: 'openai' })).length, 0);
});

test('supports historical sub_agent thread-spawn metadata without accepting broad subagent labels', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-old-v1.jsonl', v1ChildMeta({
    source: { sub_agent: { thread_spawn: { parent_thread_id: 'root' } } },
  }));
  await makeRollout(root, 'rollout-fake.jsonl', v1ChildMeta({
    id: 'fake', source: { sub_agent: 'compact' }, agent_nickname: null,
  }));

  const agents = await listAgentSessions({ codexHome: root });
  assert.deepEqual(agents.map((agent) => agent.threadId), ['child']);
});

test('parses session metadata nested under payload.meta', async (t) => {
  const root = await temporaryCodexHome(t);
  const dir = path.join(root, 'sessions', '2026', '08', '20');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'rollout-nested.jsonl'), `${JSON.stringify({
    timestamp: '2026-08-20T08:00:00Z',
    type: 'session_meta',
    payload: { meta: v1ChildMeta({ id: 'nested' }), git: null },
  })}\n`, 'utf8');

  const agents = await listAgentSessions({ codexHome: root });
  assert.equal(agents[0].threadId, 'nested');
});

test('chooses the most recently updated matching child and honors parent/provider filters', async (t) => {
  const root = await temporaryCodexHome(t);
  const older = await makeRollout(root, 'rollout-older.jsonl', v1ChildMeta({ id: 'older' }));
  const newer = await makeRollout(root, 'rollout-newer.jsonl', v1ChildMeta({ id: 'newer' }));
  await fs.utimes(older, new Date('2026-08-20T08:00:00Z'), new Date('2026-08-20T08:00:00Z'));
  await fs.utimes(newer, new Date('2026-08-20T08:05:00Z'), new Date('2026-08-20T08:05:00Z'));

  const result = await inspectAgentSession({ codexHome: root, provider: 'lmstudio', parentThreadId: 'root' });
  assert.equal(result.agent.threadId, 'newer');
  assert.equal(await inspectAgentSession({ codexHome: root, provider: 'openai' }), null);
});

test('fresh persisted events override a stale rollout file mtime for inactivity', async (t) => {
  const root = await temporaryCodexHome(t);
  const nowMs = Date.parse('2026-08-20T09:00:18Z');
  const file = await makeRollout(root, 'rollout-stale-mtime.jsonl', v1ChildMeta({ id: 'fresh-worker' }), [
    { timestamp: '2026-08-20T09:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-08-20T09:00:00Z', type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Fresh persisted work.' } },
  ]);
  const staleMtime = new Date(nowMs - 1898 * 1000);
  await fs.utimes(file, staleMtime, staleMtime);

  const inspection = await inspectAgentSession({ codexHome: root, threadId: 'fresh-worker', nowMs });
  const health = await inspectAgentHealth({ codexHome: root, threadId: 'fresh-worker', nowMs });

  assert.equal(inspection.secondsSinceActivity, 18);
  assert.equal(inspection.activitySource, 'persisted_event');
  assert.equal(health.secondsSinceActivity, 18);
  assert.equal(health.activitySource, 'persisted_event');
  assert.equal(health.health, 'healthy');
});

test('rollout mtime remains the activity fallback when events have no usable timestamps', async (t) => {
  const root = await temporaryCodexHome(t);
  const nowMs = Date.parse('2026-08-20T09:00:18Z');
  const file = await makeRollout(root, 'rollout-mtime-fallback.jsonl', v1ChildMeta({ id: 'fallback-worker' }), [
    { type: 'event_msg', payload: { type: 'task_started' } },
  ]);
  const mtime = new Date(nowMs - 30 * 1000);
  await fs.utimes(file, mtime, mtime);

  const inspection = await inspectAgentSession({ codexHome: root, threadId: 'fallback-worker', nowMs });
  assert.equal(inspection.secondsSinceActivity, 30);
  assert.equal(inspection.activitySource, 'file_mtime');
});

test('nickname and role filters resolve the intended latest child', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-worker.jsonl', v1ChildMeta({ id: 'worker', agent_nickname: 'qwen' }));
  await makeRollout(root, 'rollout-watchdog.jsonl', v1ChildMeta({
    id: 'watchdog', model_provider: 'openai', agent_nickname: null, agent_role: 'watchdog',
  }));

  assert.equal((await inspectAgentSession({ codexHome: root, nickname: 'qwen' })).agent.threadId, 'worker');
  assert.equal((await inspectAgentSession({ codexHome: root, nickname: 'watchdog' })).agent.threadId, 'watchdog');
});

test('exact thread lookup is not limited to the newest 100 child sessions', async (t) => {
  const root = await temporaryCodexHome(t);
  await Promise.all(Array.from({ length: 105 }, (_, index) => makeRollout(
    root,
    `rollout-${String(index).padStart(3, '0')}.jsonl`,
    v1ChildMeta({ id: `child-${index}` }),
  )));

  const result = await inspectAgentSession({ codexHome: root, threadId: 'child-0' });
  assert.equal(result.agent.threadId, 'child-0');
});

test('exact thread lookup is not rejected by stale metadata hints', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-worker.jsonl', v1ChildMeta({
    id: 'worker', cwd: 'C:\\persisted-parent-cwd', model_provider: 'lmstudio',
  }), [
    { type: 'event_msg', payload: { type: 'task_started' } },
  ]);

  const result = await inspectAgentHealth({
    codexHome: root,
    threadId: 'worker',
    cwd: 'C:\\worker-shell-cwd',
    provider: 'expected-provider-hint',
    parentThreadId: 'expected-parent-hint',
  });
  assert.equal(result.agent.threadId, 'worker');
  assert.equal(result.state, 'running');
});

test('persisted-rollout wait wakes when an exact sibling worker completes', async (t) => {
  const root = await temporaryCodexHome(t);
  const file = await makeRollout(root, 'rollout-worker.jsonl', v1ChildMeta({ id: 'worker' }), [
    { type: 'event_msg', payload: { type: 'task_started' } },
  ]);
  const appendCompletion = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.appendFile(file, `${JSON.stringify({
      type: 'event_msg', payload: { type: 'task_complete' },
    })}\n`, 'utf8');
  })();

  const result = await waitForAgent({
    codexHome: root,
    threadId: 'worker',
    timeoutMs: 500,
    pollIntervalMs: 5,
  });
  await appendCompletion;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.threadId, 'worker');
  assert.equal(result.found, true);
});

test('persisted-rollout wait times out without treating a missing session as terminal', async (t) => {
  const root = await temporaryCodexHome(t);
  const result = await waitForAgent({
    codexHome: root,
    threadId: 'not-persisted-yet',
    timeoutMs: 25,
    pollIntervalMs: 5,
  });
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.state, 'missing');
  assert.equal(result.found, false);
});

test('persisted-rollout waits clamp oversized requests to a transport-safe chunk', () => {
  assert.equal(TRANSPORT_SAFE_WAIT_TIMEOUT_MS, 225000);
  assert.equal(normalizeWaitTimeoutMs(900000), TRANSPORT_SAFE_WAIT_TIMEOUT_MS);
  assert.equal(normalizeWaitTimeoutMs(60000), 60000);
});

test('persisted-rollout wait reports worker terminal errors immediately', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-worker.jsonl', v1ChildMeta({ id: 'worker' }), [
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'event_msg', payload: { type: 'error', message: 'provider failed' } },
  ]);
  const result = await waitForAgent({ codexHome: root, threadId: 'worker', timeoutMs: 100 });
  assert.equal(result.outcome, 'terminal_error');
  assert.equal(result.state, 'errored');
});

test('maxFiles scanning starts with the newest date directories', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-old.jsonl', v1ChildMeta({ id: 'old' }), [], ['2025', '01', '01']);
  await makeRollout(root, 'rollout-new.jsonl', v1ChildMeta({ id: 'new' }), [], ['2026', '08', '20']);

  const agents = await listAgentSessions({ codexHome: root, maxFiles: 1 });
  assert.deepEqual(agents.map((agent) => agent.threadId), ['new']);
});

test('handles task and turn lifecycle event names and terminal errors', () => {
  const taskSummary = summarizeRolloutLines([
    JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { type: 'task_complete' } }),
  ]);
  assert.equal(taskSummary.status, 'idle');

  const turnSummary = summarizeRolloutLines([
    JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'turn_started' } }),
    JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { type: 'turn_complete' } }),
  ]);
  assert.equal(turnSummary.status, 'idle');

  const failed = summarizeRolloutLines([
    JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { type: 'task_complete', error: { message: 'provider failed' } } }),
  ]);
  assert.equal(failed.status, 'errored');
  assert.match(failed.events.at(-1).text, /provider failed/);
});

test('extracts raw reasoning content and suppresses adjacent persisted duplicates', () => {
  const lines = [
    JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'agent_reasoning_raw_content', text: 'Inspect the handler first.' } }),
    JSON.stringify({ timestamp: 't2', type: 'response_item', payload: { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Inspect the handler first.' }], summary: [] } }),
    JSON.stringify({ timestamp: 't3', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg incSeason"}' } }),
  ];

  const summary = summarizeRolloutLines(lines, { eventLimit: 10 });
  assert.equal(summary.events.filter((event) => event.kind === 'reasoning').length, 1);
  assert.match(summary.events.find((event) => event.kind === 'tool_call').text, /rg incSeason/);
});

test('coalesces raw and summary deltas by item and content index', () => {
  const lines = [
    JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { type: 'reasoning_raw_content_delta', item_id: 'reason-1', content_index: 0, delta: 'The race ' } }),
    JSON.stringify({ timestamp: 't3', type: 'event_msg', payload: { type: 'reasoning_raw_content_delta', item_id: 'reason-1', content_index: 0, delta: 'can interleave.' } }),
    JSON.stringify({ timestamp: 't4', type: 'event_msg', payload: { type: 'reasoning_raw_content_delta', item_id: 'reason-1', content_index: 1, delta: 'Separate raw block.' } }),
    JSON.stringify({ timestamp: 't5', type: 'event_msg', payload: { type: 'reasoning_content_delta', item_id: 'reason-1', summary_index: 0, delta: 'Summary one.' } }),
  ];

  const summary = summarizeRolloutLines(lines, { eventLimit: 10 });
  assert.equal(summary.status, 'running');
  const reasoning = summary.events.filter((event) => event.kind === 'reasoning');
  assert.equal(reasoning.length, 3);
  assert.equal(reasoning[0].text, 'The race can interleave.');
  assert.equal(reasoning[1].text, 'Separate raw block.');
  assert.equal(reasoning[2].text, 'Summary one.');
});

test('a resumed reasoning stream remains the most recent event', () => {
  const lines = [
    JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'reasoning_raw_content_delta', item_id: 'reason-1', content_index: 0, delta: 'First ' } }),
    JSON.stringify({ timestamp: 't2', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg Widget"}' } }),
    JSON.stringify({ timestamp: 't3', type: 'event_msg', payload: { type: 'reasoning_raw_content_delta', item_id: 'reason-1', content_index: 0, delta: 'second.' } }),
  ];

  const summary = summarizeRolloutLines(lines, { eventLimit: 1 });
  assert.equal(summary.events[0].kind, 'reasoning');
  assert.equal(summary.events[0].text, 'First second.');
  assert.equal(summary.events[0].timestamp, 't3');
});

test('deterministic health detects repeated identical commands', () => {
  const lines = [JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })];
  for (let index = 0; index < 3; index += 1) {
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', call_id: `call-${index}`, name: 'exec_command', arguments: '{"cmd":"rg Widget src"}' },
    }));
  }

  const health = analyzeAgentHealth(lines, { agent: { agentNickname: 'qwen' }, secondsSinceActivity: 10 });
  assert.equal(health.health, 'suspicious');
  assert.ok(health.signals.some((signal) => signal.startsWith('repeated_command:')));
});

test('health signals do not leak from a completed prior turn into the current turn', () => {
  const lines = [JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })];
  for (let index = 0; index < 3; index += 1) {
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', call_id: `old-${index}`, name: 'exec_command', arguments: '{"cmd":"rg Widget src"}' },
    }));
  }
  lines.push(
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Inspect the current caller.' } }),
  );

  const health = analyzeAgentHealth(lines, { agent: { agentNickname: 'qwen' }, secondsSinceActivity: 10 });
  assert.equal(health.state, 'running');
  assert.equal(health.health, 'healthy');
  assert.equal(health.recentSummary.commandCalls, 0);
});

test('one self-correction and Qwen slowness alone remain healthy', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Actually, I should inspect the caller first.' } }),
  ];

  const health = analyzeAgentHealth(lines, {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 59 * 60,
  });
  assert.equal(health.state, 'running');
  assert.equal(health.health, 'healthy');
  assert.deepEqual(health.signals, []);
});

test('ordinary wait discourse markers do not count as premise reversals', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Wait — this event handler needs to be a method.' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Wait for the callback before reading the state.' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Actually, this helper belongs beside the parser.' } }),
  ];

  const health = analyzeAgentHealth(lines, { agent: { agentNickname: 'qwen' }, secondsSinceActivity: 30 });
  assert.equal(health.health, 'healthy');
  assert.equal(health.recentSummary.reasoningUpdates, 3);
  assert.equal(health.signals.some((signal) => signal.startsWith('premise_reversals:')), false);
});

test('Qwen inactivity becomes suspicious only after one hour', () => {
  const lines = [JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })];
  const health = analyzeAgentHealth(lines, {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 60 * 60,
  });
  assert.equal(health.health, 'suspicious');
  assert.ok(health.signals.some((signal) => signal.startsWith('inactivity:')));
});

test('repeated premise reversals can trigger suspicion', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Wait, that assumption does not hold.' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Actually, the earlier branch was mistaken.' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: "Hold on, that's wrong again." } }),
  ];

  const health = analyzeAgentHealth(lines, { agent: { agentNickname: 'qwen' }, secondsSinceActivity: 30 });
  assert.equal(health.health, 'suspicious');
  assert.ok(health.signals.some((signal) => signal.startsWith('premise_reversals:')));
});

test('repeated context compaction is surfaced but no longer escalates on its own', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
  ];
  const health = analyzeAgentHealth(lines, { agent: { agentNickname: 'qwen' }, secondsSinceActivity: 30 });

  assert.ok(health.signals.some((signal) => signal.startsWith('context_compaction:')));
  assert.equal(health.health, 'healthy');

  // It still escalates as soon as any independent signal corroborates it.
  const corroborated = analyzeAgentHealth([
    ...lines,
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'My earlier assumption was wrong.' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'That premise does not hold.' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Our previous approach was mistaken.' } }),
  ], { agent: { agentNickname: 'qwen' }, secondsSinceActivity: 30 });
  assert.equal(corroborated.health, 'suspicious');
});

test('repeated failed commands are distinguished from repeated successful commands', () => {
  const lines = [JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })];
  for (let index = 0; index < 3; index += 1) {
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', call_id: `failed-${index}`, name: 'exec_command', arguments: '{"cmd":"npm test"}' },
    }));
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: `failed-${index}`, output: { exit_code: 1, output: 'failed' } },
    }));
  }

  const health = analyzeAgentHealth(lines, { agent: { agentNickname: 'ornith' }, secondsSinceActivity: 10 });
  assert.ok(health.signals.some((signal) => signal.startsWith('repeated_failures:')));
  assert.equal(health.recentSummary.failedCommands, 3);
});

test('failed command status is honored when an exit code is absent', () => {
  const lines = [JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })];
  for (let index = 0; index < 3; index += 1) {
    lines.push(
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', call_id: `status-${index}`, name: 'exec_command', arguments: '{"cmd":"npm test"}' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: `status-${index}`, output: { exit_code: null, status: 'failed' } },
      }),
    );
  }

  const health = analyzeAgentHealth(lines, { secondsSinceActivity: 10 });
  assert.equal(health.recentSummary.failedCommands, 3);
  assert.ok(health.signals.some((signal) => signal.startsWith('repeated_failures:')));
});

test('malformed and incomplete rollout lines do not crash summary or health inspection', async (t) => {
  const lines = [
    '{not-json',
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    '{"type":"event_msg","payload":',
  ];
  assert.equal(summarizeRolloutLines(lines).status, 'running');
  assert.equal(analyzeAgentHealth(lines).recentSummary.malformedLinesIgnored, 2);

  const root = await temporaryCodexHome(t);
  const file = await makeRollout(root, 'rollout-incomplete.jsonl', v1ChildMeta(), [
    { type: 'event_msg', payload: { type: 'task_started' } },
  ]);
  await fs.appendFile(file, '{"type":"event_msg"', 'utf8');
  const result = await inspectAgentHealth({ codexHome: root, threadId: 'child' });
  assert.equal(result.state, 'running');
  assert.equal(result.recentSummary.malformedLinesIgnored, 1);
});

function event(type, payload, timestamp) {
  return JSON.stringify({ timestamp, type, payload });
}

function reasoningLine(text, timestamp) {
  return event('event_msg', { type: 'agent_reasoning', text }, timestamp);
}

function shellLine(callId, command, timestamp) {
  return event('event_msg', { type: 'exec_command_begin', call_id: callId, command }, timestamp);
}

function compactionLine(timestamp) {
  return event('event_msg', { type: 'context_compacted' }, timestamp);
}

function patchLine(callId, timestamp) {
  return event('response_item', {
    type: 'function_call', call_id: callId, name: 'apply_patch', arguments: '{"input":"*** Update File: src/View.cs"}',
  }, timestamp);
}

function userLine(text, timestamp) {
  return event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, timestamp);
}

// Two compaction/replanning cycles with no mutation, modeled on the observed
// Qwen benchmark run.
function stalledRolloutLines() {
  return [
    event('event_msg', { type: 'task_started' }),
    reasoningLine('The stale row comes from the leaderboard callback. My implementation plan is to drop responses whose request token is not current.', '2026-08-20T09:00:00Z'),
    shellLine('c1', ['rg', 'LeaderboardService', 'src']),
    compactionLine('2026-08-20T09:20:00Z'),
    reasoningLine('Rebuilding context after the handoff. Let me re-read the view model.', '2026-08-20T09:21:00Z'),
    shellLine('c2', ['rg', 'LeaderboardService', 'src']),
    shellLine('c3', ['rg', 'incSeason', 'src']),
    shellLine('c4', ['get-childitem', 'tests']),
    reasoningLine('I will now apply the changes to the callback.', '2026-08-20T09:40:00Z'),
    compactionLine('2026-08-20T09:45:00Z'),
    shellLine('c5', ['rg', 'MockRepository', 'src']),
    shellLine('c6', ['rg', 'MockRepository', 'tests']),
    shellLine('c7', ['get-childitem', '-recurse', 'bin']),
  ];
}

test('four completed found=true Qwen chunks produce exactly one health inspection at the window boundary', () => {
  const windowMs = 900000;
  let elapsedMs = 0;
  let foundInWindow = false;
  let inspections = 0;

  for (let chunk = 0; chunk < 4; chunk += 1) {
    const window = accumulateHealthWindow({
      windowMs,
      elapsedMs,
      foundInWindow,
      outcome: 'timeout',
      waitedMs: TRANSPORT_SAFE_WAIT_TIMEOUT_MS,
      found: true,
    });
    elapsedMs = window.elapsedMs;
    foundInWindow = window.foundInWindow;
    if (window.inspectNow) inspections += 1;
    assert.equal(window.missingWindow, false);
  }

  assert.equal(inspections, 1);
  assert.equal(elapsedMs, windowMs);
});

test('a watchdog reading the health-window aliases still reaches the 900000 ms inspection boundary', () => {
  const windowMs = 900000;
  // The benchmark watchdog read the accumulator back through the tool's INPUT
  // argument names. With the compatibility aliases that mistake is harmless.
  let sent = { elapsed_health_window_ms: 0, found_in_health_window: false };
  const elapsedPerChunk = [];
  let inspections = 0;
  let last = null;

  for (let chunk = 0; chunk < 4; chunk += 1) {
    last = formatHealthWindow(accumulateHealthWindow({
      windowMs,
      elapsedMs: sent.elapsed_health_window_ms,
      foundInWindow: sent.found_in_health_window,
      outcome: 'timeout',
      waitedMs: TRANSPORT_SAFE_WAIT_TIMEOUT_MS,
      found: true,
    }));
    elapsedPerChunk.push(last.elapsed_ms);
    if (last.inspect_now) inspections += 1;
    sent = {
      elapsed_health_window_ms: last.elapsed_health_window_ms,
      found_in_health_window: last.found_in_health_window,
    };
  }

  assert.deepEqual(elapsedPerChunk, [225000, 450000, 675000, 900000]);
  assert.equal(inspections, 1);
  assert.equal(last.inspect_now, true);
  assert.equal(last.missing_window, false);
  assert.equal(sent.found_in_health_window, true);
});

test('the health-window aliases carry exactly the canonical values', () => {
  const found = formatHealthWindow(accumulateHealthWindow({
    windowMs: 900000, elapsedMs: 675000, foundInWindow: true, outcome: 'timeout', waitedMs: 225000, found: true,
  }));
  assert.equal(found.elapsed_health_window_ms, found.elapsed_ms);
  assert.equal(found.found_in_health_window, found.found_in_window);
  assert.equal(found.elapsed_health_window_ms, 900000);
  assert.equal(found.found_in_health_window, true);

  const missing = formatHealthWindow(accumulateHealthWindow({
    windowMs: 900000, elapsedMs: 675000, foundInWindow: false, outcome: 'timeout', waitedMs: 225000, found: false,
  }));
  assert.equal(missing.elapsed_health_window_ms, missing.elapsed_ms);
  assert.equal(missing.found_in_health_window, missing.found_in_window);
  assert.equal(missing.found_in_health_window, false);
  assert.equal(missing.missing_window, true);
});

test('resending zero accumulator state is the benchmark failure the aliases prevent', () => {
  const observed = [];
  for (let chunk = 0; chunk < 4; chunk += 1) {
    // The failing watchdog read undefined field names, so every chunk was sent
    // with elapsed_health_window_ms: 0 and found_in_health_window: false.
    const window = formatHealthWindow(accumulateHealthWindow({
      windowMs: 900000,
      elapsedMs: 0,
      foundInWindow: false,
      outcome: 'timeout',
      waitedMs: 225000,
      found: true,
    }));
    observed.push({ elapsedMs: window.elapsed_ms, inspectNow: window.inspect_now });
  }

  // Four chunks, each looking like the first chunk of a brand new window: the
  // 900000 ms boundary is never reached and the stall screen never runs.
  assert.deepEqual(observed, [
    { elapsedMs: 225000, inspectNow: false },
    { elapsedMs: 225000, inspectNow: false },
    { elapsedMs: 225000, inspectNow: false },
    { elapsedMs: 225000, inspectNow: false },
  ]);
});

test('a completed found=true chunk resets missing-worker state without inspecting early', () => {
  const window = accumulateHealthWindow({
    windowMs: 900000,
    elapsedMs: 0,
    foundInWindow: false,
    outcome: 'timeout',
    waitedMs: 225000,
    found: true,
  });

  assert.equal(window.foundInWindow, true);
  assert.equal(window.inspectNow, false);
  assert.equal(window.missingWindow, false);
  assert.equal(window.elapsedMs, 225000);
  assert.equal(window.remainingMs, 675000);
  assert.equal(window.nextChunkMs, TRANSPORT_SAFE_WAIT_TIMEOUT_MS);
});

test('a full window of found=false chunks reports one missing window instead of an inspection', () => {
  let elapsedMs = 0;
  let foundInWindow = false;
  let window = null;
  for (let chunk = 0; chunk < 4; chunk += 1) {
    window = accumulateHealthWindow({
      windowMs: 900000, elapsedMs, foundInWindow, outcome: 'timeout', waitedMs: 225000, found: false,
    });
    elapsedMs = window.elapsedMs;
    foundInWindow = window.foundInWindow;
  }

  assert.equal(window.missingWindow, true);
  assert.equal(window.inspectNow, false);
});

test('failed transport chunks contribute zero accumulated health-window time', () => {
  const failed = accumulateHealthWindow({
    windowMs: 900000, elapsedMs: 450000, foundInWindow: true, outcome: 'transport_failure', waitedMs: 225000, found: true,
  });
  assert.equal(failed.elapsedMs, 450000);
  assert.equal(failed.inspectNow, false);

  const unreported = accumulateHealthWindow({
    windowMs: 900000, elapsedMs: 675000, foundInWindow: true, outcome: undefined, waitedMs: 225000,
  });
  assert.equal(unreported.elapsedMs, 675000);
  assert.equal(unreported.inspectNow, false);
});

test('progress stall is reported after two compactions and replanning without mutation', () => {
  const health = analyzeAgentHealth(stalledRolloutLines(), {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:50:00Z'),
  });

  assert.equal(health.state, 'running');
  assert.equal(health.health, 'suspicious');
  assert.ok(health.signals.some((signal) => signal.startsWith('progress_stall:')));
  assert.equal(health.progress.compactionsSinceMutation, 2);
  assert.equal(health.progress.mutations, 0);
  assert.equal(health.progress.secondsSinceMutation, null);
  assert.equal(health.progress.implementationPhaseCommitted, true);
  assert.equal(health.progress.implementationPhaseReentered, true);
  assert.equal(health.progress.postCompactionRediscovery, true);
  assert.equal(health.progress.stalledAfterGuidance, false);
});

test('one compaction without mutation is not a progress stall', () => {
  const lines = [
    event('event_msg', { type: 'task_started' }),
    reasoningLine('My implementation plan is to drop stale responses.', '2026-08-20T09:00:00Z'),
    compactionLine('2026-08-20T09:20:00Z'),
    shellLine('c1', ['rg', 'LeaderboardService', 'src']),
    shellLine('c2', ['rg', 'incSeason', 'src']),
    shellLine('c3', ['get-childitem', 'tests']),
  ];

  const health = analyzeAgentHealth(lines, { agent: { agentNickname: 'qwen' }, secondsSinceActivity: 30 });
  assert.equal(health.health, 'healthy');
  assert.equal(health.progress.stalled, false);
  assert.equal(health.progress.compactionsSinceMutation, 1);
});

test('long reasoning without output is not a progress stall', () => {
  const lines = [
    event('event_msg', { type: 'task_started' }),
    reasoningLine('My implementation plan is to drop stale responses.', '2026-08-20T09:00:00Z'),
    reasoningLine('Considering how the callback interleaves with the season change.', '2026-08-20T09:30:00Z'),
  ];

  const health = analyzeAgentHealth(lines, {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 59 * 60,
  });
  assert.equal(health.health, 'healthy');
  assert.equal(health.progress.stalled, false);
});

test('a single huge tool result is an explanatory fact, not an escalation', () => {
  const lines = [
    event('event_msg', { type: 'task_started' }),
    reasoningLine('My implementation plan is to drop stale responses.', '2026-08-20T09:00:00Z'),
    shellLine('c1', ['get-childitem', '-recurse', '.']),
    event('event_msg', { type: 'exec_command_end', call_id: 'c1', exit_code: 0, aggregated_output: 'x'.repeat(400000) }),
  ];

  const health = analyzeAgentHealth(lines, { agent: { agentNickname: 'qwen' }, secondsSinceActivity: 30 });
  assert.equal(health.health, 'healthy');
  assert.equal(health.progress.stalled, false);
  assert.equal(health.progress.largeToolOutputs, 1);
  assert.equal(health.progress.largestToolOutputSource, 'estimated');
  assert.ok(health.signals.some((signal) => signal.startsWith('large_tool_output:')));
});

test('persisted tool-result token metadata is preferred over a character estimate', () => {
  const facts = collectProgressFacts([
    event('response_item', {
      type: 'function_call_output',
      call_id: 'c1',
      output: { output: 'short', metadata: { original_token_count: 82000 } },
    }),
  ]);

  assert.equal(facts.largeToolOutputs, 1);
  assert.equal(facts.largestToolOutputTokens, 82000);
  assert.equal(facts.largestToolOutputSource, 'metadata');
});

test('investigation followed by a repository mutation stays healthy', () => {
  const lines = [
    event('event_msg', { type: 'task_started' }),
    reasoningLine('My implementation plan is to drop stale responses.', '2026-08-20T09:00:00Z'),
    shellLine('c1', ['rg', 'LeaderboardService', 'src']),
    shellLine('c2', ['rg', 'incSeason', 'src']),
    shellLine('c3', ['get-childitem', 'tests']),
    patchLine('c4', '2026-08-20T09:10:00Z'),
  ];

  const health = analyzeAgentHealth(lines, {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:12:00Z'),
  });
  assert.equal(health.health, 'healthy');
  assert.equal(health.progress.stalled, false);
  assert.equal(health.progress.mutations, 1);
  assert.equal(health.progress.secondsSinceMutation, 120);
});

test('a repository mutation resets accumulated progress-stall evidence', () => {
  const facts = collectProgressFacts([
    ...stalledRolloutLines(),
    patchLine('c8', '2026-08-20T09:50:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:51:00Z') });

  assert.equal(facts.stalled, false);
  assert.equal(facts.compactionsSinceMutation, 0);
  assert.equal(facts.implementationPhaseCommitted, false);
  assert.equal(facts.mutations, 1);
  assert.equal(facts.secondsSinceMutation, 60);
});

test('a stall that repeats after parent guidance is distinguished from the first stall', () => {
  const first = collectProgressFacts([userLine('Fix the stale leaderboard row.'), ...stalledRolloutLines()]);
  assert.equal(first.stalled, true);
  assert.equal(first.guidanceMessages, 0);
  assert.equal(first.stalledAfterGuidance, false);

  const repeated = collectProgressFacts([
    userLine('Fix the stale leaderboard row.'),
    ...stalledRolloutLines(),
    userLine('Stop investigating. Implement the smallest supported fix now.', '2026-08-20T09:50:00Z'),
    reasoningLine('Understood. My implementation plan is unchanged.', '2026-08-20T09:51:00Z'),
    compactionLine('2026-08-20T10:05:00Z'),
    shellLine('d1', ['rg', 'LeaderboardService', 'src']),
    reasoningLine('I will now apply the changes to the callback.', '2026-08-20T10:20:00Z'),
    compactionLine('2026-08-20T10:25:00Z'),
    shellLine('d2', ['rg', 'MockRepository', 'src']),
    shellLine('d3', ['rg', 'MockRepository', 'tests']),
    shellLine('d4', ['get-childitem', 'tests']),
  ]);

  assert.equal(repeated.guidanceMessages, 1);
  assert.equal(repeated.stalled, true);
  assert.equal(repeated.stalledAfterGuidance, true);
});

test('a compaction bridge summary is not counted as parent guidance', () => {
  const facts = collectProgressFacts([
    userLine('Fix the stale leaderboard row.'),
    compactionLine('2026-08-20T09:20:00Z'),
    userLine('Summary of the previous session: the callback drops nothing yet.', '2026-08-20T09:20:01Z'),
  ]);

  assert.equal(facts.guidanceMessages, 0);
});

test('a truncated tool result reports its persisted original token count instead of a length estimate', () => {
  // Real persisted shape: the body is truncated, so its stored length is far
  // below the pathological original size Codex reports in the header.
  const truncated = [
    'Original token count: 80219',
    'Output:',
    'Warning: truncated output (original token count: 80219)',
    'src/Foo.cs',
    'src/Bar.cs',
  ].join('\n');

  const facts = collectProgressFacts([
    event('event_msg', { type: 'exec_command_begin', call_id: 'c1', command: ['get-childitem', '-recurse', '.'] }),
    event('event_msg', { type: 'exec_command_end', call_id: 'c1', exit_code: 0, aggregated_output: truncated }),
  ]);

  assert.equal(facts.largestToolOutputTokens, 80219);
  assert.equal(facts.largestToolOutputSource, 'reported');
  assert.equal(facts.largeToolOutputs, 1);
});

test('a truncated function_call_output header is read the same way', () => {
  const facts = collectProgressFacts([
    event('response_item', {
      type: 'function_call_output',
      call_id: 'c1',
      output: 'Warning: truncated output (Original token count: 512340)\nfirst line\nsecond line',
    }),
  ]);

  assert.equal(facts.largestToolOutputTokens, 512340);
  assert.equal(facts.largestToolOutputSource, 'reported');
});

test('a small ordinary tool result is still estimated and stays below the threshold', () => {
  const facts = collectProgressFacts([
    event('response_item', { type: 'function_call_output', call_id: 'c1', output: 'two matching files' }),
  ]);

  assert.equal(facts.largeToolOutputs, 0);
  assert.equal(facts.largestToolOutputSource, 'estimated');
});

test('two compactions with an intervening mutation remain healthy', () => {
  const lines = [
    event('event_msg', { type: 'task_started' }),
    reasoningLine('My implementation plan is to drop responses whose request token is stale.', '2026-08-20T09:00:00Z'),
    compactionLine('2026-08-20T09:10:00Z'),
    patchLine('c1', '2026-08-20T09:15:00Z'),
    compactionLine('2026-08-20T09:30:00Z'),
    shellLine('c2', ['dotnet', 'test']),
    reasoningLine('The focused tests pass; tightening the guard next.', '2026-08-20T09:35:00Z'),
  ];

  const health = analyzeAgentHealth(lines, {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:36:00Z'),
  });

  assert.equal(health.health, 'healthy');
  assert.equal(health.progress.stalled, false);
  assert.equal(health.progress.compactions, 2);
  assert.equal(health.progress.compactionsSinceMutation, 1);
  assert.equal(health.progress.secondsSinceMutation, 1260);
});

function investigationBurst(count, prefix, startIso, command = ['rg']) {
  const startMs = Date.parse(startIso);
  return Array.from({ length: count }, (unused, index) => shellLine(
    `${prefix}${index}`,
    [...command, `Symbol${index}`, 'src'],
    new Date(startMs + index * 60_000).toISOString(),
  ));
}

test('a top-level compacted record counts as a compaction in both collection paths', () => {
  const lines = [
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    reasoningLine('My implementation plan is to drop stale responses.', '2026-08-20T09:00:30Z'),
    JSON.stringify({ timestamp: '2026-08-20T09:20:00Z', type: 'compacted' }),
    shellLine('c1', ['rg', 'LeaderboardService', 'src'], '2026-08-20T09:21:00Z'),
    reasoningLine("Now let's implement.", '2026-08-20T09:30:00Z'),
    JSON.stringify({ timestamp: '2026-08-20T09:40:00Z', type: 'compacted', payload: { summary: 'bridge' } }),
    shellLine('c2', ['rg', 'MockRepository', 'src'], '2026-08-20T09:41:00Z'),
    shellLine('c3', ['rg', 'MockRepository', 'tests'], '2026-08-20T09:42:00Z'),
    shellLine('c4', ['get-childitem', 'tests'], '2026-08-20T09:43:00Z'),
  ];

  const health = analyzeAgentHealth(lines, {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:44:00Z'),
  });

  assert.equal(health.recentSummary.contextCompactions, 2);
  assert.equal(health.progress.compactions, 2);
  assert.equal(health.progress.compactionsSinceMutation, 2);
  assert.equal(health.progress.stalled, true);
  assert.ok(health.signals.some((signal) => signal.startsWith('progress_stall:')));
});

test('every persisted compaction spelling is still recognized', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'context_compacted' }, '2026-08-20T09:00:00Z'),
    event('event_msg', { type: 'conversation_compacted' }, '2026-08-20T09:05:00Z'),
    event('event_msg', { type: 'auto_compact_completed' }, '2026-08-20T09:10:00Z'),
    JSON.stringify({ timestamp: '2026-08-20T09:15:00Z', type: 'compacted' }),
  ]);

  assert.equal(facts.compactions, 4);
});

test('a top-level compacted record still suppresses the compaction bridge summary', () => {
  const facts = collectProgressFacts([
    userLine('Fix the stale leaderboard row.', '2026-08-20T09:00:00Z'),
    JSON.stringify({ timestamp: '2026-08-20T09:20:00Z', type: 'compacted' }),
    userLine('Summary of the previous session: the callback drops nothing yet.', '2026-08-20T09:20:01Z'),
  ]);

  assert.equal(facts.compactions, 1);
  assert.equal(facts.guidanceMessages, 0);
});

test('a PowerShell call-operator read command is classified as investigation', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    shellLine('c1', ['&', 'rg', 'LeaderboardService', 'src'], '2026-08-20T09:01:00Z'),
    shellLine('c2', ['&', 'git', 'status'], '2026-08-20T09:02:00Z'),
    shellLine('c3', ['& get-childitem tests'], '2026-08-20T09:03:00Z'),
    shellLine('c4', ['&', 'dotnet', 'build'], '2026-08-20T09:04:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:05:00Z') });

  // The three read/search calls count; `& dotnet build` is not investigation.
  assert.equal(facts.currentTurnInvestigations, 3);
  assert.equal(facts.currentTurnMutations, 0);
});

test('a PowerShell call-operator mutation is still recognized as a mutation', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    shellLine('c1', ['&', 'git', 'apply', 'fix.patch'], '2026-08-20T09:01:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:02:00Z') });

  assert.equal(facts.mutations, 1);
  assert.equal(facts.currentTurnMutations, 1);
});

test('a long current turn of read/search calls with no mutation is a pre-mutation stall', () => {
  const lines = [
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    reasoningLine('The stale row comes from the leaderboard callback.', '2026-08-20T09:01:00Z'),
    ...investigationBurst(10, 'p', '2026-08-20T09:02:00Z'),
  ];

  const health = analyzeAgentHealth(lines, {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:20:00Z'),
  });

  assert.equal(health.state, 'running');
  assert.equal(health.health, 'suspicious');
  assert.ok(health.signals.some((signal) => signal.startsWith('pre_mutation_stall:')));
  assert.equal(health.progress.preMutationStall, true);
  assert.equal(health.progress.currentTurnInvestigations, 10);
  assert.equal(health.progress.currentTurnMutations, 0);
  assert.equal(health.progress.currentTurnSeconds, 1200);
  // The pre-mutation path is deliberately independent of compaction.
  assert.equal(health.progress.compactions, 0);
  assert.equal(health.progress.stalled, false);
});

test('the pre-mutation stall also fires on PowerShell call-operator searches', () => {
  const health = analyzeAgentHealth([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    ...investigationBurst(10, 'q', '2026-08-20T09:01:00Z', ['&', 'rg']),
  ], {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:20:00Z'),
  });

  assert.equal(health.progress.currentTurnInvestigations, 10);
  assert.equal(health.progress.preMutationStall, true);
  assert.equal(health.health, 'suspicious');
});

test('a current turn below the pre-mutation time threshold stays healthy', () => {
  const health = analyzeAgentHealth([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    ...investigationBurst(10, 'p', '2026-08-20T09:00:30Z'),
  ], {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:12:00Z'),
  });

  assert.equal(health.health, 'healthy');
  assert.equal(health.progress.preMutationStall, false);
  assert.equal(health.progress.currentTurnSeconds, 720);
});

test('a long current turn below the pre-mutation investigation threshold stays healthy', () => {
  const health = analyzeAgentHealth([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    ...investigationBurst(9, 'p', '2026-08-20T09:02:00Z'),
  ], {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:40:00Z'),
  });

  assert.equal(health.health, 'healthy');
  assert.equal(health.progress.preMutationStall, false);
  assert.equal(health.progress.currentTurnInvestigations, 9);
});

test('a repository mutation in the current turn clears the pre-mutation stall', () => {
  const health = analyzeAgentHealth([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    ...investigationBurst(10, 'p', '2026-08-20T09:02:00Z'),
    patchLine('m1', '2026-08-20T09:15:00Z'),
  ], {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:20:00Z'),
  });

  assert.equal(health.health, 'healthy');
  assert.equal(health.progress.preMutationStall, false);
  assert.equal(health.progress.currentTurnMutations, 1);
});

test('pre-mutation stall accounting is scoped to the current turn, not the whole rollout', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T08:00:00Z'),
    ...investigationBurst(10, 'old', '2026-08-20T08:01:00Z'),
    event('event_msg', { type: 'task_complete' }, '2026-08-20T08:30:00Z'),
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    ...investigationBurst(2, 'new', '2026-08-20T09:01:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:40:00Z') });

  assert.equal(facts.preMutationStall, false);
  assert.equal(facts.currentTurnInvestigations, 2);
  assert.equal(facts.currentTurnSeconds, 2400);
});

test('a completed turn is not reported as a pre-mutation stall', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    ...investigationBurst(10, 'p', '2026-08-20T09:02:00Z'),
    event('event_msg', { type: 'task_complete' }, '2026-08-20T09:20:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:40:00Z') });

  assert.equal(facts.preMutationStall, false);
  assert.equal(facts.currentTurnInvestigations, 10);
});

test('renewed investigation after parent guidance is a post-guidance stall without any compaction', () => {
  const lines = [
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    userLine('Fix the stale leaderboard row.', '2026-08-20T09:00:01Z'),
    patchLine('m1', '2026-08-20T09:05:00Z'),
    userLine('Stop investigating. Implement the smallest supported fix now.', '2026-08-20T09:10:00Z'),
    shellLine('g1', ['rg', 'LeaderboardService', 'src'], '2026-08-20T09:11:00Z'),
    shellLine('g2', ['rg', 'incSeason', 'src'], '2026-08-20T09:12:00Z'),
    shellLine('g3', ['get-childitem', 'tests'], '2026-08-20T09:13:00Z'),
  ];

  const facts = collectProgressFacts(lines, { nowMs: Date.parse('2026-08-20T09:14:00Z') });
  assert.equal(facts.compactions, 0);
  assert.equal(facts.guidanceMessages, 1);
  assert.equal(facts.postGuidanceStall, true);
  assert.equal(facts.investigationsSinceGuidance, 3);
  assert.equal(facts.mutationsSinceGuidance, 0);
  // Distinguishable from the compaction-based stall and from the pre-mutation path.
  assert.equal(facts.stalled, false);
  assert.equal(facts.stalledAfterGuidance, false);
  assert.equal(facts.preMutationStall, false);

  const health = analyzeAgentHealth(lines, {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:14:00Z'),
  });
  assert.equal(health.health, 'suspicious');
  assert.ok(health.signals.some((signal) => signal.startsWith('post_guidance_stall:')));
  assert.equal(health.signals.some((signal) => signal.startsWith('progress_stall:')), false);
});

test('too few read/search calls after guidance is not a post-guidance stall', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    userLine('Fix the stale leaderboard row.', '2026-08-20T09:00:01Z'),
    userLine('Stop investigating. Implement the smallest supported fix now.', '2026-08-20T09:10:00Z'),
    shellLine('g1', ['rg', 'LeaderboardService', 'src'], '2026-08-20T09:11:00Z'),
    shellLine('g2', ['rg', 'incSeason', 'src'], '2026-08-20T09:12:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:13:00Z') });

  assert.equal(facts.postGuidanceStall, false);
  assert.equal(facts.investigationsSinceGuidance, 2);
});

test('a mutation after guidance clears the post-guidance stall', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    userLine('Fix the stale leaderboard row.', '2026-08-20T09:00:01Z'),
    userLine('Stop investigating. Implement the smallest supported fix now.', '2026-08-20T09:10:00Z'),
    shellLine('g1', ['rg', 'LeaderboardService', 'src'], '2026-08-20T09:11:00Z'),
    shellLine('g2', ['rg', 'incSeason', 'src'], '2026-08-20T09:12:00Z'),
    shellLine('g3', ['get-childitem', 'tests'], '2026-08-20T09:13:00Z'),
    patchLine('m2', '2026-08-20T09:14:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:15:00Z') });

  assert.equal(facts.postGuidanceStall, false);
  assert.equal(facts.mutationsSinceGuidance, 1);
  // The read/search calls are still counted from the guidance; the mutation is
  // what clears the stall.
  assert.equal(facts.investigationsSinceGuidance, 3);
});

test('only the newest guidance scopes the post-guidance stall', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    userLine('Fix the stale leaderboard row.', '2026-08-20T09:00:01Z'),
    userLine('Stop investigating. Implement the smallest supported fix now.', '2026-08-20T09:10:00Z'),
    shellLine('g1', ['rg', 'LeaderboardService', 'src'], '2026-08-20T09:11:00Z'),
    shellLine('g2', ['rg', 'incSeason', 'src'], '2026-08-20T09:12:00Z'),
    shellLine('g3', ['get-childitem', 'tests'], '2026-08-20T09:13:00Z'),
    userLine('Good. Now also cover the season rollover case.', '2026-08-20T09:20:00Z'),
    patchLine('m1', '2026-08-20T09:21:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:22:00Z') });

  assert.equal(facts.guidanceMessages, 2);
  assert.equal(facts.postGuidanceStall, false);
  assert.equal(facts.investigationsSinceGuidance, 0);
  assert.equal(facts.mutationsSinceGuidance, 1);
});

test('short implementation transition announcements commit an implementation phase', () => {
  const committed = [
    "Now let's implement.",
    'Now let me apply the fix now.',
    'Writing the service patch.',
    'Applying the fix.',
    'Implementing the changes.',
    'Writing the fix.',
  ];
  for (const text of committed) {
    const facts = collectProgressFacts([reasoningLine(text, '2026-08-20T09:00:00Z')]);
    assert.equal(facts.implementationPhaseCommitted, true, text);
  }

  const ordinary = [
    'The implementation is more complex than it looks.',
    'We should discuss implementation details before deciding.',
    'Implementation of the parser lives in src/parse.ts.',
    'Reading the patch file to understand the change.',
  ];
  for (const text of ordinary) {
    const facts = collectProgressFacts([reasoningLine(text, '2026-08-20T09:00:00Z')]);
    assert.equal(facts.implementationPhaseCommitted, false, text);
  }
});

test('an explicit shell wrapper around a read command does not hide the investigation', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    shellLine('c1', ['pwsh', '-NoProfile', '-Command', '& rg LeaderboardService src'], '2026-08-20T09:01:00Z'),
    shellLine('c2', ['powershell.exe', '-Command', 'get-childitem tests'], '2026-08-20T09:02:00Z'),
    shellLine('c3', ['bash', '-lc', 'rg incSeason src'], '2026-08-20T09:03:00Z'),
    shellLine('c4', ['pwsh', '-Command', 'dotnet build'], '2026-08-20T09:04:00Z'),
    shellLine('c5', ['pwsh', '-Command', '& git apply fix.patch'], '2026-08-20T09:05:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:06:00Z') });

  assert.equal(facts.currentTurnInvestigations, 3);
  assert.equal(facts.currentTurnMutations, 1);
});

test('an apply_patch tool call is still the canonical mutation evidence', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    patchLine('m1', '2026-08-20T09:01:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:02:00Z') });

  assert.equal(facts.mutations, 1);
  assert.equal(facts.currentTurnMutations, 1);
  assert.equal(facts.currentTurnInvestigations, 0);
});

// The real persisted framework preamble. Codex writes one before the delegated
// task and another on each continuation turn.
function environmentContextLine(timestamp, cwd = 'C:\\repo') {
  return userLine([
    '<environment_context>',
    `  <cwd>${cwd}</cwd>`,
    '  <approval_policy>on-request</approval_policy>',
    '  <sandbox_mode>workspace-write</sandbox_mode>',
    '  <shell>pwsh</shell>',
    '</environment_context>',
  ].join('\n'), timestamp);
}

test('a framework environment_context message does not make the delegated task look like guidance', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    environmentContextLine('2026-08-20T09:00:01Z'),
    userLine('Fix the stale leaderboard row.', '2026-08-20T09:00:02Z'),
    shellLine('c1', ['rg', 'LeaderboardService', 'src'], '2026-08-20T09:01:00Z'),
    shellLine('c2', ['rg', 'incSeason', 'src'], '2026-08-20T09:02:00Z'),
    shellLine('c3', ['get-childitem', 'tests'], '2026-08-20T09:03:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:04:00Z') });

  assert.equal(facts.guidanceMessages, 0);
  assert.equal(facts.postGuidanceStall, false);
  assert.equal(facts.stalledAfterGuidance, false);
  assert.equal(facts.investigationsSinceGuidance, 0);
});

test('real parent guidance after a continuation environment_context is exactly one guidance event', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    environmentContextLine('2026-08-20T09:00:01Z'),
    userLine('Fix the stale leaderboard row.', '2026-08-20T09:00:02Z'),
    event('event_msg', { type: 'task_complete' }, '2026-08-20T09:09:00Z'),
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:10:00Z'),
    environmentContextLine('2026-08-20T09:10:01Z'),
    userLine('Stop investigating. Implement the smallest supported fix now.', '2026-08-20T09:10:02Z'),
    shellLine('g1', ['rg', 'LeaderboardService', 'src'], '2026-08-20T09:11:00Z'),
    shellLine('g2', ['rg', 'incSeason', 'src'], '2026-08-20T09:12:00Z'),
    shellLine('g3', ['get-childitem', 'tests'], '2026-08-20T09:13:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:14:00Z') });

  assert.equal(facts.guidanceMessages, 1);
  assert.equal(facts.postGuidanceStall, true);
  assert.equal(facts.investigationsSinceGuidance, 3);
  assert.equal(facts.mutationsSinceGuidance, 0);
});

test('an environment_context persisted as an event_msg user_message is ignored the same way', () => {
  const environmentContext = '<environment_context>\n  <cwd>C:\\repo</cwd>\n</environment_context>';
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    event('event_msg', { type: 'user_message', message: environmentContext }, '2026-08-20T09:00:01Z'),
    event('event_msg', { type: 'user_message', message: 'Fix the stale leaderboard row.' }, '2026-08-20T09:00:02Z'),
    shellLine('c1', ['rg', 'LeaderboardService', 'src'], '2026-08-20T09:01:00Z'),
    shellLine('c2', ['rg', 'incSeason', 'src'], '2026-08-20T09:02:00Z'),
    shellLine('c3', ['get-childitem', 'tests'], '2026-08-20T09:03:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:04:00Z') });

  assert.equal(facts.guidanceMessages, 0);
  assert.equal(facts.postGuidanceStall, false);
});

test('compaction bridge handling survives the environment_context filter', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    environmentContextLine('2026-08-20T09:00:01Z'),
    userLine('Fix the stale leaderboard row.', '2026-08-20T09:00:02Z'),
    compactionLine('2026-08-20T09:20:00Z'),
    userLine('Summary of the previous session: the callback drops nothing yet.', '2026-08-20T09:20:01Z'),
    shellLine('c1', ['rg', 'LeaderboardService', 'src'], '2026-08-20T09:21:00Z'),
    shellLine('c2', ['rg', 'incSeason', 'src'], '2026-08-20T09:22:00Z'),
    shellLine('c3', ['get-childitem', 'tests'], '2026-08-20T09:23:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:24:00Z') });

  assert.equal(facts.compactions, 1);
  assert.equal(facts.guidanceMessages, 0);
  assert.equal(facts.postGuidanceStall, false);
});

// The B2 benchmark shape: guidance, a real mutation, then prolonged
// validation-design investigation with no further edit.
function postMutationRolloutLines(investigations = 12, mutationIso = '2026-08-20T09:05:00Z') {
  return [
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    userLine('Fix the stale leaderboard row.', '2026-08-20T09:00:01Z'),
    userLine('Stop investigating. Implement the smallest supported fix now.', '2026-08-20T09:02:00Z'),
    patchLine('m1', mutationIso),
    ...investigationBurst(investigations, 'v', new Date(Date.parse(mutationIso) + 60_000).toISOString()),
  ];
}

// The literal edit mechanism from Qwen's developer prompt. Codex persists the
// whole PowerShell script, so the patch body travels with the command and the
// hyphenated flag is the only thing that identifies it as a repository write.
function codexApplyPatchLine(callId, timestamp, file = 'src/LeaderboardService.cs') {
  const script = [
    "$patch = @'",
    '*** Begin Patch',
    `*** Update File: ${file}`,
    '@@',
    '-        _rows = rows;',
    '+        if (token != _currentToken) return;',
    '*** End Patch',
    "'@",
    '& $codex --codex-run-as-apply-patch $patch',
  ].join('\n');
  return shellLine(callId, ['pwsh', '-Command', script], timestamp);
}

test('the Codex apply-patch invocation Qwen actually uses counts as a repository mutation', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    userLine('Fix the stale leaderboard row.', '2026-08-20T09:00:01Z'),
    codexApplyPatchLine('m1', '2026-08-20T09:05:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:06:00Z') });

  // Regression: '--codex-run-as-apply-patch' is hyphenated, so the underscored
  // 'apply_patch' spelling never matched it and every real Qwen edit persisted
  // as a non-mutation.
  assert.equal(facts.mutations, 1);
  assert.equal(facts.currentTurnMutations, 1);
  assert.equal(facts.currentTurnInvestigations, 0);
  assert.equal(facts.secondsSinceMutation, 60);
});

test('a Codex apply-patch edit preserves the v0.6.6 post-mutation stall behavior', () => {
  const lines = [
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    userLine('Fix the stale leaderboard row.', '2026-08-20T09:00:01Z'),
    userLine('Stop investigating. Implement the smallest supported fix now.', '2026-08-20T09:02:00Z'),
    codexApplyPatchLine('m1', '2026-08-20T09:05:00Z'),
    ...investigationBurst(12, 'v', '2026-08-20T09:06:00Z'),
  ];

  const health = analyzeAgentHealth(lines, {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:40:00Z'),
  });

  assert.equal(health.health, 'suspicious');
  assert.ok(health.signals.some((signal) => signal.startsWith('post_mutation_stall:')));
  assert.equal(health.progress.postMutationStall, true);
  assert.equal(health.progress.currentTurnMutations, 1);
  assert.equal(health.progress.investigationsSinceLatestMutation, 12);
  // The worker did mutate after guidance. Misclassifying the edit would have
  // reported this as a post-guidance stall instead, which is the replacement
  // path rather than the watchdog's first-intervention path.
  assert.equal(health.progress.postGuidanceStall, false);
  assert.equal(health.progress.mutationsSinceGuidance, 1);
  assert.equal(health.progress.preMutationStall, false);
});

test('prolonged investigation after the latest mutation is a post-mutation stall', () => {
  const lines = postMutationRolloutLines(12);

  const health = analyzeAgentHealth(lines, {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:40:00Z'),
  });

  assert.equal(health.state, 'running');
  assert.equal(health.health, 'suspicious');
  assert.ok(health.signals.some((signal) => signal.startsWith('post_mutation_stall:')));
  assert.equal(health.progress.postMutationStall, true);
  assert.equal(health.progress.investigationsSinceLatestMutation, 12);
  assert.equal(health.progress.secondsSinceMutation, 2100);
  assert.equal(health.progress.currentTurnMutations, 1);
  // The worker did mutate after guidance, so this is not a post-guidance stall,
  // and the path is deliberately independent of compaction.
  assert.equal(health.progress.postGuidanceStall, false);
  assert.equal(health.progress.mutationsSinceGuidance, 1);
  assert.equal(health.progress.preMutationStall, false);
  assert.equal(health.progress.compactions, 0);
  assert.equal(health.progress.stalled, false);
});

test('the post-mutation signal reports the elapsed minutes and the read/search count', () => {
  const health = analyzeAgentHealth(postMutationRolloutLines(12), {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:40:00Z'),
  });

  const signal = health.signals.find((entry) => entry.startsWith('post_mutation_stall:'));
  assert.equal(signal, 'post_mutation_stall: 12 read/search calls over 35m since the latest repository mutation');
});

test('a mutation newer than the post-mutation time threshold stays healthy', () => {
  const health = analyzeAgentHealth(postMutationRolloutLines(12), {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    // 29 minutes after the mutation.
    nowMs: Date.parse('2026-08-20T09:34:00Z'),
  });

  assert.equal(health.health, 'healthy');
  assert.equal(health.progress.postMutationStall, false);
  assert.equal(health.progress.secondsSinceMutation, 1740);
  assert.equal(health.progress.investigationsSinceLatestMutation, 12);
});

test('a long post-mutation gap below the investigation threshold stays healthy', () => {
  const health = analyzeAgentHealth(postMutationRolloutLines(9), {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T10:30:00Z'),
  });

  assert.equal(health.health, 'healthy');
  assert.equal(health.progress.postMutationStall, false);
  assert.equal(health.progress.investigationsSinceLatestMutation, 9);
  assert.equal(health.progress.secondsSinceMutation, 5100);
});

test('a newer mutation resets both the post-mutation window and the investigation count', () => {
  const lines = [
    ...postMutationRolloutLines(12),
    patchLine('m2', '2026-08-20T09:30:00Z'),
    ...investigationBurst(2, 'w', '2026-08-20T09:31:00Z'),
  ];

  const health = analyzeAgentHealth(lines, {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T10:20:00Z'),
  });

  assert.equal(health.health, 'healthy');
  assert.equal(health.progress.postMutationStall, false);
  // Both facts are measured from the newer mutation, not the older one.
  assert.equal(health.progress.investigationsSinceLatestMutation, 2);
  assert.equal(health.progress.secondsSinceMutation, 3000);
  assert.equal(health.progress.currentTurnMutations, 2);
});

test('build and test commands after a mutation are not investigation calls', () => {
  const lines = [
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    patchLine('m1', '2026-08-20T09:05:00Z'),
    shellLine('b1', ['dotnet', 'build'], '2026-08-20T09:06:00Z'),
    shellLine('b2', ['dotnet', 'test'], '2026-08-20T09:12:00Z'),
    shellLine('b3', ['dotnet', 'test', '--filter', 'Leaderboard'], '2026-08-20T09:18:00Z'),
    shellLine('b4', ['npm', 'test'], '2026-08-20T09:24:00Z'),
    ...investigationBurst(4, 'v', '2026-08-20T09:30:00Z'),
  ];

  const health = analyzeAgentHealth(lines, {
    agent: { agentNickname: 'qwen' },
    secondsSinceActivity: 30,
    nowMs: Date.parse('2026-08-20T09:50:00Z'),
  });

  assert.equal(health.progress.investigationsSinceLatestMutation, 4);
  assert.equal(health.progress.postMutationStall, false);
  assert.equal(health.signals.some((signal) => signal.startsWith('post_mutation_stall:')), false);
});

test('post-mutation accounting is scoped to the current turn', () => {
  const facts = collectProgressFacts([
    event('event_msg', { type: 'task_started' }, '2026-08-20T08:00:00Z'),
    patchLine('old', '2026-08-20T08:05:00Z'),
    ...investigationBurst(12, 'old', '2026-08-20T08:06:00Z'),
    event('event_msg', { type: 'task_complete' }, '2026-08-20T08:30:00Z'),
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    ...investigationBurst(2, 'new', '2026-08-20T09:01:00Z'),
  ], { nowMs: Date.parse('2026-08-20T09:40:00Z') });

  // The earlier turn's mutation and investigation burst must not poison this turn.
  assert.equal(facts.postMutationStall, false);
  assert.equal(facts.currentTurnMutations, 0);
});

test('a completed turn is not reported as a post-mutation stall', () => {
  const facts = collectProgressFacts([
    ...postMutationRolloutLines(12),
    event('event_msg', { type: 'task_complete' }, '2026-08-20T09:40:00Z'),
  ], { nowMs: Date.parse('2026-08-20T10:00:00Z') });

  assert.equal(facts.postMutationStall, false);
  assert.equal(facts.investigationsSinceLatestMutation, 12);
});

test('the post-mutation stall escalates for Qwen but not for other worker kinds', () => {
  const lines = postMutationRolloutLines(12);
  const options = { secondsSinceActivity: 30, nowMs: Date.parse('2026-08-20T09:40:00Z') };

  const qwen = analyzeAgentHealth(lines, { ...options, agent: { agentNickname: 'qwen' } });
  assert.equal(qwen.health, 'suspicious');
  assert.ok(qwen.signals.some((signal) => signal.startsWith('post_mutation_stall:')));

  for (const agent of [{ agentNickname: 'ornith' }, { agentRole: 'reviewer' }, undefined]) {
    const other = analyzeAgentHealth(lines, { ...options, agent });
    assert.equal(other.health, 'healthy');
    assert.equal(other.signals.some((signal) => signal.startsWith('post_mutation_stall:')), false);
    // The deterministic fact is still reported; only the escalation is gated.
    assert.equal(other.progress.postMutationStall, true);
  }
});

test('a Qwen worker identified by role or agent path still escalates the post-mutation stall', () => {
  const lines = postMutationRolloutLines(12);
  const options = { secondsSinceActivity: 30, nowMs: Date.parse('2026-08-20T09:40:00Z') };

  for (const agent of [{ agentRole: 'Qwen' }, { agentPath: 'C:\\agents\\qwen3-coder.toml' }]) {
    const health = analyzeAgentHealth(lines, { ...options, agent });
    assert.ok(health.signals.some((signal) => signal.startsWith('post_mutation_stall:')));
  }
});

test('the pre-mutation stall escalates for Qwen but not for other worker kinds', () => {
  const lines = [
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    ...investigationBurst(10, 'p', '2026-08-20T09:02:00Z'),
  ];
  const options = { secondsSinceActivity: 30, nowMs: Date.parse('2026-08-20T09:20:00Z') };

  const qwen = analyzeAgentHealth(lines, { ...options, agent: { agentNickname: 'qwen' } });
  assert.equal(qwen.health, 'suspicious');
  assert.ok(qwen.signals.some((signal) => signal.startsWith('pre_mutation_stall:')));

  for (const agent of [{ agentNickname: 'ornith' }, { agentRole: 'reviewer' }, undefined]) {
    const other = analyzeAgentHealth(lines, { ...options, agent });
    assert.equal(other.health, 'healthy');
    assert.equal(other.signals.some((signal) => signal.startsWith('pre_mutation_stall:')), false);
    // The deterministic fact is still reported; only the escalation is gated.
    assert.equal(other.progress.preMutationStall, true);
  }
});

test('a Qwen worker identified by role or agent path still escalates the pre-mutation stall', () => {
  const lines = [
    event('event_msg', { type: 'task_started' }, '2026-08-20T09:00:00Z'),
    ...investigationBurst(10, 'p', '2026-08-20T09:02:00Z'),
  ];
  const options = { secondsSinceActivity: 30, nowMs: Date.parse('2026-08-20T09:20:00Z') };

  for (const agent of [{ agentRole: 'Qwen' }, { agentPath: 'C:\\agents\\qwen3-coder.toml' }]) {
    const health = analyzeAgentHealth(lines, { ...options, agent });
    assert.ok(health.signals.some((signal) => signal.startsWith('pre_mutation_stall:')));
  }
});
