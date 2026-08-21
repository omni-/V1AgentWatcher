import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('supervision contract keeps parent and Luna waits inside foreground Code Mode executions', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /native V1 `wait_agent`[\s\S]*`timeout_ms=3600000`/);
  assert.match(skill, /\/\/ @exec: \{"yield_time_ms": 3600000\}[\s\S]*tools\.multi_agent_v1__wait_agent\([\s\S]*timeout_ms: 3600000/);
  assert.match(skill, /`wait_v1_agent` chunks of at most 225000 ms/);
  assert.match(skill, /\/\/ @exec: \{"yield_time_ms": 960000\}[\s\S]*tools\.mcp__v1_agent_watcher__wait_v1_agent\([\s\S]*Math\.min\(225000, healthWindowMs - elapsedMs\)/);
  assert.match(skill, /deliberate 15000 ms completion margin/);
  assert.match(skill, /900000 ms for Qwen, 300000 ms for Ornith, or 600000 ms for an unknown local worker/);
  assert.match(skill, /Repeated `wait\(cell_id\)` calls are not a normal or acceptable supervision path/);
  assert.match(skill, /unexpected Code Mode background-cell yield is an enclosing runtime failure/);
  assert.match(skill, /Code Mode yield failure contributes ZERO elapsed health-window time/);
  assert.match(skill, /still `running` with recent persisted activity must be preserved/);
});

test('the health-window contract inspects once per completed logical window', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /It does NOT trigger a health inspection by itself/);
  assert.match(skill, /Never call inspect_v1_agent_health merely because a chunk returned/);
  assert.match(skill, /exactly once per completed logical health window/);
  assert.match(skill, /four completed 225000 ms chunks produce one inspection at 900000 ms, not four inspections/);
  assert.match(skill, /reset `elapsed_health_window_ms` to 0 and `found_in_health_window` to false/);
  // The window boundary is computed by the tool, not by watchdog arithmetic.
  assert.match(skill, /health_window\.inspect_now/);
  assert.match(skill, /health_window\.missing_window/);
  assert.match(skill, /three consecutive full missing windows/);
});

test('a first progress stall continues the same worker and a repeated stall may replace it', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /NEEDS_SOL_REVIEW: worker appears active but has stalled before implementation/);
  assert.match(skill, /never justifies killing a live worker by itself/);
  assert.match(skill, /send ONE focused continuation to the SAME worker through `send_input` with `interrupt=false`/);
  assert.match(skill, /Stop investigating\. Use the diagnosis and implementation plan you already established\./);
  assert.match(skill, /Do not replace the worker and do not spawn a second worker/);
  assert.match(skill, /`progress_stall_after_guidance: true`[\s\S]*replacement becomes justified/);
  assert.match(skill, /implement the smallest fix supported by the original task/);
  assert.match(skill, /Do not add progress polling/);
});

test('local-worker spawns do not request an unsupported granular reasoning level', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /Do not pass an explicit granular `reasoning_effort` when the worker runs on a local OpenAI-compatible provider/);
  assert.match(skill, /Omit `reasoning_effort` in the spawn call so no unsupported value is forwarded/);
  assert.match(skill, /Reasoning stays enabled through the provider's own fallback/);
  assert.match(skill, /treat the chosen level as not honored/);
  // The worker spawn contract must not name a granular level for the local worker.
  const spawnContract = skill.slice(0, skill.indexOf('## Post-run accounting'));
  assert.equal(/reasoning[_ ]effort\s*[:=]\s*"?(low|medium|high|xhigh)"?/i.test(spawnContract), false);
});
