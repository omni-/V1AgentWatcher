# V1 Agent Watcher

A small Codex plugin for supervising V1 child agents, especially local-model workers delegated from a stronger parent model.

Codex V1 can spawn, wait for, interrupt, and send follow-up input to child agents, but the parent does not get a useful live view of the child's intermediate progress. Codex already persists child activity under `~/.codex/sessions/.../rollout-*.jsonl`. V1 Agent Watcher exposes a compact view of that persisted activity back to the parent as MCP tools.

## Tools

- `list_v1_agents` — list recent child rollout sessions and their thread/parent/provider metadata.
- `wait_v1_agent` — wait on one exact persisted rollout until terminal state or timeout, without native parent/child wait ownership.
- `inspect_v1_agent_health` — run a compact deterministic behavioral screen for one exact V1 worker thread without returning its detailed trace.
- `inspect_v1_agent` — inspect recent reasoning, assistant messages, and tool activity for a specific child.
- `inspect_latest_v1_agent` — convenience tool for supervising the most recently active child, optionally filtered by cwd/provider.

- `inspect_v1_agent_usage` - read lifetime accounting for one exact persisted thread, including root threads.
- `inspect_v1_supervision_usage` - resolve an exact worker's parent and summarize the Sol benchmark turn, Luna lifetime, and worker lifetime separately.

The watcher intentionally returns only a short recent window and truncates individual events so supervision costs far fewer parent-model tokens than replaying the full rollout.

The health operation does not attempt to judge whether the worker's engineering solution is correct. It looks only for observable behavior such as repeated commands, repeated failures, repeated premise reversals, repeated compaction, terminal errors, and conservative inactivity. One self-correction and up to an hour without persisted Qwen activity are not suspicious by themselves.

## Cheap watchdog supervision

The bundled supervision skill uses a persistent Luna sibling as the watchdog:

```text
Sol
 ├─ Qwen: real engineering task
 └─ Luna: wait on Qwen, run compact health checks, stay silent while healthy
```

Luna waits up to fifteen minutes between healthy Qwen checks (five minutes for Ornith), using the plugin's persisted-rollout wait so worker completion wakes it early even though Qwen is Luna's sibling. Luna returns only `DONE` or `NEEDS_SOL_REVIEW`. Sol waits on Luna and does not inspect Qwen's trace during healthy intervals.

The watchdog always uses the worker's exact thread ID. Provider and persisted cwd are informational and are not used as identity filters because rollout metadata can retain the parent launch cwd. Once Luna is running, it may be the newest child session, so `inspect_latest_v1_agent` is not safe for the worker in this flow.

## Post-hoc token accounting

`v1usage` measures finished runs from their exact persisted rollout JSONL. It does not use `/status`, account-wide usage, transcript tokenization, or a global before/after delta, so unrelated concurrent Codex sessions do not affect the result.

For a V1 supervision run, retain the exact Qwen and Luna IDs and run:

```powershell
v1usage -Worker <exact-qwen-thread-id>
v1usage -Worker <exact-qwen-thread-id> -Watchdog <exact-luna-thread-id>
v1usage -Worker <exact-qwen-thread-id> -Watchdog <exact-luna-thread-id> -Json
```

The worker's `session_meta.parent_thread_id` and `source.subagent.thread_spawn` relation identify the exact Sol parent. In that parent rollout, `v1usage` finds the exact worker spawn, its enclosing `task_started`/`turn_started`, the cumulative usage immediately before the turn, and the final cumulative usage before the matching `task_complete`/`turn_complete`. Their field-by-field delta is the Sol benchmark-turn usage. Sol lifetime usage is reported alongside it for audit. Qwen and Luna remain separate, and the combined section keeps hosted and local effective tokens separate rather than presenting a cross-provider cost.

For a Sol-only control run:

```powershell
v1usage -Thread <exact-sol-thread-id>
v1usage -Thread <exact-sol-thread-id> -Json
```

`-Thread` works for root, parent, or child threads and reports only the exact thread's own persisted accounting. It never adds child rollouts. A fresh, single-purpose root thread is the preferred Sol-only A/B control because its lifetime usage is already the benchmark usage and no turn-boundary inference is needed.

### What the numbers mean

Verified against OpenAI Codex `main` commit [`a3bce23f`](https://github.com/openai/codex/commit/a3bce23f3b296e44d2d76c4fc2d6f105138aafd2), the persisted event is an `event_msg` whose payload has `type: "token_count"` and optional `info`:

```json
{
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "total_token_usage": {
        "input_tokens": 100,
        "cached_input_tokens": 40,
        "cache_write_input_tokens": 0,
        "output_tokens": 20,
        "reasoning_output_tokens": 10,
        "total_tokens": 120
      },
      "last_token_usage": { "...": "same fields" },
      "model_context_window": 258400
    },
    "rate_limits": null
  }
}
```

Codex builds `total_token_usage` by element-wise addition of each provider response, so every event is a cumulative thread snapshot. `v1usage` uses the latest snapshot; it never sums those snapshots. `last_token_usage` is the latest provider response/current-context signal, not the lifetime total. After context compaction Codex may replace only `last_token_usage` with a local context estimate whose detailed fields are zero; the cumulative total remains intact.

The report exposes:

- `input_tokens`: provider input, with cache reads already included.
- `cached_input_tokens`: the cache-read subset of input.
- `cache_write_input_tokens`: the current upstream cache-write detail when persisted; it is not added again.
- `non_cached_input_tokens = max(input_tokens - cached_input_tokens, 0)`.
- `output_tokens`: all output tokens.
- `reasoning_output_tokens`: the reasoning subset of output, shown separately and never added again.
- `raw_total_tokens`: the provider/Codex persisted `total_tokens` value.
- `effective_tokens = non_cached_input_tokens + output_tokens`, matching Codex's current blended display total. This is not labeled as the raw total.

Current Codex also persists `raw_response_completed`, containing exact usage for one upstream response. If cumulative `token_count` usage is absent but these events are present, the parser can sum those verified deltas and marks the accounting source explicitly.

Current response ordering records provider usage and emits the final `token_count` after assistant text is flushed, before the matching turn-completion event. Therefore a completed turn's final response is included. If a rollout is truncated, unfinished, lacks the matching completion, or lacks a usable boundary snapshot, the result is marked provisional/partial instead of claiming exactness.

External OpenAI-compatible providers such as LM Studio control which usage details Codex receives. Complete provider usage can produce all fields, but failures or provider configurations may persist `token_count` with `info: null`, omit fields, or report zeros that cannot be distinguished from unsupported detail. `v1usage` reports those cases as unavailable or partial and does not infer usage by tokenizing transcript text.

The MCP operations return the same compact structured accounting, but invoking them from Sol creates another Sol inference turn. For benchmark collection after completion, the human-facing `v1usage` CLI is preferred because it has no Sol observer effect.

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
