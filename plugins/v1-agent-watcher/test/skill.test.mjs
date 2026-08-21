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

test('local-worker reasoning documents inheritance rather than claiming omission suppresses the warning', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /Do not pass an explicit granular `reasoning_effort` when the worker runs on a local OpenAI-compatible provider/);
  // V1 declares `Omit to inherit the parent effort`, so omission still forwards
  // a granular value. The contract must not claim otherwise.
  assert.match(skill, /\*\*Omitting `reasoning_effort` does not avoid this\.\*\*/);
  assert.match(skill, /Omission inherits the parent's current effort/);
  assert.match(skill, /The V1 effort enum has no provider-native `on` value/);
  assert.match(skill, /the provider reports it as unsupported and falls back to `on`/);
  assert.match(skill, /Omission is the honest default, not a fix for the warning/);
  assert.equal(/omit[^.]{0,80}so no unsupported value is forwarded/i.test(skill), false);
  // The worker spawn contract must not name a granular level for the local worker.
  const spawnContract = skill.slice(0, skill.indexOf('## Local-worker reasoning configuration'));
  assert.equal(/reasoning[_ ]effort\s*[:=]\s*"?(low|medium|high|xhigh)"?/i.test(spawnContract), false);
});

test('the contract documents the compaction-independent stall signals and their thresholds', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /### pre_mutation_stall/);
  assert.match(skill, /the current turn has been running for at least 15 minutes/);
  assert.match(skill, /at least 10 investigation\/read\/search calls in that turn/);
  assert.match(skill, /### post_guidance_stall/);
  assert.match(skill, /at least 3 investigation\/read\/search calls since that guidance/);
  assert.match(skill, /It requires no compaction and no implementation-phase phrase/);
  assert.match(skill, /Only the newest guidance is in scope/);
  assert.match(skill, /a top-level `\{"type":"compacted"\}` record/);
  assert.match(skill, /`& rg \.\.\.`/);
  // The two new signals must be separately actionable for the watchdog.
  assert.match(skill, /signals include `progress_stall` or `pre_mutation_stall`/);
  assert.match(skill, /NEEDS_SOL_REVIEW: worker resumed investigating after parent guidance without mutating the repository/);
  assert.match(skill, /`post_guidance_stall: true`[\s\S]*replacement becomes justified/);
});

test('the supervision cadence is unchanged by the new stall signals', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /900000 ms for Qwen, 300000 ms for Ornith, or 600000 ms for an unknown local worker/);
  assert.match(skill, /do not shorten the window or add extra polling to find them sooner/);
  assert.match(skill, /Do not add progress polling/);
});

test('the contract scopes the pre-mutation stall to Qwen and excludes framework preambles from guidance', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /only a Qwen worker escalates on it/);
  assert.match(skill, /For Ornith and unknown local workers the fact is still reported/);
  assert.match(skill, /not a framework `<environment_context>` preamble/);
});

test('the watchdog checks post_guidance_stall before the first-stall signals', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  const postGuidance = skill.indexOf('signals include `post_guidance_stall`');
  const firstStall = skill.indexOf('signals include `progress_stall` or `pre_mutation_stall`');
  assert.ok(postGuidance > 0 && firstStall > 0);
  // A worker stalling after guidance raises the first-stall signals too, so the
  // weaker line must not be able to match first and hide the repeated stall.
  assert.ok(postGuidance < firstStall, 'post_guidance_stall must be checked first');
  assert.match(skill, /Check the stall signals in this order and return on the first match/);
});

test('the contract separates health-window input argument names from returned field names', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /elapsed_health_window_ms\s+<-\s+health_window\.elapsed_ms/);
  assert.match(skill, /found_in_health_window\s+<-\s+health_window\.found_in_window/);
  assert.match(skill, /`elapsed_health_window_ms` and `found_in_health_window` are input argument\s+names/);
  // The parent prompt must carry the assignment itself, not a paraphrase that
  // lets Luna infer the returned fields use the input argument names.
  assert.match(skill, /elapsed_health_window_ms = result\.health_window\.elapsed_ms/);
  assert.match(skill, /found_in_health_window\s+= result\.health_window\.found_in_window/);
  assert.match(skill, /Include the health-window accumulator mapping and its two assignment lines verbatim/);
  assert.match(skill, /Never re-send\s+`elapsed_health_window_ms: 0` after a completed chunk/);
  // The canonical loop keeps reading the canonical fields.
  assert.match(skill, /elapsedMs = last\.health_window\.elapsed_ms;/);
  assert.match(skill, /foundInWindow = last\.health_window\.found_in_window;/);
});
