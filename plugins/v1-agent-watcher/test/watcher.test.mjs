import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  inspectAgentSession,
  listAgentSessions,
  summarizeRolloutLines,
} from '../mcp/watcher.mjs';

async function makeRollout(root, name, meta, lines = []) {
  const dir = path.join(root, 'sessions', '2026', '08', '20');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const records = [
    { timestamp: '2026-08-20T08:00:00Z', type: 'session_meta', payload: meta },
    ...lines,
  ];
  await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return file;
}

test('lists only collaboration child rollouts and filters provider/cwd', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v1-agent-watcher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await makeRollout(root, 'rollout-root.jsonl', {
    id: 'root', parent_thread_id: null, cwd: 'C:\\repo', model_provider: 'openai',
  });
  await makeRollout(root, 'rollout-internal.jsonl', {
    id: 'internal', parent_thread_id: 'root', cwd: 'C:\\repo', model_provider: 'openai',
    multi_agent_version: 'disabled', source: { internal: 'guardian' },
  });
  await makeRollout(root, 'rollout-child.jsonl', {
    id: 'child', parent_thread_id: 'root', cwd: 'C:\\repo', model_provider: 'lmstudio',
    agent_nickname: 'ornith', multi_agent_version: 'v1',
    source: { sub_agent: { thread_spawn: { parent_thread_id: 'root' } } },
  });

  const agents = await listAgentSessions({ codexHome: root });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].threadId, 'child');
  assert.equal(agents[0].agentNickname, 'ornith');

  const localAgents = await listAgentSessions({ codexHome: root, provider: 'lmstudio' });
  assert.equal(localAgents.length, 1);
  assert.equal(localAgents[0].threadId, 'child');
});

test('extracts reasoning and tool activity and de-duplicates adjacent copies', () => {
  const lines = [
    JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'turn_started' } }),
    JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Inspect the handler first.' } }),
    JSON.stringify({ timestamp: 't3', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspect the handler first.' }] } }),
    JSON.stringify({ timestamp: 't4', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg incSeason"}' } }),
    JSON.stringify({ timestamp: 't5', type: 'event_msg', payload: { type: 'turn_complete' } }),
  ];

  const summary = summarizeRolloutLines(lines, { eventLimit: 10 });
  assert.equal(summary.status, 'idle');
  assert.equal(summary.events.filter((event) => event.kind === 'reasoning').length, 1);
  assert.match(summary.events.find((event) => event.kind === 'tool_call').text, /rg incSeason/);
});

test('extracts and coalesces raw reasoning delta events', () => {
  const lines = [
    JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { type: 'reasoning_raw_content_delta', item_id: 'reason-1', delta: 'The race ' } }),
    JSON.stringify({ timestamp: 't3', type: 'event_msg', payload: { type: 'reasoning_raw_content_delta', item_id: 'reason-1', delta: 'can interleave across await.' } }),
  ];

  const summary = summarizeRolloutLines(lines, { eventLimit: 10 });
  assert.equal(summary.status, 'running');
  const reasoning = summary.events.find((event) => event.kind === 'reasoning');
  assert.ok(reasoning);
  assert.match(reasoning.text, /The race can interleave across await/);
});

test('recognizes v1 task lifecycle event names', () => {
  const lines = [
    JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { type: 'task_complete' } }),
  ];

  const summary = summarizeRolloutLines(lines, { eventLimit: 10 });
  assert.equal(summary.status, 'idle');
});

test('inspects latest collaboration child session', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v1-agent-watcher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await makeRollout(root, 'rollout-child.jsonl', {
    id: 'child', parent_thread_id: 'root', cwd: 'C:\\repo', model_provider: 'lmstudio',
    agent_path: '/root/worker', multi_agent_version: 'v1',
    source: { sub_agent: { thread_spawn: { parent_thread_id: 'root' } } },
  }, [
    { timestamp: '2026-08-20T08:00:01Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-08-20T08:00:02Z', type: 'response_item', payload: { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'I should build before finishing.' }], summary: [] } },
  ]);

  const result = await inspectAgentSession({ codexHome: root, provider: 'lmstudio' });
  assert.equal(result.agent.threadId, 'child');
  assert.equal(result.status, 'running');
  assert.match(result.events.at(-1).text, /build before finishing/);
});
