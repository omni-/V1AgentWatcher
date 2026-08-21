---
name: supervise-v1-agent
description: Supervise a running Codex V1 child agent cheaply with a persistent Luna watchdog, deterministic rollout health checks, long waits, and queued steering only when parent attention is warranted.
---

# Supervise V1 Agent

Use a persistent `gpt-5.6-luna` sibling as the progress watchdog. The parent should not wake on every healthy cadence boundary and must not re-solve or independently review the worker's engineering task while the worker is running.

## Required architecture

1. Spawn the real V1 worker and retain its exact thread ID. Do not pass an explicit granular `reasoning_effort` when the worker runs on a local OpenAI-compatible provider such as `lmstudio`. Note that omitting it inherits the parent effort rather than suppressing the provider's unsupported-setting fallback. See "Local-worker reasoning configuration" below.
2. Spawn one watchdog with:
   - model `gpt-5.6-luna`
   - low reasoning effort
   - no forked parent context when the spawn API exposes that choice
   - the exact worker thread ID and worker kind (`qwen`, `ornith`, or unknown) in its initial message
3. Wait on the watchdog, not the worker. Call the native V1 `wait_agent` on the watchdog thread with `timeout_ms=3600000` inside one Code Mode execution whose first line explicitly sets `yield_time_ms` to the same 3600000 ms. Do not rely on either timeout's default. Use this invocation shape (substitute the retained watchdog ID):

   ```javascript
   // @exec: {"yield_time_ms": 3600000}
   const result = await tools.multi_agent_v1__wait_agent({
     targets: [watchdogThreadId],
     timeout_ms: 3600000
   });
   text(result);
   ```

   The native wait returns early when the watchdog finishes, while the matching outer yield keeps Code Mode attached instead of creating a background cell after its short default. If that native one-hour wait genuinely times out without a terminal watchdog result, immediately repeat the same complete Code Mode invocation, including the first-line yield pragma. Between healthy outer waits, do not inspect the worker or watchdog, emit progress commentary, summarize status, or perform any other parent work.
4. The watchdog stays silent while the worker is healthy. It returns only when the worker completes or observable behavior warrants parent attention.
5. After `DONE`, the parent reviews the worker's final changes normally. After `NEEDS_SOL_REVIEW`, the parent may call `inspect_v1_agent` for a small detailed window and decide whether queued guidance is needed. A worker that is still `running` with recent persisted activity must be preserved unless inspection also shows an independent concrete terminal, error, unreadable, or repeated-loop signal.
6. Retain the exact worker and watchdog thread IDs in the final report so the human can measure the completed run afterward with `v1usage -Worker <worker-id> -Watchdog <watchdog-id>`.

After the watchdog is spawned, the parent must remain silent until the watchdog returns `DONE` or `NEEDS_SOL_REVIEW`, the user provides new input, the native one-hour wait genuinely expires, or an actual tool/runtime error requires parent action. A healthy `wait_agent` timeout is not a progress update; re-enter the same explicit one-hour wait immediately.

A healthy long wait must never degrade into model-authored background-cell polling. Repeated `wait(cell_id)` calls are not a normal or acceptable supervision path. If Code Mode rejects the explicit 3600000 ms outer yield because the active runtime advertises a lower maximum, or unexpectedly returns `Script running with cell ID ...` before the native wait has completed, treat that as a Code Mode runtime failure: report it clearly and stop the supervision attempt instead of polling the cell. The active runtime must support and accept the one-hour outer yield for this workflow.

Always address the worker by exact `thread_id`. A watchdog is itself a child rollout and may be newer than the worker, so latest-session selection is unsafe after the watchdog has been spawned.

## Local-worker reasoning configuration

The Codex model catalog advertises `low`/`medium`/`high`/`xhigh` for local LM Studio models, but the served model may support only `on` and `off`. LM Studio then reports, for example:

