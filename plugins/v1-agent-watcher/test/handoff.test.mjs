import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildWorkerHandoff,
  collectHandoffFacts,
  summarizeWorkerHandoff,
} from '../mcp/watcher.mjs';

function qwenMeta(overrides = {}) {
  return {
    id: 'worker',
    parent_thread_id: 'sol',
    cwd: 'C:\\repo',
    model_provider: 'lmstudio',
    agent_nickname: 'qwen',
    multi_agent_version: 'v1',
    source: { subagent: { thread_spawn: { parent_thread_id: 'sol', depth: 1 } } },
    ...overrides,
  };
}

async function makeRollout(root, name, meta, records = []) {
  const dir = path.join(root, 'sessions', '2026', '08', '21');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const lines = [
    { timestamp: '2026-08-21T08:00:00Z', type: 'session_meta', payload: meta },
    ...records,
  ];
  await fs.writeFile(file, `${lines.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return file;
}

async function temporaryCodexHome(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v1-agent-watcher-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function event(type, payload, timestamp = '2026-08-21T08:10:00Z') {
  return { timestamp, type: 'event_msg', payload: { type, ...payload } };
}

function item(payload, timestamp = '2026-08-21T08:10:00Z') {
  return { timestamp, type: 'response_item', payload };
}

function applyPatchCall(callId, patch) {
  return item({
    type: 'function_call',
    call_id: callId,
    name: 'apply_patch',
    arguments: JSON.stringify({ input: patch }),
  });
}

function userMessage(text) {
  return item({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
}

function assistantMessage(text) {
  return item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
}

function cleanRun(overrides = {}) {
  return [
    event('task_started', {}),
    userMessage('<environment_context> cwd=C:\\repo </environment_context>'),
    userMessage('Fix the null dereference in the session loader.'),
    applyPatchCall('c1', '*** Begin Patch\n*** Update File: src/loader.mjs\n@@\n-old\n+new\n*** End Patch'),
    item({ type: 'function_call_output', call_id: 'c1', output: 'Success. Updated the following files:\nM src/loader.mjs' }),
    event('exec_command_begin', { call_id: 'v1', command: ['npm', 'test'] }),
    event('exec_command_end', { call_id: 'v1', exit_code: overrides.testExitCode ?? 0 }),
    assistantMessage('Root cause: the loader read the session map before it was populated. Fixed by deferring the read; npm test passes.'),
    event('task_complete', {}),
  ];
}

test('a healthy completed worker produces a clean compact handoff', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-worker.jsonl', qwenMeta(), cleanRun());

  const handoff = await summarizeWorkerHandoff({ codexHome: root, threadId: 'worker' });

  assert.equal(handoff.worker_thread_id, 'worker');
  assert.equal(handoff.worker_status, 'completed');
  assert.equal(handoff.material_concern, false);
  assert.equal(handoff.parent_action, 'use_handoff');
  assert.deepEqual(handoff.warnings, []);
  // The delegated task is the first real user message, not the framework preamble.
  assert.equal(handoff.task_summary, 'Fix the null dereference in the session loader.');
  assert.match(handoff.result_summary, /^Root cause: the loader read the session map/);
  assert.deepEqual(handoff.files_changed, ['src/loader.mjs']);
  assert.equal(handoff.verification_performed, true);
  assert.deepEqual(handoff.verification, [{ command: 'npm test', outcome: 'passed' }]);
  assert.deepEqual(handoff.watchdog, { intervened: false, interventions: 0, note: null, concern: null });
});

test('the handoff carries no transcript, reasoning trace, or command output', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-worker.jsonl', qwenMeta(), [
    event('task_started', {}),
    userMessage('Do the thing.'),
    item({ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'A long internal deliberation that must never reach the parent.' }] }),
    event('exec_command_begin', { call_id: 'r1', command: ['rg', 'session', 'src'] }),
    event('exec_command_end', { call_id: 'r1', exit_code: 0, aggregated_output: 'src/loader.mjs:12: session' }),
    applyPatchCall('c1', '*** Begin Patch\n*** Update File: src/loader.mjs\n*** End Patch'),
    assistantMessage('X'.repeat(5000)),
    event('task_complete', {}),
  ]);

  const handoff = await summarizeWorkerHandoff({ codexHome: root, threadId: 'worker', textLimit: 300 });
  const serialized = JSON.stringify(handoff);

  assert.equal(handoff.result_summary.length, 300);
  assert.equal(/internal deliberation/.test(serialized), false);
  assert.equal(/src\/loader\.mjs:12/.test(serialized), false);
  // Read/search calls are not verification and never enter the handoff.
  assert.deepEqual(handoff.verification, []);
  assert.equal('events' in handoff, false);
});

test('a failed verification is a material warning the parent can investigate selectively', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-worker.jsonl', qwenMeta(), cleanRun({ testExitCode: 1 }));

  const handoff = await summarizeWorkerHandoff({ codexHome: root, threadId: 'worker' });

  assert.equal(handoff.worker_status, 'completed');
  assert.deepEqual(handoff.verification, [{ command: 'npm test', outcome: 'failed' }]);
  assert.equal(handoff.material_concern, true);
  assert.equal(handoff.parent_action, 'review_concern');
  assert.deepEqual(handoff.warnings, ['verification_failed: npm test']);
});

test('an aborted worker is reported as materially concerning', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-worker.jsonl', qwenMeta(), [
    event('task_started', {}),
    userMessage('Do the thing.'),
    event('turn_aborted', { reason: 'provider disconnected' }),
  ]);

  const handoff = await summarizeWorkerHandoff({ codexHome: root, threadId: 'worker' });

  assert.equal(handoff.worker_status, 'aborted');
  assert.equal(handoff.material_concern, true);
  assert.equal(handoff.parent_action, 'review_concern');
  assert.ok(handoff.warnings.some((warning) => warning.startsWith('worker_status: rollout state is aborted')));
  assert.ok(handoff.warnings.some((warning) => warning.includes('provider disconnected')));
});

test('a watchdog intervention is recorded without becoming a concern on its own', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-worker.jsonl', qwenMeta(), cleanRun());

  const handoff = await summarizeWorkerHandoff({
    codexHome: root,
    threadId: 'worker',
    watchdog: { interventions: 1, note: 'Sent the post-mutation continuation after a 32m validation detour.' },
  });

  assert.equal(handoff.watchdog.intervened, true);
  assert.equal(handoff.watchdog.interventions, 1);
  assert.match(handoff.watchdog.note, /post-mutation continuation/);
  // A recovered worker is not a reason to send the parent back into the run.
  assert.equal(handoff.material_concern, false);
  assert.equal(handoff.parent_action, 'use_handoff');
});

test('an explicit watchdog concern routes the parent to selective review', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-worker.jsonl', qwenMeta(), cleanRun());

  const handoff = await summarizeWorkerHandoff({
    codexHome: root,
    threadId: 'worker',
    watchdog: { interventions: 1, concern: 'The worker widened the patch beyond the requested loader fix.' },
  });

  assert.equal(handoff.material_concern, true);
  assert.equal(handoff.parent_action, 'review_concern');
  assert.ok(handoff.warnings.some((warning) => warning.startsWith('watchdog_concern: The worker widened the patch')));
});

test('a suspicious health screen forwards its signals as handoff warnings', () => {
  const facts = collectHandoffFacts([]);
  const handoff = buildWorkerHandoff({
    threadId: 'worker',
    state: 'running',
    health: { state: 'running', health: 'suspicious', signals: ['post_guidance_stall: 4 read/search calls since parent guidance with no repository mutation'] },
    facts,
  });

  assert.equal(handoff.material_concern, true);
  assert.equal(handoff.parent_action, 'review_concern');
  assert.ok(handoff.warnings.some((warning) => warning.startsWith('health_signal: post_guidance_stall')));
});

test('shell mutations name their files and unreadable-only facts stay non-material', () => {
  const facts = collectHandoffFacts([
    JSON.stringify(event('task_started', {})),
    JSON.stringify(event('exec_command_begin', { call_id: 'm1', command: ['pwsh', '-Command', 'Set-Content -Path src/b.mjs -Value x'] })),
    JSON.stringify(event('exec_command_end', { call_id: 'm1', exit_code: 0 })),
    JSON.stringify(event('task_complete', {})),
  ]);

  assert.deepEqual(facts.filesChanged, ['src/b.mjs']);
  assert.equal(facts.mutationCalls, 1);

  const handoff = buildWorkerHandoff({ threadId: 'worker', state: 'idle', facts });
  // No build/test command ran, which is reported but is not itself a concern.
  assert.deepEqual(handoff.warnings, ['verification_missing: no persisted build/test command in this rollout']);
  assert.equal(handoff.material_concern, false);
  assert.equal(handoff.parent_action, 'use_handoff');
});

test('an unknown worker thread yields no handoff rather than a guess', async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-worker.jsonl', qwenMeta(), cleanRun());

  assert.equal(await summarizeWorkerHandoff({ codexHome: root, threadId: 'absent' }), null);
});

// The literal edit mechanism from Qwen's developer prompt: Codex persists the
// whole PowerShell script, so the patch body travels with the command.
function codexApplyPatchCommand(file) {
  return [
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
}

test("the Codex apply-patch invocation Qwen actually uses names its file in the handoff", async (t) => {
  const root = await temporaryCodexHome(t);
  await makeRollout(root, 'rollout-worker.jsonl', qwenMeta(), [
    event('task_started', {}),
    userMessage('Fix the stale leaderboard row.'),
    event('exec_command_begin', { call_id: 'm1', command: ['pwsh', '-Command', codexApplyPatchCommand('src/LeaderboardService.cs')] }),
    event('exec_command_end', { call_id: 'm1', exit_code: 0 }),
    event('exec_command_begin', { call_id: 'v1', command: ['dotnet', 'test'] }),
    event('exec_command_end', { call_id: 'v1', exit_code: 0 }),
    assistantMessage('Root cause: the leaderboard callback applied a stale response. Guarded on the request token; dotnet test passes.'),
    event('task_complete', {}),
  ]);

  const handoff = await summarizeWorkerHandoff({ codexHome: root, threadId: 'worker' });

  // Regression: the flag is hyphenated, so the underscored 'apply_patch'
  // spelling never matched it. A successful real Qwen run then reported an
  // empty files_changed and a spurious no_mutation warning.
  assert.deepEqual(handoff.files_changed, ['src/LeaderboardService.cs']);
  assert.deepEqual(handoff.verification, [{ command: 'dotnet test', outcome: 'passed' }]);
  assert.deepEqual(handoff.warnings, []);
  assert.equal(handoff.material_concern, false);
  assert.equal(handoff.parent_action, 'use_handoff');
});

test('a Codex apply-patch edit is a mutation, not an investigation call', () => {
  const facts = collectHandoffFacts([
    JSON.stringify(event('task_started', {})),
    JSON.stringify(event('exec_command_begin', {
      call_id: 'm1',
      command: ['pwsh', '-Command', codexApplyPatchCommand('src/loader.mjs')],
    })),
    JSON.stringify(event('exec_command_end', { call_id: 'm1', exit_code: 0 })),
    JSON.stringify(event('task_complete', {})),
  ]);

  assert.equal(facts.mutationCalls, 1);
  assert.deepEqual(facts.filesChanged, ['src/loader.mjs']);
  // The patch body is never mistaken for a build/test command.
  assert.deepEqual(facts.verification, []);
});
