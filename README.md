# V1 Agent Watcher

A small Codex plugin for supervising V1 child agents, especially local-model workers delegated from a stronger parent model.

Codex V1 can spawn, wait for, interrupt, and send follow-up input to child agents, but the parent does not get a useful live view of the child's intermediate progress. Codex already persists child activity under `~/.codex/sessions/.../rollout-*.jsonl`. V1 Agent Watcher exposes a compact view of that persisted activity back to the parent as MCP tools.

## Tools

- `list_v1_agents` — list recent child rollout sessions and their thread/parent/provider metadata.
- `wait_v1_agent` — wait on one exact persisted rollout until terminal state or timeout, without native parent/child wait ownership, optionally returning deterministic logical health-window accounting for composed chunks.
- `inspect_v1_agent_health` — run a compact deterministic behavioral and progress screen for one exact V1 worker thread without returning its detailed trace.
- `inspect_v1_agent` — inspect recent reasoning, assistant messages, and tool activity for a specific child.
- `inspect_latest_v1_agent` — convenience tool for supervising the most recently active child, optionally filtered by cwd/provider.

- `inspect_v1_agent_usage` - read lifetime accounting for one exact persisted thread, including root threads.
- `inspect_v1_supervision_usage` - resolve an exact worker's parent and summarize the Sol benchmark turn, Luna lifetime, and worker lifetime separately.

The watcher intentionally returns only a short recent window and truncates individual events so supervision costs far fewer parent-model tokens than replaying the full rollout.

The health operation does not attempt to judge whether the worker's engineering solution is correct. It looks only for observable behavior such as repeated commands, repeated failures, repeated explicit premise reversals, repeated compaction, terminal errors, conservative inactivity, and progress stalls. Bare discourse markers such as “wait” and “actually” are not reversals. One self-correction and up to an hour without persisted Qwen activity are not suspicious by themselves. Activity age uses the newest persisted rollout event timestamp when available and falls back to file mtime only when necessary.

### Progress stalls

A worker can stay technically active — still reasoning, still calling tools — while engineering progress has stopped. `progress_stall` recognizes that pattern from persisted rollout facts alone. It requires all of:

1. the worker committed to an implementation phase (an explicit implementation plan, or an explicit statement that it is now applying the change);
2. at least two context compactions after that commitment;
3. no persisted repository-mutation call since — any patch/write/mutating-shell call resets the evidence;
4. renewed rediscovery or replanning after the newest compaction instead of implementation.

The health result reports the supporting facts (`compactions_since_mutation`, `seconds_since_mutation`, `implementation_phase_committed`, `implementation_phase_reentered`, `post_compaction_rediscovery`, `progress_stall_after_guidance`). Mutation evidence comes from persisted tool calls, so the watchdog never inspects the repository or the worker's source changes. Compaction is read from every persisted spelling, including a top-level `{"type":"compacted"}` record as well as the `event_msg` payload variants.

Two further stall signals catch the pattern that survives a tool-output token cap: a worker that diagnoses the task correctly, keeps planning and testing designs, and never edits the repository. Neither requires a compaction or an implementation-phase phrase.

`pre_mutation_stall` is scoped to the current turn and requires all of:

1. the current turn has been running for at least 15 minutes;
2. zero repository mutations in that turn;
3. at least 10 investigation/read/search calls in that turn.

Its thresholds come from Qwen benchmark traces, so only a Qwen worker escalates on it; for Ornith and unknown local workers the fact is reported without making the result suspicious.

`post_guidance_stall` applies once the parent has already told the worker to implement, where action is expected quickly, and requires all of:

1. parent guidance occurred (a later user message that is not the delegated task, not a framework `<environment_context>` preamble, and not a compaction bridge summary);
2. zero repository mutations since that guidance;
3. at least 3 investigation/read/search calls since that guidance.

Any repository mutation clears the corresponding stall, and only the newest guidance is in scope so earlier guidance cannot poison later work. Codex persists a framework `<environment_context>` user message before the delegated task and on every continuation turn; those are filtered out first, so the delegated task itself is never mistaken for parent guidance. Persisted commands are normalized before classification — the tool prefix, an explicit shell wrapper (`pwsh -Command ...`), and the PowerShell call operator (`& rg ...`) are all stripped — so none of those wrappers hides a read/search call. Both signals report their supporting facts (`current_turn_seconds`, `current_turn_mutations`, `current_turn_investigations`, `mutations_since_guidance`, `investigations_since_guidance`). Neither shortens the supervision cadence: they are deterministic enough for the first scheduled health-window inspection to catch them.

`post_mutation_stall` covers what comes after a successful edit: the worker changed the repository and then kept investigating instead of finishing. It requires no compaction, implementation-phase phrase, parent guidance, failed command, or repeated command, and requires all of:

1. the current turn is still active;
2. at least one repository mutation in that turn;
3. at least 30 minutes since the newest mutation;
4. at least 10 investigation/read/search calls after that newest mutation;
5. no later repository mutation.