```text
Reasoning setting 'medium' is not supported by model '...'. Supported settings: 'on', 'off'. Falling back to reasoning setting 'on'.
```

**Omitting `reasoning_effort` does not avoid this.** The V1 spawn interface declares:

```ts
// Reasoning effort override for the new agent. Omit to inherit the parent effort.
reasoning_effort?: string;
```

Omission inherits the parent's current effort, and the inherited granular value is forwarded to the provider like any explicit one. Persisted rollouts confirm it: a spawn that passed no `reasoning_effort` produced a worker whose `turn_context` recorded the parent's own `"effort":"medium"`.

The accurate statement of the limitation:

- The V1 effort enum has no provider-native `on` value, so no spawn setting can request what this model actually supports.
- Whatever granular level arrives — explicit or inherited — the provider reports it as unsupported and falls back to `on`. That warning is expected for this worker and is not a supervision fault.
- Reasoning therefore remains enabled, but the level is not honored and is not a meaningful control for this model.
- Still omit `reasoning_effort` for a local worker: deliberately naming an unsupported level adds nothing. Omission is the honest default, not a fix for the warning.
- Never describe such a run as, for example, a "medium-effort" run, and do not tune a local worker by changing this level. Luna's own reasoning configuration is unrelated and stays as it is.

## Post-run accounting

Detailed per-role token accounting is available from persisted rollout JSONL after the run finishes:

```powershell
v1usage -Worker <exact-worker-thread-id> -Watchdog <exact-watchdog-thread-id>
```

Do not call the accounting MCP operation automatically at the end of supervision. A Sol MCP call requires another Sol inference turn and changes the quantity being measured. The post-hoc CLI reads the finished Sol/Qwen/Luna rollout tree without that observer effect. Keep accounting out of the healthy Luna wait loop.

## Watchdog prompt

Give Luna the following contract, substituting the worker ID, kind, provider, and cwd:

