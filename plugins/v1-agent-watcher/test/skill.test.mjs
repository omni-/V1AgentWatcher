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

  // The watchdog now owns the first stall, so it corrects the worker itself
  // instead of returning a parent escalation for it.
  assert.match(skill, /signals include `progress_stall` or `pre_mutation_stall`, intervene yourself using the first-stall continuation below/);
  assert.equal(/NEEDS_SOL_REVIEW: worker appears active but has stalled before implementation/.test(skill), false);
  assert.match(skill, /never justifies killing a live worker by itself/);
  assert.match(skill, /send ONE focused continuation to the SAME worker through `send_input` with `interrupt=false`/);
  assert.match(skill, /Stop investigating\. Use the diagnosis and implementation plan you already established\./);
  assert.match(skill, /Do not replace the worker and do not spawn a second worker/);
  assert.match(skill, /`progress_stall_after_guidance: true`[\s\S]*replacement becomes justified/);
  assert.match(skill, /implement the smallest fix supported by the original task/);
  assert.match(skill, /Do not add progress polling/);
});

test('Qwen delegation requires the registered qwen role and forbids a worker model override', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /## Worker role selection/);
  assert.match(skill, /For Qwen delegation, spawn the registered `qwen` agent type\/role\./);
  assert.match(skill, /Never emulate the Qwen role by spawning `agent_type="worker"` with `model="qwen3\.8-27b-uncensored-sharp"`/);
  // A model override carries no role configuration, so the local model is
  // routed through the parent's provider.
  assert.match(skill, /does not carry the role's `model_provider="lmstudio"` configuration/);
  assert.match(skill, /fail immediately and report that the configured Qwen role is unavailable/);
  assert.match(skill, /Do not substitute `worker` plus a Qwen model override/);
  // The spawn contract itself must carry the rule, not only the later section.
  const spawnContract = skill.slice(0, skill.indexOf('## Worker role selection'));
  assert.match(spawnContract, /never emulate it with a generic\s+`worker` spawn plus a Qwen model override/);
  // The Luna model-only spawn must not be readable as precedent for the worker.
  assert.match(skill, /That model-only spawn is specific to the watchdog/);
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

test('the watchdog recognizes the post-mutation stall between the guidance and first-stall cases', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  const postGuidance = skill.indexOf('signals include `post_guidance_stall`');
  const postMutation = skill.indexOf('signals include `post_mutation_stall`');
  const firstStall = skill.indexOf('signals include `progress_stall` or `pre_mutation_stall`');
  assert.ok(postGuidance > 0 && postMutation > 0 && firstStall > 0);
  // Explicit guidance followed by renewed investigation stays the strongest
  // case, and a worker that already mutated must not be reported as one that
  // never reached implementation.
  assert.ok(postGuidance < postMutation, 'post_guidance_stall must be checked first');
  assert.ok(postMutation < firstStall, 'post_mutation_stall must be checked before the first-stall branch');
  assert.match(skill, /`post_guidance_stall`, then\s+`post_mutation_stall`, then `progress_stall`\/`pre_mutation_stall`/);
  // The post-mutation stall is watchdog-owned intervention in v0.7.0, not a
  // parent escalation, while the post-guidance stall still wakes the parent.
  assert.match(skill, /signals include `post_mutation_stall`, intervene yourself using the post-mutation continuation below/);
  assert.equal(/NEEDS_SOL_REVIEW: worker changed the repository but has spent too long investigating without further mutation/.test(skill), false);
});

test('the contract documents the post-mutation stall thresholds and its newest-mutation reset', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /### post_mutation_stall/);
  assert.match(skill, /at least 30 minutes have elapsed since the newest mutation/);
  assert.match(skill, /at least 10 investigation\/read\/search calls occurred after that newest mutation/);
  assert.match(skill, /The newest mutation is the reset point, so a later edit restarts both the elapsed window and the investigation count/);
  assert.match(skill, /It requires no compaction, no implementation-phase phrase, no parent guidance, no failed command, and no repeated command/);
  // Qwen-only escalation, matching the pre-mutation precedent.
  assert.match(skill, /only a Qwen worker escalates on it; for Ornith and unknown local workers the fact is reported/);
  // seconds_since_mutation already carries the elapsed fact and is reused.
  assert.match(skill, /`investigations_since_latest_mutation`, alongside the existing `seconds_since_mutation`/);
});