The newest mutation is the reset point, so a later edit restarts both the elapsed window and the count, and build/test commands are not investigation calls. Its thresholds are Qwen-calibrated too, so only a Qwen worker escalates on it. It reports `post_mutation_stall` and `investigations_since_latest_mutation` alongside the existing `seconds_since_mutation`, which already measures elapsed time from the newest mutation. Because earlier parent guidance may be why the mutation exists, a first `post_mutation_stall` is never treated as the worker ignoring guidance: Sol inspects once, sends one focused continuation telling the worker to preserve the implementation and stop expanding into validation infrastructure, and keeps the same worker. Only a `post_guidance_stall` against that newest continuation re-enters the existing replacement path.

Each ingredient is deliberately insufficient alone: one compaction, one long inference, a clean worktree before implementation starts, and one huge tool result never escalate. Repeated compaction on its own no longer escalates either — a worker that edits between compactions is productive — so it is reported as a fact and escalates only alongside an independent signal.

`large_tool_output` is reported separately as a low-severity explanatory fact and never escalates by itself. It counts tool results above roughly 20000 tokens, sized from structured token metadata first, then from the pre-truncation count Codex writes into the output body (`Original token count: 80219`), and only then from a character estimate. Reading that header matters because the persisted body is truncated: estimating its stored length would put a 80k-token result well under the threshold.

## Cheap watchdog supervision

The bundled supervision skill uses a persistent Luna sibling as the watchdog:

```text
Sol
 ├─ Qwen: real engineering task
 └─ Luna: wait on Qwen, run compact health checks, stay silent while healthy
```

Luna waits up to fifteen minutes between healthy Qwen checks (five minutes for Ornith and ten minutes for an unknown local worker), using the plugin's persisted-rollout wait so worker completion wakes it early even though Qwen is Luna's sibling. Each MCP wait call is capped at a transport-safe 225 seconds, and Luna composes a whole logical health window from those chunks inside ONE foreground Code Mode execution — a deterministic loop, not a background cell — so a fifteen-minute Qwen window costs one Luna inference rather than one per chunk. If the runtime rejects the full-window outer yield, the fallback is one 225-second chunk per execution inside a 240-second yield, leaving 15 seconds for MCP and wrapper completion.

`wait_v1_agent` accepts optional `health_window_ms` / `elapsed_health_window_ms` / `found_in_health_window` arguments and returns the accumulated window state, so the inspection boundary is computed deterministically instead of being re-derived by the watchdog each turn. The accumulated state comes back as `health_window.elapsed_ms` and `health_window.found_in_window`, and — because the input argument names are easy to read back by mistake — the same values are also exposed as `health_window.elapsed_health_window_ms` and `health_window.found_in_health_window`. Reading either spelling carries the accumulator forward; a watchdog can no longer silently restart the logical window by resending zeroes. A completed chunk that observed the worker resets missing-worker state and contributes its elapsed time, but never triggers an inspection by itself; health is inspected exactly once per completed logical window. Tool, transport, and Code Mode yield failures contribute zero elapsed time and do not count as missing-worker windows. Luna returns only `DONE` or `NEEDS_SOL_REVIEW`.

Sol waits on Luna through the native one-hour `wait_agent`, with the enclosing Code Mode execution explicitly given the same one-hour yield. This keeps Sol dormant until Luna returns or the native wait genuinely expires. Healthy supervision never uses repeated background-cell `wait(cell_id)` calls; an unexpected background-cell yield is reported as a Code Mode runtime failure.

After escalation, inactivity alone is not grounds to abandon a worker. If detailed inspection still shows `running` with recent persisted activity, Sol keeps that worker unless there is an independent terminal, unreadable, error, or clear loop signal.

A `progress_stall` escalation follows the same principle. On the first stall Sol inspects the detailed trace and, if it confirms an established diagnosis and concrete plan, sends one focused continuation to the same worker telling it to implement the smallest supported fix now rather than investigating further; the worker is not replaced. Sol also checks there whether the worker broadened past the original task after already finding a sufficient fix, and may tell it to defer adjacent architectural concerns. If the same worker stalls again after that explicit guidance — reported as `progress_stall_after_guidance`, or as `post_guidance_stall` when it simply resumed investigating without mutating anything — replacement becomes justified. None of this adds polling: progress analysis happens only at the existing health-window boundaries.

### Local-worker reasoning levels

The model catalog advertises `low`/`medium`/`high`/`xhigh` for local LM Studio workers, but a served model may support only `on` and `off` and will report the requested level as unsupported before falling back to `on`.

Omitting `reasoning_effort` does not avoid that. V1 declares the field as “omit to inherit the parent effort”, and persisted rollouts confirm it: a spawn passing no `reasoning_effort` produced a worker whose `turn_context` recorded the parent's own `medium`. The enum has no provider-native `on` value, so no spawn setting can request what the model actually supports. The skill still omits the field — deliberately naming an unsupported level adds nothing — but documents the limitation instead of claiming omission suppresses the warning. Reasoning stays enabled through the provider's fallback; the level is not honored, so a run should never be described as, for example, a “medium-effort” run.

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

The Code Mode execution wrapper is implemented upstream in Codex rather than in this repository. Focused skill tests therefore lock the required generated invocation contract (one-hour parent yield, the composed Luna window loop with 225-second MCP chunks, one health inspection per completed logical window, no healthy background-cell polling, the first-stall/repeated-stall parent policy, and local-worker reasoning omission), while the server tests lock the MCP timeout and health-window schema.