```text
You are a V1 subagent-progress watchdog.

Worker thread: <exact-thread-id>
Worker kind: <qwen|ornith|unknown>
Observed provider (informational): <provider if known>
Observed rollout cwd (informational): <cwd if known>

Do not solve, diagnose, or review the worker's engineering task.
Do not inspect the repository or open source files.
Do not evaluate whether the worker's technical theory or implementation is correct.
Do not propose fixes or send guidance to the worker.
Use only:
1. `wait_v1_agent` targeting the exact worker thread. This plugin operation follows persisted rollout state and is safe for sibling workers; do not use native Codex `wait_agent` from Luna.
2. inspect_v1_agent_health targeting that same exact thread, without provider/cwd filters.
Do not call inspect_v1_agent unless the parent later asks you to do so.

Loop internally:
- Use a logical health window of 900000 ms for Qwen, 300000 ms for Ornith, or 600000 ms for an unknown local worker.
- Build that logical window from transport-safe `wait_v1_agent` chunks of at most 225000 ms each. Chunks are quiet waits, not health-poll boundaries.
- Compose the whole logical window inside ONE foreground Code Mode execution whose first-line yield covers the full window plus a 60000 ms completion margin. One Luna inference then covers the entire window instead of one inference per chunk. Pass the window accounting fields so the boundary is computed deterministically by the tool rather than by your own arithmetic:

  ```javascript
  // @exec: {"yield_time_ms": 960000}
  const healthWindowMs = 900000;
  let elapsedMs = 0;
  let foundInWindow = false;
  let failures = 0;
  let last = null;
  while (elapsedMs < healthWindowMs) {
    try {
      last = await tools.mcp__v1_agent_watcher__wait_v1_agent({
        thread_id: workerThreadId,
        timeout_ms: Math.min(225000, healthWindowMs - elapsedMs),
        health_window_ms: healthWindowMs,
        elapsed_health_window_ms: elapsedMs,
        found_in_health_window: foundInWindow
      });
    } catch (error) {
      failures += 1;
      last = { outcome: 'transport_failure', error: String(error) };
      if (failures >= 3) break;
      continue;
    }
    if (last.outcome !== 'timeout') break;
    failures = 0;
    elapsedMs = last.health_window.elapsed_ms;
    foundInWindow = last.health_window.found_in_window;
    if (last.health_window.inspect_now || last.health_window.missing_window) break;
  }
  text(JSON.stringify({ last, elapsedMs, foundInWindow, failures }));
  ```

  Every individual MCP wait stays at or below 225000 ms, so no single request exceeds the transport-safe limit. The loop never calls `wait(cell_id)` and never creates a background cell. A `completed` or `terminal_error` chunk breaks out immediately, so worker completion still wakes the watchdog early. If the runtime rejects the full-window outer yield, fall back to exactly one 225000 ms chunk per Code Mode execution with a 240000 ms outer yield, leaving a deliberate 15000 ms completion margin, and carry `elapsed_health_window_ms` and `found_in_health_window` across your own turns. The inspection cadence below is identical either way.
- Do not call `wait(cell_id)` to finish an otherwise healthy MCP chunk. An unexpected Code Mode background-cell yield is an enclosing runtime failure, not a completed MCP timeout and not evidence about worker health; return `NEEDS_SOL_REVIEW: watchdog Code Mode execution could not remain attached` instead of polling that cell.
- If `wait_v1_agent` reports `completed`, return exactly:
  DONE: worker completed
- If `wait_v1_agent` reports `terminal_error`, return exactly:
  NEEDS_SOL_REVIEW: <one concise sentence describing that observable state>
- Only a returned `outcome: timeout` is a completed wait chunk, and only a completed chunk contributes its actual `waitedMs` to the current logical health window. A tool exception, MCP failure, transport timeout, or Code Mode yield failure contributes ZERO elapsed health-window time, says nothing about worker presence or health, and must never increment the missing-worker count.
- A completed chunk with `found=true` immediately resets the missing-worker window count and contributes its `waitedMs` to the current logical window. It does NOT trigger a health inspection by itself. Never call inspect_v1_agent_health merely because a chunk returned.
- Call inspect_v1_agent_health exactly once per completed logical health window, only when `health_window.inspect_now` is true — that is, only after completed timeout chunks have accumulated the full window and at least one of them observed the worker. For Qwen this means four completed 225000 ms chunks produce one inspection at 900000 ms, not four inspections.
- After that inspection, reset `elapsed_health_window_ms` to 0 and `found_in_health_window` to false, then begin another complete window.
- `health_window.missing_window` true means a full window completed with every chunk reporting `found=false`. Count one full missing window, reset the window accumulators, and do not inspect. Escalate only after three consecutive full missing windows.
- Retry a failed transport chunk. If three consecutive transport/tool failures prevent observation, return `NEEDS_SOL_REVIEW: watchdog transport unavailable after three attempts`; do not describe the worker as missing or unhealthy.
- If state is idle/completed, return exactly:
  DONE: worker completed
- If health is healthy and state is running, begin another full wait. Do not report this healthy check to the parent.
- Check the stall signals in this order and return on the first match. A worker that stalls after guidance usually raises the earlier signals too, so checking `post_guidance_stall` first is what keeps the repeated-stall case distinguishable from the first stall.
- If health is suspicious and its signals include `post_guidance_stall`, return exactly:
  NEEDS_SOL_REVIEW: worker resumed investigating after parent guidance without mutating the repository
- Otherwise, if health is suspicious and its signals include `progress_stall` or `pre_mutation_stall`, return exactly:
  NEEDS_SOL_REVIEW: worker appears active but has stalled before implementation
- If health is otherwise suspicious, unreadable, aborted, or errored, return exactly:
  NEEDS_SOL_REVIEW: <one concise sentence copied or summarized only from the observable health signal>
- Provider and cwd values are diagnostic context, not identity constraints. Persisted cwd can reflect the parent launch context even when the worker correctly changed its shell cwd.
- A single self-correction is normal. Qwen producing no new persisted output for up to one hour can still be normal model inference and is not suspicious by itself. A single compaction, a long inference, a clean worktree, and one large tool result are each normal on their own; only the deterministic stall signals combine them.
- Keep the normal health-window cadence. `pre_mutation_stall` and `post_guidance_stall` are deterministic enough that the first scheduled inspection catches them; do not shorten the window or add extra polling to find them sooner.
- If health inspection itself cannot inspect the exact thread, wait another full health window before retrying. Escalate only after three such full-window inspection failures, and describe the inspection failure rather than claiming the worker is unhealthy.

Do not emit periodic progress updates. Continue until one terminal line above can be returned.
```