test('a first post-mutation stall keeps the same worker and only a later post-guidance stall may replace it', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /### First post-mutation stall: continue the same worker/);
  // Earlier guidance plus a successful mutation is not "ignored guidance".
  assert.match(skill, /A `post_mutation_stall` is not the repeated-stall case, even when guidance has already been sent earlier in the run/);
  assert.match(skill, /does not mean the worker ignored that guidance, and it does not enter the replacement path/);
  assert.match(skill, /Preserve the implementation you already made\./);
  assert.match(skill, /Stop expanding into adjacent approaches or validation infrastructure\./);
  assert.match(skill, /Run the narrowest existing build\/tests that apply, then finish and report\./);
  const section = skill.slice(skill.indexOf('### First post-mutation stall'), skill.indexOf('### Repeated progress stall after guidance'));
  assert.match(section, /Do not replace the worker and do not spawn a second worker, and do not wake the parent for this/);
  assert.match(section, /first guidance -> mutation -> `post_mutation_stall` does not justify replacement/);
  assert.match(section, /`post_mutation_stall` -> focused continuation -> `post_guidance_stall` may/);
  // The continuation must stay generic rather than naming a framework.
  assert.equal(/blazor|bunit|razor/i.test(section), false);
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

test('the parent delegates routine supervision and never polls the worker', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /## Parent responsibilities/);
  assert.match(skill, /While the worker is running, the parent must NOT:/);
  assert.match(skill, /- inspect the Qwen thread or read intermediate worker transcript/);
  assert.match(skill, /- poll Qwen progress or periodically check whether the worker is still alive/);
  assert.match(skill, /- duplicate Luna's diagnosis or re-derive the health signals itself/);
  assert.match(skill, /- issue ordinary corrective guidance/);
  assert.match(skill, /Waiting on the watchdog is the parent's whole supervision duty/);
  // Luna, not the parent, owns every routine observation of the worker.
  assert.match(skill, /Luna owns routine supervision for the whole run/);
  assert.match(skill, /keeps Luna the sole routine observer of the worker/);
});

test('a clean handoff tells the parent not to re-inspect the worker or the repository', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /If the watchdog reports successful completion with no material concern, use its handoff and the worker's final result to answer the user\. Do not independently re-inspect the worker transcript or repository merely to reconfirm routine work\./);
  assert.match(skill, /`use_handoff` — nothing in the persisted run warrants parent inspection/);
  assert.match(skill, /`review_concern` — the handoff carries at least one material warning\. Inspect only what is needed to resolve that specific concern/);
  assert.match(skill, /A `warnings` entry is a reason to look at one thing, not a reason to replay the run/);
  // The old contract told the parent to review the worker's changes on every
  // DONE. That routine re-review is exactly what v0.7.0 removes.
  assert.equal(/After `DONE`, the parent reviews the worker's final changes normally/.test(skill), false);
});

test('completion produces exactly one compact tool-built handoff', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /Call `summarize_v1_worker_handoff` exactly once/);
  assert.match(skill, /Return the line `DONE: worker completed` followed by that tool's JSON result verbatim/);
  assert.match(skill, /Never include a chronological account, reasoning trace, long command output, worker transcript, or your own engineering assessment/);
  assert.match(skill, /## Completion handoff/);
  assert.match(skill, /`material_concern: false` and `parent_action: "use_handoff"`/);
  assert.match(skill, /the handoff cannot grow into a second transcript/);
});

test('the watchdog sends ordinary corrective guidance itself', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /## Watchdog intervention/);
  assert.match(skill, /Ordinary corrective guidance is the watchdog's job, not the parent's/);
  assert.match(skill, /`send_input` with `interrupt=false` targeting that exact thread, ONLY to deliver one of the fixed continuation texts below/);
  // Both existing continuation texts survive, now owned by Luna.
  assert.match(skill, /Stop investigating\. Use the diagnosis and implementation plan you already established\./);
  assert.match(skill, /Preserve the implementation you already made\./);
  // The cheap model must never invent technical instruction of its own.
  assert.match(skill, /The continuation texts below are fixed\. Send one verbatim\./);
  assert.match(skill, /Never author your own technical instruction, diagnosis, or fix/);
  assert.match(skill, /Send at most one continuation per stall class, and at most two continuations in the whole run/);
});

test('escalation stays available for exceptional cases only', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /NEEDS_SOL_REVIEW: worker resumed investigating after parent guidance without mutating the repository/);
  assert.match(skill, /NEEDS_SOL_REVIEW: worker remains materially stuck after watchdog guidance/);
  assert.match(skill, /NEEDS_SOL_REVIEW: <one concise sentence naming the decision the parent must make>/);
  assert.match(skill, /NEEDS_SOL_REVIEW: watchdog transport unavailable after three attempts/);
  assert.match(skill, /NEEDS_SOL_REVIEW: watchdog Code Mode execution could not remain attached/);
  // Replacement remains a parent decision after guidance was already ignored.
  assert.match(skill, /replacement becomes justified, and replacement is a parent decision/);
  assert.match(skill, /The parent then closes that worker and spawns a replacement/);
});

test('the relay path keeps the parent out of diagnosis when sibling send_input is unavailable', async () => {
  const skill = await fs.readFile(path.join(pluginRoot, 'skills', 'supervise-v1-agent', 'SKILL.md'), 'utf8');

  assert.match(skill, /## Sibling guidance delivery/);
  assert.match(skill, /V1 does not document sibling `send_input` as ownership-free/);
  assert.match(skill, /NEEDS_SOL_RELAY: <the exact continuation text, verbatim>/);
  assert.match(skill, /delivers exactly that text through `send_input` with `interrupt=false` and re-enters the same one-hour watchdog wait without inspecting the worker/);
  assert.match(skill, /`NEEDS_SOL_RELAY` is not a review request/);
});
