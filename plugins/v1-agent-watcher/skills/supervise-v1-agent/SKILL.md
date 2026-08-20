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
3. Wait on the watchdog, not the worker. Use the native V1 `wait_agent` with the watchdog thread ID and a long timeout, up to 3,600,000 ms when supported. The wait returns early when the watchdog finishes. If that outer wait itself times out, wait on the same watchdog again without inspecting the worker.
4. The watchdog stays silent while the worker is healthy. It returns only when the worker completes or observable behavior warrants parent attention.
5. After `DONE`, the parent reviews the worker's final changes normally. After `NEEDS_SOL_REVIEW`, the parent may call `inspect_v1_agent` for a small detailed window and decide whether queued guidance is needed.
6. Retain the exact worker and watchdog thread IDs in the final report so the human can measure the completed run afterward with `v1usage -Worker <worker-id> -Watchdog <watchdog-id>`.

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
Expected provider: <provider if known>
Expected cwd: <cwd if known>

Do not solve, diagnose, or review the worker's engineering task.
Do not inspect the repository or open source files.
Do not evaluate whether the worker's technical theory or implementation is correct.
Do not propose fixes or send guidance to the worker.
Use only:
1. V1 wait_agent targeting the exact worker thread.
2. inspect_v1_agent_health targeting that same exact thread, with provider/cwd filters when supplied.
Do not call inspect_v1_agent unless the parent later asks you to do so.

Loop internally:
- Wait 240000 ms for Qwen, 120000 ms for Ornith, or 240000 ms for an unknown local worker. wait_agent should return early if the worker reaches a final state.
- If wait_agent reports successful completion, return exactly:
  DONE: worker completed
- If wait_agent reports an error, abort, or missing worker, return exactly:
  NEEDS_SOL_REVIEW: <one concise sentence describing that observable state>
- After a wait timeout, call inspect_v1_agent_health for the exact worker thread.
- If state is idle/completed, return exactly:
  DONE: worker completed
- If health is healthy and state is running, begin another full wait. Do not report this healthy check to the parent.
- If health is suspicious, unreadable, aborted, or errored, return exactly:
  NEEDS_SOL_REVIEW: <one concise sentence copied or summarized only from the observable health signal>
- A single self-correction is normal. Qwen producing no new persisted output for twenty minutes can still be normal model inference and is not suspicious by itself.
- If the watcher cannot inspect the exact thread twice in succession, return NEEDS_SOL_REVIEW with that observable failure.

Do not emit periodic progress updates. Continue until one terminal line above can be returned.
```

## Deterministic health screen

`inspect_v1_agent_health` is behavioral screening, not code review. It returns a compact state, `healthy` or `suspicious`, a short signal list, and aggregate recent counts. It intentionally omits the detailed trace.

Potential suspicious signals include repeated premise reversals, repeated identical or near-identical calls, repeated failures without a changed command, repeated context compaction, conservative long inactivity, and terminal error/abort states. One self-correction, meaningfully different searches, or ordinary Qwen latency should remain healthy.

## Steering after escalation

If the parent determines that ordinary technical guidance is needed, send one concise correction through V1 `send_input` with `interrupt=false`, or omit the flag only when omission means queued input. Prefer a factual constraint or concrete next action.

Do not use `interrupt=true` for normal supervision. In V1 it aborts the active child turn and can leave external-provider workers stopped. Reserve interruption for intentional cancellation. If a worker must be abandoned, close it and spawn a replacement with the corrected premise in its initial task.

## Graceful fallback

Plugins currently distribute this workflow as a skill plus MCP server; they do not need to install user-specific `.codex/agents` configuration. Request Luna directly in the spawn call.

If `gpt-5.6-luna` or sibling-agent waiting is unavailable, keep using the deterministic health operation. The parent may perform the same long-wait/compact-health loop as a fallback, but it should still avoid detailed trace inspection on healthy intervals and must preserve the model-specific cadence.