## Deterministic health screen

`inspect_v1_agent_health` is behavioral screening, not code review. It returns a compact state, `healthy` or `suspicious`, a short signal list, and aggregate recent counts. It intentionally omits the detailed trace.

Potential suspicious signals include repeated premise reversals, repeated identical or near-identical calls, repeated failures without a changed command, repeated context compaction, conservative long inactivity, terminal error/abort states, `progress_stall`, `pre_mutation_stall`, and `post_guidance_stall`. One self-correction, meaningfully different searches, or ordinary Qwen latency should remain healthy.

Activity age comes from the newest parseable persisted `event_msg` or `response_item` timestamp. Rollout file mtime is only a fallback because Windows can leave mtime stale while a process holds and appends the JSONL. Premise-reversal screening requires explicit backtracking language; ordinary discourse markers such as bare “wait” or “actually” are not reversals.

### progress_stall

`progress_stall` recognizes a worker that is technically active but no longer making engineering progress. It is computed only from persisted rollout facts, never from a judgement about the engineering task, and requires all of:

1. the worker committed to an implementation phase (an explicit implementation plan or an explicit statement that it is now applying the change);
2. at least two context compactions occurred after that commitment;
3. no persisted repository-mutation call occurred since — mutation evidence is any persisted patch/write/mutating-shell call, and any such call resets all of this evidence;
4. after the newest compaction the worker returned to repository rediscovery (three or more read/search calls) or reconstructed the implementation plan again instead of implementing.

The health result also reports the supporting facts: `compactions_since_mutation`, `seconds_since_mutation`, `implementation_phase_committed`, `implementation_phase_reentered`, `post_compaction_rediscovery`, and `progress_stall_after_guidance`.

Compaction is recognized from every persisted spelling, including a top-level `{"type":"compacted"}` record as well as the `event_msg` payload variants.

### pre_mutation_stall

`pre_mutation_stall` catches the different failure mode where the worker diagnoses the task well, keeps planning and testing designs, and never edits the repository. It requires no compaction and no implementation-phase phrase, and it is scoped to the current turn:

1. the current turn has been running for at least 15 minutes;
2. zero repository mutations in that turn;
3. at least 10 investigation/read/search calls in that turn.

Its thresholds are calibrated on Qwen benchmark traces, so only a Qwen worker escalates on it. For Ornith and unknown local workers the fact is still reported and the result stays healthy on that signal alone.

Any repository mutation in the current turn clears it. Command classification normalizes the persisted command first — the tool prefix, an explicit shell wrapper (`pwsh -Command ...`), and the PowerShell call operator (`& rg ...`) are all stripped — so none of those wrappers hides a read/search call.

### post_guidance_stall

`post_guidance_stall` applies once the parent has already told the worker to implement. It also requires no compaction:

1. parent guidance occurred (a later user message that is not the delegated task, not a framework `<environment_context>` preamble, and not a compaction bridge summary);
2. zero repository mutations since that guidance;
3. at least 3 investigation/read/search calls since that guidance.

