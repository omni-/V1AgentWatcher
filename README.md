# V1 Agent Watcher

A small Codex plugin for supervising V1 child agents, especially local-model workers delegated from a stronger parent model.

Codex V1 can spawn, wait for, interrupt, and send follow-up input to child agents, but the parent does not get a useful live view of the child's intermediate progress. Codex already persists child activity under `~/.codex/sessions/.../rollout-*.jsonl`. V1 Agent Watcher exposes a compact view of that persisted activity back to the parent as MCP tools.

Release notes: [CHANGELOG.md](CHANGELOG.md).

## Tools

- `list_v1_agents` — list recent child rollout sessions and their thread/parent/provider metadata.
- `wait_v1_agent` — wait on one exact persisted rollout until terminal state or timeout, without native parent/child wait ownership, optionally returning deterministic logical health-window accounting for composed chunks.
- `inspect_v1_agent_health` — run a compact deterministic behavioral and progress screen for one exact V1 worker thread without returning its detailed trace.
- `inspect_v1_agent` — inspect recent reasoning, assistant messages, and tool activity for a specific child.
- `inspect_latest_v1_agent` — convenience tool for supervising the most recently active child, optionally filtered by cwd/provider.
- `summarize_v1_worker_handoff` — build the compact structured completion handoff for one exact worker thread so the parent can answer without rereading the worker transcript.

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

The health result reports the supporting facts (`compactions_since_mutation`, `seconds_since_mutation`, `implementation_phase_committed`, `implementation_phase_reentered`, `post_compaction_rediscovery`, `progress_stall_after_guidance`). Mutation evidence comes from persisted tool calls, so the watchdog never inspects the repository or the worker's source changes. Mutation evidence is read from persisted tool calls, including Codex's own patch applier invoked as `& $codex --codex-run-as-apply-patch $patch` — the flag is hyphenated, so it is matched separately from the underscored `apply_patch` spelling. Compaction is read from every persisted spelling, including a top-level `{"type":"compacted"}` record as well as the `event_msg` payload variants.

Two further stall signals catch the pattern that survives a tool-output token cap: a worker that diagnoses the task correctly, keeps planning and testing designs, and never edits the repository. Neither requires a compaction or an implementation-phase phrase.

`pre_mutation_stall` is scoped to the current turn and requires all of:

1. the current turn has been running for at least 15 minutes;
2. zero repository mutations in that turn;
3. at least 10 investigation/read/search calls in that turn.

Its thresholds come from Qwen benchmark traces, so only a Qwen worker escalates on it; for Ornith and unknown local workers the fact is reported without making the result suspicious.

`post_guidance_stall` applies once the worker has already been told to implement — by the watchdog or by the parent — where action is expected quickly, and requires all of:

1. guidance occurred (a later user message that is not the delegated task, not a framework `<environment_context>` preamble, and not a compaction bridge summary);
2. zero repository mutations since that guidance;
3. at least 3 investigation/read/search calls since that guidance.

Any repository mutation clears the corresponding stall, and only the newest guidance is in scope so earlier guidance cannot poison later work. Codex persists a framework `<environment_context>` user message before the delegated task and on every continuation turn; those are filtered out first, so the delegated task itself is never mistaken for parent guidance. Persisted commands are normalized before classification — the tool prefix, an explicit shell wrapper (`pwsh -Command ...`), and the PowerShell call operator (`& rg ...`) are all stripped — so none of those wrappers hides a read/search call. Both signals report their supporting facts (`current_turn_seconds`, `current_turn_mutations`, `current_turn_investigations`, `mutations_since_guidance`, `investigations_since_guidance`). Neither shortens the supervision cadence: they are deterministic enough for the first scheduled health-window inspection to catch them.

`post_mutation_stall` covers what comes after a successful edit: the worker changed the repository and then kept investigating instead of finishing. It requires no compaction, implementation-phase phrase, parent guidance, failed command, or repeated command, and requires all of:

1. the current turn is still active;
2. at least one repository mutation in that turn;
3. at least 30 minutes since the newest mutation;
4. at least 10 investigation/read/search calls after that newest mutation;
5. no later repository mutation.

The newest mutation is the reset point, so a later edit restarts both the elapsed window and the count, and build/test commands are not investigation calls. Its thresholds are Qwen-calibrated too, so only a Qwen worker escalates on it. It reports `post_mutation_stall` and `investigations_since_latest_mutation` alongside the existing `seconds_since_mutation`, which already measures elapsed time from the newest mutation. Because earlier guidance may be why the mutation exists, a first `post_mutation_stall` is never treated as the worker ignoring guidance: Luna inspects once, sends one focused continuation telling the worker to preserve the implementation and stop expanding into validation infrastructure, and keeps the same worker without waking Sol. Only a `post_guidance_stall` against that newest continuation re-enters the existing replacement path, which is where Sol is involved.

