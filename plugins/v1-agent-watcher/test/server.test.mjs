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
  assert.equal(initialized.result.serverInfo.version, '0.7.0');
  const listed = await rpc(2, 'tools/list');
  assert.ok(listed.result.tools.some((tool) => tool.name === 'inspect_v1_agent_health'));
  assert.ok(listed.result.tools.some((tool) => tool.name === 'wait_v1_agent'));
  assert.ok(listed.result.tools.some((tool) => tool.name === 'inspect_v1_agent_usage'));
  assert.ok(listed.result.tools.some((tool) => tool.name === 'inspect_v1_supervision_usage'));
  assert.ok(listed.result.tools.some((tool) => tool.name === 'summarize_v1_worker_handoff'));
  const handoffTool = listed.result.tools.find((tool) => tool.name === 'summarize_v1_worker_handoff');
  assert.deepEqual(handoffTool.inputSchema.required, ['thread_id']);
  assert.equal(handoffTool.inputSchema.properties.watchdog_interventions.default, 0);
  assert.equal(handoffTool.inputSchema.properties.text_limit.maximum, 4000);
  const waitTool = listed.result.tools.find((tool) => tool.name === 'wait_v1_agent');
  assert.equal(waitTool.inputSchema.properties.timeout_ms.maximum, 225000);
  assert.equal(waitTool.inputSchema.properties.timeout_ms.default, 225000);
  assert.ok(waitTool.inputSchema.properties.health_window_ms);
  assert.equal(waitTool.inputSchema.properties.elapsed_health_window_ms.default, 0);
  assert.equal(waitTool.inputSchema.properties.found_in_health_window.default, false);

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
  assert.equal(health.progress.progress_stall, false);
  assert.equal(health.progress.compactions_since_mutation, 0);
  assert.equal(health.progress.seconds_since_mutation, null);
  assert.equal(health.progress.post_mutation_stall, false);
  assert.equal(health.progress.investigations_since_latest_mutation, 0);

  // Regression for the benchmark failure: the watchdog read the accumulator
  // back from the returned health_window using the input argument names, got
  // undefined, and resent zero state on every chunk. A timeout response must
  // therefore expose both spellings with identical values.
  const timedOut = await rpc(7, 'tools/call', {
    name: 'wait_v1_agent',
    arguments: {
      thread_id: 'qwen-thread',
      timeout_ms: 1000,
      health_window_ms: 900000,
      elapsed_health_window_ms: 450000,
      found_in_health_window: true,
    },
  });
  assert.equal(timedOut.result.isError, undefined);
  assert.equal(timedOut.result.structuredContent.outcome, 'timeout');
  const timedOutWindow = timedOut.result.structuredContent.health_window;
  assert.ok(timedOutWindow.elapsed_ms > 450000);
  assert.equal(timedOutWindow.elapsed_health_window_ms, timedOutWindow.elapsed_ms);
  assert.equal(timedOutWindow.found_in_window, true);
  assert.equal(timedOutWindow.found_in_health_window, timedOutWindow.found_in_window);
  // A Code Mode client may parse the text content instead of structuredContent,
  // so the aliases must survive serialization too.
  const timedOutText = JSON.parse(timedOut.result.content[0].text).health_window;
  assert.equal(timedOutText.elapsed_health_window_ms, timedOutText.elapsed_ms);
  assert.equal(timedOutText.found_in_health_window, timedOutText.found_in_window);

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
  assert.equal('health_window' in waited.result.structuredContent, false);

  const windowed = await rpc(6, 'tools/call', {
    name: 'wait_v1_agent',
    arguments: {
      thread_id: 'qwen-thread',
      timeout_ms: 1000,
      health_window_ms: 900000,
      elapsed_health_window_ms: 675000,
      found_in_health_window: true,
    },
  });
  // A non-timeout chunk contributes no elapsed health-window time and never
  // reaches the inspection boundary by itself.
  const window = windowed.result.structuredContent.health_window;
  assert.equal(window.elapsed_ms, 675000);
  assert.equal(window.remaining_ms, 225000);
  assert.equal(window.next_chunk_ms, 225000);
  assert.equal(window.inspect_now, false);
  assert.equal(window.missing_window, false);
  assert.equal(window.elapsed_health_window_ms, window.elapsed_ms);
  assert.equal(window.found_in_health_window, window.found_in_window);

  const usage = await rpc(4, 'tools/call', {
    name: 'inspect_v1_agent_usage',
    arguments: { thread_id: 'qwen-thread' },
  });
  assert.equal(usage.result.isError, undefined);
  const accounting = JSON.parse(usage.result.content[0].text);
  assert.equal(accounting.thread, 'qwen-thread');
  assert.equal(accounting.cumulative.effective_tokens, 80);
  assert.equal(usage.result.structuredContent.thread, 'qwen-thread');

  // v0.7.0: one compact handoff replaces the parent rereading the worker.
  const handoff = await rpc(8, 'tools/call', {
    name: 'summarize_v1_worker_handoff',
    arguments: { thread_id: 'qwen-thread' },
  });
  assert.equal(handoff.result.isError, undefined);
  const summary = handoff.result.structuredContent;
  assert.equal(summary.worker_thread_id, 'qwen-thread');
  assert.equal(summary.worker_status, 'completed');
  assert.equal(summary.material_concern, false);
  assert.equal(summary.parent_action, 'use_handoff');
  assert.equal(summary.watchdog.intervened, false);
  assert.equal(summary.watchdog.interventions, 0);
  assert.deepEqual(summary.files_changed, []);
  // The text content must carry the same handoff for a Code Mode client that
  // parses content instead of structuredContent.
  assert.deepEqual(JSON.parse(handoff.result.content[0].text), summary);
  // A handoff is a summary, not a transcript: no event stream is exposed.
  assert.equal('events' in summary, false);
  assert.equal('recent_summary' in summary, false);

  const missingHandoff = await rpc(9, 'tools/call', {
    name: 'summarize_v1_worker_handoff',
    arguments: { thread_id: 'no-such-thread' },
  });
  assert.equal(missingHandoff.result.isError, true);
});