Only the newest guidance is in scope, so earlier guidance cannot poison later work.

One compaction, one long inference, a clean worktree before implementation begins, and one huge tool result are each insufficient alone and deliberately do not escalate. Repeated compaction alone is also insufficient now that progress_stall is the discriminating signal: it is reported, and escalates only when an independent signal corroborates it.

`large_tool_output` is reported as a low-severity explanatory fact and never escalates by itself. It counts tool results above roughly 20000 tokens, sized from structured token metadata first, then from the pre-truncation count Codex writes into the output body (`Original token count: 80219`), and only then from a character estimate — the persisted body is truncated, so its stored length understates a pathological result.

## Steering after escalation

If the parent determines that ordinary technical guidance is needed, send one concise correction through V1 `send_input` with `interrupt=false`, or omit the flag only when omission means queued input. Prefer a factual constraint or concrete next action.

### First progress stall: continue the same worker

A `progress_stall` escalation never justifies killing a live worker by itself. Recent persisted activity still means the worker is alive; suspicion is a reason for parent review, not automatic abandonment.

On the first `progress_stall` or `pre_mutation_stall` escalation:

1. Call `inspect_v1_agent` once for a small detailed window.
2. If that trace confirms the diagnosis is already established, the implementation plan is concrete, and the worker has repeatedly compacted, replanned, or simply kept investigating without mutating the repository, send ONE focused continuation to the SAME worker through `send_input` with `interrupt=false`:

   ```text
   Stop investigating. Use the diagnosis and implementation plan you already established.
   Implement the smallest supported fix now, then run the focused tests.
   Do not broaden scope unless implementation evidence requires it.
   ```

3. Resume the same worker and the same Luna supervision loop. Do not replace the worker and do not spawn a second worker.

While reviewing that trace, also check whether the worker expanded past the originally requested task after it had already identified a sufficient fix. If it did, the continuation may add one sentence telling it to implement the smallest fix supported by the original task and to defer adjacent architectural concerns unless correctness requires them. This is a scope instruction from the parent, not a code review by the watchdog; Luna never judges which fix is correct.

### Repeated progress stall after guidance

If the same worker stalls again after that explicit implementation guidance — another compaction/replanning cycle with no mutation, reported as `progress_stall_after_guidance: true`, or renewed investigation with no mutation since the guidance, reported as `post_guidance_stall: true` — replacement becomes justified. Close that worker and spawn a replacement whose initial task carries the established diagnosis, the implementation plan, and an explicit instruction to implement before investigating further.

Do not add progress polling to detect any of this. Progress analysis happens only at the existing logical health-window boundaries or when the worker emits a terminal or suspicious state.

An inactivity-only or watchdog-transport escalation is a request to inspect, not permission to abandon the worker. If detailed inspection shows `state: running` and recent persisted activity below the applicable inactivity threshold, keep the existing worker. Replace or interrupt only when there is separate concrete evidence such as a terminal abort/error, an unreadable rollout that prevents safe supervision, or a clear repeated loop/failure pattern. Do not weaken those terminal and loop cases.

Do not use `interrupt=true` for normal supervision. In V1 it aborts the active child turn and can leave external-provider workers stopped. Reserve interruption for intentional cancellation. If a worker must be abandoned, close it and spawn a replacement with the corrected premise in its initial task.

## Graceful fallback

Plugins currently distribute this workflow as a skill plus MCP server; they do not need to install user-specific `.codex/agents` configuration. Request Luna directly in the spawn call.

The sibling-safe `wait_v1_agent` MCP operation is part of this plugin and is required for the Luna architecture. If it is unavailable, report the missing plugin capability rather than substituting native sibling `wait_agent`, which is ownership-scoped and may be unavailable to Luna. If `gpt-5.6-luna` itself is unavailable, the parent may perform the same persisted-rollout wait/compact-health loop while preserving the model-specific cadence and three-attempt startup grace.
