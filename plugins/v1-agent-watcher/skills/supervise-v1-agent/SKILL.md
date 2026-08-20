---
name: supervise-v1-agent
description: Supervise a running Codex V1 child agent by inspecting its persisted rollout activity, especially when waiting on a delegated local worker or checking whether it is looping, stuck, or following a bad approach.
---

# Supervise V1 Agent

Use the V1 Agent Watcher MCP tools to inspect a delegated child while it is running.

When supervising a single recent worker, call `inspect_latest_v1_agent` with the project `cwd` and, when useful, the expected provider such as `lmstudio`. If multiple children are plausible, call `list_v1_agents` first and then `inspect_v1_agent` by `thread_id`.

Treat the watcher output as a recent progress window, not a complete transcript. Look for repeated reasoning, repeated searches, an invalid technical premise, no concrete progress, or a long interval since activity.

If the child needs ordinary technical guidance, send one concise correction through Codex collaboration input with `interrupt=false` (or omit the interrupt flag when that means queued input). The correction should be queued for the running V1 child rather than aborting its active turn. Prefer a factual constraint or concrete next action over a long replanning prompt. Continue monitoring only when useful to confirm the worker incorporated the correction.

Do **not** use `interrupt=true` for normal supervision or technical corrections. In V1, interruption aborts the active child turn and can leave external-provider workers stopped instead of resumed. Reserve `interrupt=true` for cases where cancellation of the current turn is explicitly intended, such as abandoning an irrecoverably stuck worker. If a child must be abandoned, close it and create a replacement with the corrected premise in its initial task rather than expecting an interrupted turn to resume.

Keep supervision cheap: request a small event window by default and do not repeatedly poll a healthy worker.