Each ingredient is deliberately insufficient alone: one compaction, one long inference, a clean worktree before implementation starts, and one huge tool result never escalate. Repeated compaction on its own no longer escalates either — a worker that edits between compactions is productive — so it is reported as a fact and escalates only alongside an independent signal.

`large_tool_output` is reported separately as a low-severity explanatory fact and never escalates by itself. It counts tool results above roughly 20000 tokens, sized from structured token metadata first, then from the pre-truncation count Codex writes into the output body (`Original token count: 80219`), and only then from a character estimate. Reading that header matters because the persisted body is truncated: estimating its stored length would put a 80k-token result well under the threshold.

## Cheap watchdog supervision

The bundled supervision skill uses a persistent Luna sibling as the routine supervisor. Luna tokens are cheap and the local worker is free; the hosted parent is the expensive resource, so every routine observation of the worker belongs to Luna and the parent pays only for final judgement.

```text
Sol
 ├─ launches Qwen: real engineering task
 ├─ launches Luna: routine supervisor
 └─ waits on Luna and stays uninvolved
        │
        └─ Luna owns routine supervision
             ├─ waits on Qwen
             ├─ runs compact health checks at the fixed cadence
             ├─ detects stalls and bad behavior
             ├─ sends ordinary corrective guidance straight to Qwen
             └─ escalates to Sol only when policy requires it

Qwen finishes → Luna → compact structured handoff → Sol
```

Once Qwen and Luna are running, the parent does not inspect the Qwen thread, poll its progress, read intermediate transcript, re-derive Luna's diagnosis, issue ordinary guidance, or check periodically whether the worker is still alive. Waiting on Luna is its whole supervision duty, and that wait consumes no worker context.

Luna waits up to fifteen minutes between healthy Qwen checks (five minutes for Ornith and ten minutes for an unknown local worker), using the plugin's persisted-rollout wait so worker completion wakes it early even though Qwen is Luna's sibling. Each MCP wait call is capped at a transport-safe 225 seconds, and Luna runs exactly one chunk per Code Mode execution inside a 240-second outer yield, leaving 15 seconds for MCP and wrapper completion. A fifteen-minute Qwen window is therefore composed from four chunks spread across four ordinary Luna turns, and no execution has to stay attached longer than one chunk. That is the normal path, not a fallback: an execution ending between chunks is continuation, not failure.

`wait_v1_agent` accepts optional `health_window_ms` / `elapsed_health_window_ms` / `found_in_health_window` / `missing_health_windows` arguments and returns the accumulated window state, so the inspection boundary is computed deterministically instead of being re-derived by the watchdog each turn. The accumulator is stateless, which is what lets one logical window span several watchdog turns: every windowed result carries `health_window.next_wait_args`, a complete ready-to-send argument object for the following chunk — the exact thread id, the next timeout, the same window length, and the carried accumulator, already reset if that chunk completed a window — plus `health_window.next_action` (`continue_window`, `inspect_health`, or `note_missing_window`) naming the one thing to do before sending it. `next_wait_args` is the single prescribed continuation mechanism. The other returned fields — `health_window.elapsed_ms`, `health_window.found_in_window`, and their v0.6.5 `elapsed_health_window_ms` / `found_in_health_window` aliases — remain for diagnostics and backward compatibility, but they describe the window that just finished and are not next-call values. The distinction only bites at a boundary: after the fourth Qwen chunk they read 900000/true while `next_wait_args` correctly reads 0/false for the window starting next, so rebuilding the call from them would restart every window already full and collapse the fifteen-minute cadence into one inspection per chunk. A completed chunk that observed the worker resets missing-worker state and contributes its elapsed time, but never triggers an inspection by itself; health is inspected exactly once per completed logical window. Tool, transport, and Code Mode yield failures contribute zero elapsed time and do not count as missing-worker windows. Luna returns `DONE` with the completion handoff, `NEEDS_SOL_REVIEW` for a genuine escalation, or `NEEDS_SOL_RELAY` when it has decided on ordinary guidance but cannot deliver it itself.

Sol waits on Luna through the native one-hour `wait_agent`, with the enclosing Code Mode execution explicitly given the same one-hour yield. This keeps Sol dormant until Luna returns or the native wait genuinely expires. Luna needing several cheap turns to compose a health window is invisible to Sol: Luna never finishes a message between chunks, so its agent turn does not end and Sol's single wait does not return. Only `DONE`, `NEEDS_SOL_REVIEW`, or `NEEDS_SOL_RELAY` ends that turn. Healthy supervision never uses repeated background-cell `wait(cell_id)` calls; a chunk lost to an unexpected background-cell yield simply observed nothing and is retried with the accumulator unchanged.

### Completion handoff

When the worker finishes, Luna calls `summarize_v1_worker_handoff` once and returns its JSON verbatim after the `DONE` line. The handoff is built deterministically from the persisted worker rollout, so the watchdog never reconstructs the run in prose and the summary cannot grow into a second transcript. It carries the worker status, the delegated task, the worker's own final message (where it states its result and root cause), the paths named by its persisted mutation calls, the build/test commands it ran with `passed`/`failed`/`unknown` outcomes, capped material warnings, the watchdog intervention record, and two decision fields:

