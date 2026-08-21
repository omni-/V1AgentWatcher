---
name: supervise-v1-agent
description: Supervise a running Codex V1 child agent cheaply with a persistent Luna watchdog, deterministic rollout health checks, long waits, and queued steering only when parent attention is warranted.
---

# Supervise V1 Agent

Use a persistent `gpt-5.6-luna` sibling as the progress watchdog. The parent should not wake on every healthy cadence boundary and must not re-solve or independently review the worker's engineering task while the worker is running.

## Required architecture

1. Spawn the real V1 worker and retain its exact thread ID.
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
- Use a health window of 900000 ms for Qwen, 300000 ms for Ornith, or 600000 ms for an unknown local worker.
- Build that health window from transport-safe `wait_v1_agent` calls of at most 225000 ms. Use the smaller of 225000 ms and the remaining health-window duration. These are quiet wait chunks, not health-poll boundaries. Invoke each chunk in one foreground Code Mode execution with a 240000 ms outer yield, leaving a deliberate 15000 ms completion margin:

  ```javascript
  // @exec: {"yield_time_ms": 240000}
  const result = await tools.mcp__v1_agent_watcher__wait_v1_agent({
    thread_id: workerThreadId,
    timeout_ms: Math.min(225000, remainingHealthWindowMs)
  });
  text(result);
  ```

  Do not call `wait(cell_id)` to finish an otherwise healthy MCP chunk. An unexpected Code Mode background-cell yield is an enclosing runtime failure, not a completed MCP timeout and not evidence about worker health; return `NEEDS_SOL_REVIEW: watchdog Code Mode execution could not remain attached` instead of polling that cell.
- If `wait_v1_agent` reports `completed`, return exactly:
  DONE: worker completed
- If `wait_v1_agent` reports `terminal_error`, return exactly:
  NEEDS_SOL_REVIEW: <one concise sentence describing that observable state>
- Only a returned `outcome: timeout` is a completed wait chunk. Add its actual `waitedMs` to the current health window. A tool exception, MCP failure, or transport timeout contributes zero elapsed wait evidence, says nothing about worker presence or health, and must never increment the missing-worker count.
- Retry a failed transport chunk. If three consecutive transport/tool failures prevent observation, return `NEEDS_SOL_REVIEW: watchdog transport unavailable after three attempts`; do not describe the worker as missing or unhealthy.
- Do not inspect health until completed timeout chunks accumulate one full health window. If every completed chunk in that full window has `found=false`, count one full missing window. Escalate only after three consecutive full missing windows.
- If any completed chunk in the full window has `found=true`, reset the missing-window count and call inspect_v1_agent_health for the exact worker thread.
- If state is idle/completed, return exactly:
  DONE: worker completed
- If health is healthy and state is running, begin another full wait. Do not report this healthy check to the parent.
- If health is suspicious, unreadable, aborted, or errored, return exactly:
  NEEDS_SOL_REVIEW: <one concise sentence copied or summarized only from the observable health signal>
- Provider and cwd values are diagnostic context, not identity constraints. Persisted cwd can reflect the parent launch context even when the worker correctly changed its shell cwd.
- A single self-correction is normal. Qwen producing no new persisted output for up to one hour can still be normal model inference and is not suspicious by itself.
- If health inspection itself cannot inspect the exact thread, wait another full health window before retrying. Escalate only after three such full-window inspection failures, and describe the inspection failure rather than claiming the worker is unhealthy.

Do not emit periodic progress updates. Continue until one terminal line above can be returned.
```

## Deterministic health screen

`inspect_v1_agent_health` is behavioral screening, not code review. It returns a compact state, `healthy` or `suspicious`, a short signal list, and aggregate recent counts. It intentionally omits the detailed trace.

Potential suspicious signals include repeated premise reversals, repeated identical or near-identical calls, repeated failures without a changed command, repeated context compaction, conservative long inactivity, and terminal error/abort states. One self-correction, meaningfully different searches, or ordinary Qwen latency should remain healthy.

Activity age comes from the newest parseable persisted `event_msg` or `response_item` timestamp. Rollout file mtime is only a fallback because Windows can leave mtime stale while a process holds and appends the JSONL. Premise-reversal screening requires explicit backtracking language; ordinary discourse markers such as bare “wait” or “actually” are not reversals.

## Steering after escalation

If the parent determines that ordinary technical guidance is needed, send one concise correction through V1 `send_input` with `interrupt=false`, or omit the flag only when omission means queued input. Prefer a factual constraint or concrete next action.

An inactivity-only or watchdog-transport escalation is a request to inspect, not permission to abandon the worker. If detailed inspection shows `state: running` and recent persisted activity below the applicable inactivity threshold, keep the existing worker. Replace or interrupt only when there is separate concrete evidence such as a terminal abort/error, an unreadable rollout that prevents safe supervision, or a clear repeated loop/failure pattern. Do not weaken those terminal and loop cases.

Do not use `interrupt=true` for normal supervision. In V1 it aborts the active child turn and can leave external-provider workers stopped. Reserve interruption for intentional cancellation. If a worker must be abandoned, close it and spawn a replacement with the corrected premise in its initial task.

## Graceful fallback

Plugins currently distribute this workflow as a skill plus MCP server; they do not need to install user-specific `.codex/agents` configuration. Request Luna directly in the spawn call.

The sibling-safe `wait_v1_agent` MCP operation is part of this plugin and is required for the Luna architecture. If it is unavailable, report the missing plugin capability rather than substituting native sibling `wait_agent`, which is ownership-scoped and may be unavailable to Luna. If `gpt-5.6-luna` itself is unavailable, the parent may perform the same persisted-rollout wait/compact-health loop while preserving the model-specific cadence and three-attempt startup grace.
