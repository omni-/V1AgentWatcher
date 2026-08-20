# V1 Agent Watcher

A small Codex plugin for supervising V1 child agents, especially local-model workers delegated from a stronger parent model.

Codex V1 can spawn, wait for, interrupt, and send follow-up input to child agents, but the parent does not get a useful live view of the child's intermediate progress. Codex already persists child activity under `~/.codex/sessions/.../rollout-*.jsonl`. V1 Agent Watcher exposes a compact view of that persisted activity back to the parent as MCP tools.

## Tools

- `list_v1_agents` — list recent child rollout sessions and their thread/parent/provider metadata.
- `inspect_v1_agent_health` — run a compact deterministic behavioral screen for one exact V1 worker thread without returning its detailed trace.
- `inspect_v1_agent` — inspect recent reasoning, assistant messages, and tool activity for a specific child.
- `inspect_latest_v1_agent` — convenience tool for supervising the most recently active child, optionally filtered by cwd/provider.

The watcher intentionally returns only a short recent window and truncates individual events so supervision costs far fewer parent-model tokens than replaying the full rollout.

The health operation does not attempt to judge whether the worker's engineering solution is correct. It looks only for observable behavior such as repeated commands, repeated failures, repeated premise reversals, repeated compaction, terminal errors, and conservative inactivity. One self-correction and ordinary Qwen latency are not suspicious by themselves.

## Cheap watchdog supervision

The bundled supervision skill uses a persistent Luna sibling as the watchdog:

```text
Sol
 ├─ Qwen: real engineering task
 └─ Luna: wait on Qwen, run compact health checks, stay silent while healthy
```

Luna waits about four minutes between healthy Qwen checks (two minutes for Ornith), using Codex's native agent wait so worker completion wakes it early. Luna returns only `DONE` or `NEEDS_SOL_REVIEW`. Sol waits on Luna and does not inspect Qwen's trace during healthy intervals.

The watchdog always uses the worker's exact thread ID. Once Luna is running, it may be the newest child session, so `inspect_latest_v1_agent` is not safe for the worker in this flow.

## Live terminal viewer

The plugin also includes `v1watch`, a human-facing live viewer for the same rollout data.

```powershell
v1watch
```

By default it follows the newest child agent and redraws a compact dashboard showing recent reasoning, assistant messages, tool activity, state, provider, cwd, and last-activity age.

Useful modes:

```powershell
v1watch -Agent ornith
v1watch -Provider lmstudio
v1watch -Agent ornith -Stream
v1watch -Raw
v1watch -Once
```

`-Stream` appends new activity instead of redrawing the dashboard. `-Raw` tails the underlying rollout JSONL without summarization.

To put `v1watch` on your PATH from a local checkout:

```powershell
git clone https://github.com/omni-/V1AgentWatcher.git
cd V1AgentWatcher\plugins\v1-agent-watcher
npm link
```

The CLI has no runtime dependencies beyond Node.js.

## Install in Codex

Add this repository as a plugin marketplace, then install the plugin:

```powershell
codex plugin marketplace add omni-/V1AgentWatcher
codex plugin add v1-agent-watcher@v1-agent-watcher
```

Restart Codex after installation. The bundled stdio MCP server uses only Node.js built-ins and needs no `npm install`.

## Typical parent prompt

```text
Delegate the implementation to the `qwen` agent, retain its exact thread ID,
and use the supervise-v1-agent skill to spawn one Luna watchdog for that ID.
Wait on Luna. Do not inspect Qwen's trace while Luna reports no terminal result.
After Luna returns DONE, review Qwen's diff yourself.
```

## Requirements

- Codex using the V1 multi-agent path.
- Node.js 18 or newer available on PATH.
- Filesystem access to the Codex home directory (`$CODEX_HOME`, or `~/.codex`).

## Development

```powershell
cd plugins/v1-agent-watcher
npm test
```

The MCP server is dependency-free and speaks newline-delimited JSON-RPC over stdio.
