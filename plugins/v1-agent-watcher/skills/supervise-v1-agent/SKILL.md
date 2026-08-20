---
name: supervise-v1-agent
description: Supervise a running Codex V1 child agent by inspecting its persisted rollout activity, especially when waiting on a delegated local worker or checking whether it is looping, stuck, or following a bad approach.
---

# Supervise V1 Agent

Use the V1 Agent Watcher MCP tools to inspect a delegated child while it is running.

When supervising a single recent worker, call `inspect_latest_v1_agent` with the project `cwd` and, when useful, the expected provider such as `lmstudio`. If multiple children are plausible, call `list_v1_agents` first and then `inspect_v1_agent` by `thread_id`.

Treat the watcher output as a recent progress window, not a complete transcript. Look for repeated reasoning, repeated searches, an invalid technical premise, no concrete progress, or a long interval since activity.

If the child needs guidance, use Codex's collaboration input/interruption mechanism to send one concise correction. Prefer a factual constraint or concrete next action over a long replanning prompt. Then let the child continue and inspect again only when useful.

Keep supervision cheap: request a small event window by default and do not repeatedly poll a healthy worker.
