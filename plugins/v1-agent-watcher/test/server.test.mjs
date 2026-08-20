import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('MCP exposes compact deterministic health inspection', async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'v1-agent-watcher-mcp-'));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '20');
  await fs.mkdir(sessions, { recursive: true });
  const records = [
    {
      timestamp: '2026-08-20T08:00:00Z',
      type: 'session_meta',
      payload: {
        id: 'qwen-thread', parent_thread_id: 'parent', cwd: 'C:\\repo',
        model_provider: 'lmstudio', agent_nickname: 'qwen', multi_agent_version: 'v1',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } },
      },
    },
    { timestamp: '2026-08-20T08:00:01Z', type: 'event_msg', payload: { type: 'task_started' } },
  ];
  await fs.writeFile(
    path.join(sessions, 'rollout-qwen.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );

  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = spawn(process.execPath, [path.join(pluginRoot, 'mcp', 'server.mjs')], {
    cwd: pluginRoot,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());

  const pending = new Map();
  const output = readline.createInterface({ input: server.stdout, crlfDelay: Infinity });
  output.on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  const rpc = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 5000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  await rpc(1, 'initialize', { protocolVersion: '2025-11-25' });
  const listed = await rpc(2, 'tools/list');
  assert.ok(listed.result.tools.some((tool) => tool.name === 'inspect_v1_agent_health'));

  const inspected = await rpc(3, 'tools/call', {
    name: 'inspect_v1_agent_health',
    arguments: { thread_id: 'qwen-thread', provider: 'lmstudio' },
  });
  assert.equal(inspected.result.isError, undefined);
  const health = JSON.parse(inspected.result.content[0].text);
  assert.equal(health.thread, 'qwen-thread');
  assert.equal(health.state, 'running');
  assert.equal(health.health, 'healthy');
  assert.equal('events' in health, false);
});