- `material_concern: false` with `parent_action: "use_handoff"` — nothing in the persisted run warrants parent inspection. Sol answers from the handoff and the worker's final result, and does not re-inspect the transcript or repository to reconfirm routine work.
- `material_concern: true` with `parent_action: "review_concern"` — a non-clean terminal state, a persisted error, a failed verification, a suspicious health screen, or a concrete concern Luna stated. Sol inspects only what that concern requires.

`verification_missing` and `no_mutation` are reported as facts and never make a handoff materially concerning on their own — a read-only task legitimately produces neither.

Known limitation: the handoff reads the same tail-capped rollout window as the rest of the watcher (8 MiB by default). On a rollout larger than that window the earliest records fall outside it, so `task_summary` can resolve to a later message and the earliest `files_changed` entries can be missing. Streaming the whole rollout while retaining only the bounded facts is the eventual fix.

### Watchdog intervention

Ordinary corrective guidance is Luna's job. When the health screen reports `progress_stall`, `pre_mutation_stall`, or `post_mutation_stall`, Luna inspects one small detailed window and sends the matching fixed continuation to the same worker through `send_input` with `interrupt=false`, then resumes the same health-window cadence without waking Sol. The continuation texts are fixed so a cheap model never authors technical instruction; Luna sends at most one per stall class and at most two per run.

Sol is woken only for cases that need stronger judgement: a `post_guidance_stall` against guidance that was already delivered (the replacement path), a worker still materially stuck after Luna's guidance, an ambiguous technical or design decision, a terminal/unreadable state, or an unrecoverable watchdog transport or Code Mode failure. Taking a long time or making one recoverable mistake is not an escalation.

V1 documents no sibling-safe `send_input` the way this plugin deliberately provides a sibling-safe `wait_v1_agent`. If `send_input` to the worker is unavailable to a watchdog, Luna returns `NEEDS_SOL_RELAY` with the exact continuation text and Sol delivers it verbatim without inspecting the worker, then re-enters the same one-hour wait. That costs one small parent turn instead of the full inspect-diagnose-steer cycle, and Luna stays the sole routine observer of the worker.

After escalation, inactivity alone is not grounds to abandon a worker. If detailed inspection still shows `running` with recent persisted activity, Sol keeps that worker unless there is an independent terminal, unreadable, error, or clear loop signal.

A `progress_stall` follows the same principle. On the first stall Luna inspects the detailed trace and, if it confirms an established diagnosis and concrete plan, sends one focused continuation to the same worker telling it to implement the smallest supported fix now rather than investigating further; the worker is not replaced and Sol is not woken. Luna also checks there whether the worker broadened past the original task after already finding a sufficient fix, and may add one sentence telling it to defer adjacent architectural concerns. If the same worker stalls again after that explicit guidance — reported as `progress_stall_after_guidance`, or as `post_guidance_stall` when it simply resumed investigating without mutating anything — replacement becomes justified, and replacement is Sol's decision, so Luna escalates instead of guiding again. None of this adds polling: progress analysis happens only at the existing health-window boundaries.

### Worker role selection

Qwen delegation spawns the registered `qwen` agent type/role. The skill forbids emulating that role with a generic `worker` spawn plus a `qwen3.8-27b-uncensored-sharp` model override: a model override does not carry the role's `model_provider="lmstudio"` configuration, so the local model name is routed through the parent's provider, and the spawn is not the configured local Qwen worker. If the spawn runtime does not expose `qwen` as an agent type, the parent fails immediately and reports the configured role as unavailable rather than substituting one.

Luna is different only because the watchdog's whole contract is the prompt in the skill, so it is requested directly by model. That shortcut does not generalize to the worker.

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
Luna owns routine supervision, including ordinary corrective guidance.
Wait on Luna and do nothing else while it reports no terminal result.
After Luna returns DONE with a clean handoff, answer from that handoff and
Qwen's final result; only investigate further if the handoff names a concern.
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

The Code Mode execution wrapper is implemented upstream in Codex rather than in this repository. Focused skill tests therefore lock the required generated invocation contract (one-hour parent yield, one 225-second MCP chunk per Luna execution composed across turns, one health inspection per completed logical window, a turn boundary being continuation rather than failure, Luna never ending its turn between chunks, no healthy background-cell polling, watchdog-owned first-stall intervention, the repeated-stall escalation to the parent, the parent non-participation and clean-handoff rules, the relay fallback, and local-worker reasoning omission), while the server tests lock the MCP timeout, health-window, and handoff schema. The watcher tests drive the whole cross-turn supervision loop one turn at a time, so window composition, the single inspection at the boundary, early worker completion, missing-worker accounting, and transport-failure retries are all covered without a live runtime. `test/handoff.test.mjs` locks the deterministic handoff itself.
