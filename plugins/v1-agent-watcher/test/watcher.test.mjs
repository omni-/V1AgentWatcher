import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeAgentHealth,
  inspectAgentHealth,
  inspectAgentSession,
  listAgentSessions,
  summarizeRolloutLines,
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
    secondsSinceActivity: 20 * 60,
  });
  assert.equal(health.state, 'running');
  assert.equal(health.health, 'healthy');
  assert.deepEqual(health.signals, []);
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

test('repeated context compaction is surfaced as a health signal', () => {
  const health = analyzeAgentHealth([
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
  ], { agent: { agentNickname: 'qwen' }, secondsSinceActivity: 30 });

  assert.equal(health.health, 'suspicious');
  assert.ok(health.signals.some((signal) => signal.startsWith('context_compaction:')));
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
