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
  const currentTimestamp = new Date().toISOString();
  const records = [
    {
      timestamp: currentTimestamp,
      type: 'session_meta',
      payload: {
        id: 'qwen-thread', parent_thread_id: 'parent', cwd: 'C:\\repo',
        model_provider: 'lmstudio', agent_nickname: 'qwen', multi_agent_version: 'v1',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } },
      },
    },
    { timestamp: currentTimestamp, type: 'event_msg', payload: { type: 'task_started' } },
    {
      timestamp: currentTimestamp, type: 'event_msg', payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0,
            output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 120,
          },
          last_token_usage: {
            input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0,
            output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 120,
          },
          model_context_window: 258400,
        },
        rate_limits: null,
      },
    },
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

  const initialized = await rpc(1, 'initialize', { protocolVersion: '2025-11-25' });
  assert.equal(initialized.result.serverInfo.version, '0.6.2');
  const listed = await rpc(2, 'tools/list');
  assert.ok(listed.result.tools.some((tool) => tool.name === 'inspect_v1_agent_health'));
  assert.ok(listed.result.tools.some((tool) => tool.name === 'wait_v1_agent'));
  assert.ok(listed.result.tools.some((tool) => tool.name === 'inspect_v1_agent_usage'));
  assert.ok(listed.result.tools.some((tool) => tool.name === 'inspect_v1_supervision_usage'));
  const waitTool = listed.result.tools.find((tool) => tool.name === 'wait_v1_agent');
  assert.equal(waitTool.inputSchema.properties.timeout_ms.maximum, 225000);
  assert.equal(waitTool.inputSchema.properties.timeout_ms.default, 225000);

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

  await fs.appendFile(
    path.join(sessions, 'rollout-qwen.jsonl'),
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`,
    'utf8',
  );
  const waited = await rpc(5, 'tools/call', {
    name: 'wait_v1_agent',
    arguments: { thread_id: 'qwen-thread', timeout_ms: 1000 },
  });
  assert.equal(waited.result.isError, undefined);
  assert.equal(waited.result.structuredContent.outcome, 'completed');
  assert.equal(waited.result.structuredContent.threadId, 'qwen-thread');

  const usage = await rpc(4, 'tools/call', {
    name: 'inspect_v1_agent_usage',
    arguments: { thread_id: 'qwen-thread' },
  });
  assert.equal(usage.result.isError, undefined);
  const accounting = JSON.parse(usage.result.content[0].text);
  assert.equal(accounting.thread, 'qwen-thread');
  assert.equal(accounting.cumulative.effective_tokens, 80);
  assert.equal(usage.result.structuredContent.thread, 'qwen-thread');
});
