---
name: supervise-v1-agent
description: Delegate routine supervision of a running Codex V1 child agent to a cheap persistent Luna watchdog that guides the worker directly, and keep the expensive parent dormant until a compact structured completion handoff or a genuine escalation arrives.
---

# Supervise V1 Agent

Use a persistent `gpt-5.6-luna` sibling as the routine supervisor. The parent starts the worker and the watchdog, then stays out of the run. It must not wake on healthy cadence boundaries, must not re-solve or independently review the worker's engineering task while the worker is running, and must not perform the routine supervision the watchdog already owns.

Luna tokens are cheap and the worker is local; the parent's tokens are the expensive resource. Every routine observation of the worker therefore belongs to Luna, and the parent pays only for the final judgement.

## Required architecture

1. Spawn the real V1 worker as its registered agent type and retain its exact thread ID. For Qwen delegation that is the registered `qwen` agent type/role; never emulate it with a generic `worker` spawn plus a Qwen model override. See "Worker role selection" below. Do not pass an explicit granular `reasoning_effort` when the worker runs on a local OpenAI-compatible provider such as `lmstudio`. Note that omitting it inherits the parent effort rather than suppressing the provider's unsupported-setting fallback. See "Local-worker reasoning configuration" below.
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
4. Luna owns routine supervision for the whole run: it waits on the worker, runs the deterministic health screen at the cadence below, diagnoses the observable stall signals, and sends ordinary corrective guidance to the worker itself. The watchdog stays silent while the worker is healthy and returns only when the worker completes or when something genuinely requires the parent.

   Luna composes each logical health window from several transport-safe wait chunks, and those chunks run across several of Luna's own Code Mode executions and model turns. That is normal and is invisible to the parent: Luna never finishes a message between chunks, so its agent turn does not end and the parent's single native wait does not return. The parent must not treat Luna's internal chunking as something to observe, poll, drive, or reason about, and must not shorten its own wait because of it.
5. On completion, Luna returns `DONE` plus one compact structured handoff produced by `summarize_v1_worker_handoff`. On a genuine escalation it returns `NEEDS_SOL_REVIEW` or `NEEDS_SOL_RELAY`. See "Watchdog terminal results" and "Parent responsibilities" below.
6. Retain the exact worker and watchdog thread IDs in the final report so the human can measure the completed run afterward with `v1usage -Worker <worker-id> -Watchdog <watchdog-id>`.

After the watchdog is spawned, the parent must remain silent until the watchdog returns a terminal line, the user provides new input, the native one-hour wait genuinely expires, or an actual tool/runtime error requires parent action. A healthy `wait_agent` timeout is not a progress update; re-enter the same explicit one-hour wait immediately.

A healthy long wait must never degrade into model-authored background-cell polling. Repeated `wait(cell_id)` calls are not a normal or acceptable supervision path. If Code Mode rejects the explicit 3600000 ms outer yield because the active runtime advertises a lower maximum, or unexpectedly returns `Script running with cell ID ...` before the native wait has completed, treat that as a Code Mode runtime failure: report it clearly and stop the supervision attempt instead of polling the cell. The active runtime must support and accept the one-hour outer yield for this workflow.

Always address the worker by exact `thread_id`. A watchdog is itself a child rollout and may be newer than the worker, so latest-session selection is unsafe after the watchdog has been spawned.

## Parent responsibilities

While the worker is running, the parent must NOT:

- inspect the Qwen thread or read intermediate worker transcript
- poll Qwen progress or periodically check whether the worker is still alive
- duplicate Luna's diagnosis or re-derive the health signals itself
- issue ordinary corrective guidance
- emit progress commentary or interim summaries
- wake, poll, prompt, or otherwise participate because Luna needed another turn to finish composing a health window

Luna performs every one of those jobs. Waiting on the watchdog is the parent's whole supervision duty, and waiting must never consume worker context. Luna needing many cheap turns to compose a health window requires no parent inference at all: the parent stays in the same native one-hour wait until Luna returns `DONE`, `NEEDS_SOL_REVIEW`, or `NEEDS_SOL_RELAY`.

### Trust a clean handoff

If the watchdog reports successful completion with no material concern, use its handoff and the worker's final result to answer the user. Do not independently re-inspect the worker transcript or repository merely to reconfirm routine work.

The handoff's `parent_action` field states this outcome deterministically:

- `use_handoff` — nothing in the persisted run warrants parent inspection. Answer from `result_summary`, `files_changed`, and `verification`.
- `review_concern` — the handoff carries at least one material warning. Inspect only what is needed to resolve that specific concern, and nothing else.

A `warnings` entry is a reason to look at one thing, not a reason to replay the run. `verification_missing` and `no_mutation` are reported facts and do not by themselves make a handoff materially concerning.

### Parent escalation work

`NEEDS_SOL_REVIEW` is the parent's cue to apply stronger-model judgement. Only then may the parent call `inspect_v1_agent` for a small detailed window and decide on replacement, interruption, or its own steering. See "Repeated progress stall after guidance". A worker that is still `running` with recent persisted activity must be preserved unless inspection also shows an independent concrete terminal, error, unreadable, or repeated-loop signal.

`NEEDS_SOL_RELAY` is not a review request. Luna has already decided on ordinary guidance but could not deliver it; the parent sends the quoted text verbatim to the worker through `send_input` with `interrupt=false`, does not inspect the worker, and immediately re-enters the same one-hour watchdog wait.

## Worker role selection

For Qwen delegation, spawn the registered `qwen` agent type/role.

Never emulate the Qwen role by spawning `agent_type="worker"` with `model="qwen3.8-27b-uncensored-sharp"`. A model override does not carry the role's `model_provider="lmstudio"` configuration, so the local model name is routed through the parent's provider instead of LM Studio. The spawn is then not the configured local Qwen worker, whatever it appears to be named.

If the V1 spawn runtime does not expose `qwen` as an agent type, fail immediately and report that the configured Qwen role is unavailable. Do not substitute `worker` plus a Qwen model override, and do not silently delegate to a hosted worker instead. A missing role is a configuration problem for the human to fix, not a supervision decision.

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

## Watchdog terminal results

Luna returns exactly one of three terminal shapes, and nothing else:

```text
DONE: worker completed
<the summarize_v1_worker_handoff JSON, verbatim>
```

```text
NEEDS_SOL_REVIEW: <one concise sentence describing the observable state>
```

```text
NEEDS_SOL_RELAY: <the exact guidance text Luna wants delivered to the worker>
```

`DONE` is the normal ending. `NEEDS_SOL_REVIEW` is reserved for the exceptional cases listed in the watchdog contract. `NEEDS_SOL_RELAY` exists only because sending input to a sibling thread may be outside a watchdog's V1 ownership; see "Sibling guidance delivery".

## Watchdog prompt

Give Luna the following contract, substituting the worker ID, kind, provider, and cwd. Include the health-window accumulator mapping and its two assignment lines verbatim; do not paraphrase them as “track `elapsed_health_window_ms` and `found_in_health_window` via the fields the tool returns”, which invites Luna to assume the returned fields carry the input argument names:

```text
You are the routine supervisor for a V1 subagent. You own normal supervision of
this worker. The parent is dormant and expensive; wake it only for the
exceptional cases listed below.

Worker thread: <exact-thread-id>
Worker kind: <qwen|ornith|unknown>
Observed provider (informational): <provider if known>
Observed rollout cwd (informational): <cwd if known>

Do not solve, diagnose, or review the worker's engineering task.
Do not inspect the repository or open source files.
Do not evaluate whether the worker's technical theory or implementation is correct.
Do not judge which fix is correct or propose a design.
Use only:
1. `wait_v1_agent` targeting the exact worker thread. This plugin operation follows persisted rollout state and is safe for sibling workers; do not use native Codex `wait_agent` from Luna.
2. inspect_v1_agent_health targeting that same exact thread, without provider/cwd filters.
3. inspect_v1_agent, ONLY once immediately before an intervention permitted below, for one small detailed window.
4. `send_input` with `interrupt=false` targeting that exact thread, ONLY to deliver one of the fixed continuation texts below.
5. `summarize_v1_worker_handoff`, exactly once, when the worker has completed.

Loop internally:
- Use a logical health window of 900000 ms for Qwen, 300000 ms for Ornith, or 600000 ms for an unknown local worker.
- Build that logical window from transport-safe `wait_v1_agent` chunks of at most 225000 ms each. Chunks are quiet waits, not health-poll boundaries.
- Run exactly ONE `wait_v1_agent` chunk per Code Mode execution, and compose the logical window across as many executions and model turns as it takes. Do not try to hold one execution attached for the whole logical window: the runtime is not required to keep an execution alive that long, and needing four executions to compose a 900000 ms Qwen window is the normal, expected path. Use this invocation shape for the first chunk of a window:

  ```javascript
  // @exec: {"yield_time_ms": 240000}
  const result = await tools.mcp__v1_agent_watcher__wait_v1_agent({
    thread_id: "<exact-thread-id>",
    timeout_ms: 225000,
    health_window_ms: 900000,
    elapsed_health_window_ms: 0,
    found_in_health_window: false,
    missing_health_windows: 0
  });
  text(JSON.stringify(result));
  ```

  The 240000 ms outer yield covers the 225000 ms chunk with a deliberate 15000 ms completion margin for MCP and wrapper completion. Every individual MCP wait stays at or below 225000 ms, so no single request exceeds the transport-safe limit and no execution has to survive longer than one chunk. If the active runtime advertises a lower maximum yield, lower `timeout_ms` and the outer yield together and keep the 15000 ms margin; the accumulator credits each chunk its actual `waitedMs`, so a shorter chunk changes nothing else. A `completed` or `terminal_error` chunk returns immediately, so worker completion still wakes you early no matter which chunk of the window you are in.

- Carrying the logical window across your own turns is the normal supervision path, not a fallback. The accumulator lives in the arguments you send and the fields the tool returns, never in a live execution, so state survives any number of Code Mode executions and model turns. On every chunk after the first, send back exactly what the previous result told you to send:

  ```javascript
  // @exec: {"yield_time_ms": 240000}
  const result = await tools.mcp__v1_agent_watcher__wait_v1_agent({
    thread_id: "<exact-thread-id>",
    timeout_ms: 225000,
    health_window_ms: 900000,
    elapsed_health_window_ms: 225000,
    found_in_health_window: true,
    missing_health_windows: 0
  });
  text(JSON.stringify(result));
  ```

  Every Code Mode execution starts with a fresh scope, so no JavaScript variable survives from one chunk to the next. Write the carried values in as literals, copied from the previous chunk's `health_window.next_wait_args`. That object is a complete ready-to-send argument set: the exact `thread_id`, the next `timeout_ms`, the same `health_window_ms`, and the carried `elapsed_health_window_ms`, `found_in_health_window`, and `missing_health_windows`. The literals above are the second chunk of a Qwen window whose first chunk completed and observed the worker. `next_wait_args` already contains the post-boundary reset, so send it only after performing that chunk's `health_window.next_action`.

- `health_window.next_action` names the one thing to do before the next chunk, so the boundary is never your own arithmetic:
  - `continue_window` — the window is still accumulating. Send the next chunk immediately and do nothing else.
  - `inspect_health` — this chunk completed the logical window and the worker was observed. Run exactly one `inspect_v1_agent_health`, act on it per the rules below, then send the next chunk.
  - `note_missing_window` — the window completed without any chunk observing the worker. Do not inspect; check `missing_health_windows` against the escalation limit, then send the next chunk.

  The accumulator argument names and the returned field names are deliberately
  different. Map them exactly:

  ```text
  INPUT (argument you send)          OUTPUT (field the tool returns)
  elapsed_health_window_ms    <-     health_window.elapsed_ms
  found_in_health_window      <-     health_window.found_in_window
  missing_health_windows      <-     health_window.missing_health_windows
  ```

  `elapsed_health_window_ms` and `found_in_health_window` are input argument
  names. The canonical returned fields are `health_window.elapsed_ms` and
  `health_window.found_in_window`. After each completed timeout, assign exactly:

  ```text
  elapsed_health_window_ms = result.health_window.elapsed_ms
  found_in_health_window   = result.health_window.found_in_window
  missing_health_windows   = result.health_window.missing_health_windows
  ```

  The returned `health_window` also carries `elapsed_health_window_ms` and
  `found_in_health_window` compatibility aliases holding identical values, so
  either spelling on the returned object is safe; the canonical example above
  keeps using `elapsed_ms` / `found_in_window`. Never re-send
  `elapsed_health_window_ms: 0` after a completed chunk: that restarts the
  logical window, so every chunk looks like the first one and
  `health_window.inspect_now` never becomes true.

- A Code Mode execution ending between chunks is ordinary continuation, not failure. It contributes nothing to any failure count, it does not wake the parent, and it never justifies a `NEEDS_SOL_REVIEW` by itself. Read the accumulator out of the last chunk result and issue the next chunk.
- Never end your agent turn between chunks. Do not emit a message, a status line, a healthy-chunk summary, or any other final text between waits; issue the next chunk directly. The parent is blocked in one native wait on you, and any message you finish on ends your turn and wakes it. Only the terminal lines below may end your turn.
- Do not call `wait(cell_id)`. If a Code Mode execution unexpectedly yields a background cell (`Script running with cell ID ...`) instead of returning the chunk result, that chunk produced no observation: it contributes ZERO elapsed health-window time, says nothing about worker presence or health, and must never increment the missing-worker count. Start a fresh single-chunk execution with the accumulator values unchanged, and count that lost chunk toward the same three-attempt limit as a transport failure.
- If `wait_v1_agent` reports `completed`, produce the completion handoff described under "Completion handoff" and return `DONE`.
- If `wait_v1_agent` reports `terminal_error`, return exactly:
  NEEDS_SOL_REVIEW: <one concise sentence describing that observable state>
- Only a returned `outcome: timeout` is a completed wait chunk, and only a completed chunk contributes its actual `waitedMs` to the current logical health window. A tool exception, MCP failure, transport timeout, or Code Mode yield failure contributes ZERO elapsed health-window time, says nothing about worker presence or health, and must never increment the missing-worker count.
- A completed chunk with `found=true` immediately resets the missing-worker window count and contributes its `waitedMs` to the current logical window. It does NOT trigger a health inspection by itself. Never call inspect_v1_agent_health merely because a chunk returned.
- Call inspect_v1_agent_health exactly once per completed logical health window, only when `health_window.inspect_now` is true — that is, only after completed timeout chunks have accumulated the full window and at least one of them observed the worker. For Qwen this means four completed 225000 ms chunks produce one inspection at 900000 ms, not four inspections.
- After that inspection, reset `elapsed_health_window_ms` to 0 and `found_in_health_window` to false, then begin another complete window. The `next_wait_args` returned by the boundary chunk already carries that reset, so sending it verbatim after the inspection is correct.
- `health_window.missing_window` true means a full window completed with every chunk reporting `found=false`. The tool has already counted it in `health_window.missing_health_windows` and already reset the window inside `next_wait_args`, so do not inspect and do not recount it yourself. Any later chunk that observes the worker clears that count. Escalate only after three consecutive full missing windows, that is only once `health_window.missing_health_windows` reaches 3.
- Retry a failed transport chunk with the accumulator values unchanged, since a failed chunk observed nothing and changed nothing. If three consecutive transport/tool failures prevent observation, return `NEEDS_SOL_REVIEW: watchdog transport unavailable after three attempts`; do not describe the worker as missing or unhealthy. A chunk that completed normally clears the consecutive-failure count even if your turn ended before the next chunk began.
- If state is idle/completed, produce the completion handoff and return `DONE`.
- If health is healthy and state is running, begin another full wait. Do not report this healthy check to the parent.
- Check the stall signals in this order and return on the first match: `post_guidance_stall`, then `post_mutation_stall`, then `progress_stall`/`pre_mutation_stall`, then any other suspicious state. A worker that stalls after guidance usually raises the earlier signals too, so checking `post_guidance_stall` first is what keeps the repeated-stall case distinguishable from the first stall, and `post_mutation_stall` must be recognized before the first-stall branch because a worker that already mutated is in a different state from one that never did.
- If health is suspicious and its signals include `post_guidance_stall`, the worker has ignored guidance that was already delivered. Do not send more guidance. Return exactly:
  NEEDS_SOL_REVIEW: worker resumed investigating after parent guidance without mutating the repository
- Otherwise, if health is suspicious and its signals include `post_mutation_stall`, intervene yourself using the post-mutation continuation below, then resume this loop. Do not wake the parent for it.
- Otherwise, if health is suspicious and its signals include `progress_stall` or `pre_mutation_stall`, intervene yourself using the first-stall continuation below, then resume this loop. Do not wake the parent for it.
- If health is otherwise suspicious, unreadable, aborted, or errored, return exactly:
  NEEDS_SOL_REVIEW: <one concise sentence copied or summarized only from the observable health signal>
- Provider and cwd values are diagnostic context, not identity constraints. Persisted cwd can reflect the parent launch context even when the worker correctly changed its shell cwd.
- A single self-correction is normal. Qwen producing no new persisted output for up to one hour can still be normal model inference and is not suspicious by itself. A single compaction, a long inference, a clean worktree, and one large tool result are each normal on their own; only the deterministic stall signals combine them.
- Keep the normal health-window cadence. `pre_mutation_stall` and `post_guidance_stall` are deterministic enough that the first scheduled inspection catches them; do not shorten the window or add extra polling to find them sooner. Intervening does not change the cadence either: after sending a continuation, begin another full health window.
- If health inspection itself cannot inspect the exact thread, wait another full health window before retrying. Escalate only after three such full-window inspection failures, and describe the inspection failure rather than claiming the worker is unhealthy.

Intervention limits:
- Send at most one continuation per stall class, and at most two continuations in the whole run.
- The continuation texts below are fixed. Send one verbatim. You may append at most one sentence of scope guidance where the section below explicitly permits it. Never author your own technical instruction, diagnosis, or fix.
- If a third intervention would be needed, return instead:
  NEEDS_SOL_REVIEW: worker remains materially stuck after watchdog guidance
- Any ambiguous technical or design decision belongs to the parent. Return:
  NEEDS_SOL_REVIEW: <one concise sentence naming the decision the parent must make>

Completion handoff:
- Call `summarize_v1_worker_handoff` exactly once, with the exact worker thread id, `watchdog_interventions` set to the number of continuations you sent, `watchdog_note` set to one short sentence only if you intervened, and `watchdog_concern` set only if you have a concrete remaining concern for the parent.
- Return the line `DONE: worker completed` followed by that tool's JSON result verbatim.
- Add nothing else. Never include a chronological account, reasoning trace, long command output, worker transcript, or your own engineering assessment.

Do not emit periodic progress updates. Continue until one terminal line above can be returned.
```

## Sibling guidance delivery

Luna reaches the worker through V1 `send_input` with `interrupt=false`, addressing the exact worker `thread_id`. V1 does not document sibling `send_input` as ownership-free the way this plugin's `wait_v1_agent` is deliberately sibling-safe, so the delivery path can be unavailable to a watchdog.

If `send_input` to the worker is rejected as unavailable or out of scope, Luna must not retry, must not inspect further, and must not improvise. It returns:

```text
NEEDS_SOL_RELAY: <the exact continuation text, verbatim>
```

The parent then delivers exactly that text through `send_input` with `interrupt=false` and re-enters the same one-hour watchdog wait without inspecting the worker. This costs the parent one small turn instead of the full inspect-diagnose-steer cycle, and it keeps Luna the sole routine observer of the worker.

Do not use `interrupt=true` for normal supervision. In V1 it aborts the active child turn and can leave external-provider workers stopped. Reserve interruption for intentional cancellation. If a worker must be abandoned, close it and spawn a replacement with the corrected premise in its initial task. That decision belongs to the parent.

## Deterministic health screen

`inspect_v1_agent_health` is behavioral screening, not code review. It returns a compact state, `healthy` or `suspicious`, a short signal list, and aggregate recent counts. It intentionally omits the detailed trace.

Potential suspicious signals include repeated premise reversals, repeated identical or near-identical calls, repeated failures without a changed command, repeated context compaction, conservative long inactivity, terminal error/abort states, `progress_stall`, `pre_mutation_stall`, `post_guidance_stall`, and `post_mutation_stall`. One self-correction, meaningfully different searches, or ordinary Qwen latency should remain healthy.

Activity age comes from the newest parseable persisted `event_msg` or `response_item` timestamp. Rollout file mtime is only a fallback because Windows can leave mtime stale while a process holds and appends the JSONL. Premise-reversal screening requires explicit backtracking language; ordinary discourse markers such as bare “wait” or “actually” are not reversals.

### progress_stall

`progress_stall` recognizes a worker that is technically active but no longer making engineering progress. It is computed only from persisted rollout facts, never from a judgement about the engineering task, and requires all of:

1. the worker committed to an implementation phase (an explicit implementation plan or an explicit statement that it is now applying the change);
2. at least two context compactions occurred after that commitment;
3. no persisted repository-mutation call occurred since — mutation evidence is any persisted patch/write/mutating-shell call, including Codex's own applier invoked as `& $codex --codex-run-as-apply-patch $patch`, and any such call resets all of this evidence;
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

`post_guidance_stall` applies once the worker has already been told to implement, whether that guidance came from the watchdog or from the parent. It also requires no compaction:

1. guidance occurred (a later user message that is not the delegated task, not a framework `<environment_context>` preamble, and not a compaction bridge summary);
2. zero repository mutations since that guidance;
3. at least 3 investigation/read/search calls since that guidance.

Only the newest guidance is in scope, so earlier guidance cannot poison later work.

### post_mutation_stall

`post_mutation_stall` covers the state after implementation has already started: the worker changed the repository, then kept investigating — validation approaches, adjacent designs, test infrastructure — without editing again. It requires no compaction, no implementation-phase phrase, no parent guidance, no failed command, and no repeated command:

1. the current turn is still active;
2. at least one repository mutation occurred in the current turn;
3. at least 30 minutes have elapsed since the newest mutation;
4. at least 10 investigation/read/search calls occurred after that newest mutation;
5. no later repository mutation occurred.

The newest mutation is the reset point, so a later edit restarts both the elapsed window and the investigation count. Build and test commands are not investigation calls, so validating an implementation does not accumulate toward the threshold.

Its thresholds are calibrated on Qwen benchmark traces, so like `pre_mutation_stall` only a Qwen worker escalates on it; for Ornith and unknown local workers the fact is reported and the result stays healthy on that signal alone. The supporting facts are `post_mutation_stall` and `investigations_since_latest_mutation`, alongside the existing `seconds_since_mutation`, which already measures elapsed time from the newest mutation.

One compaction, one long inference, a clean worktree before implementation begins, and one huge tool result are each insufficient alone and deliberately do not escalate. Repeated compaction alone is also insufficient now that progress_stall is the discriminating signal: it is reported, and escalates only when an independent signal corroborates it.

`large_tool_output` is reported as a low-severity explanatory fact and never escalates by itself. It counts tool results above roughly 20000 tokens, sized from structured token metadata first, then from the pre-truncation count Codex writes into the output body (`Original token count: 80219`), and only then from a character estimate — the persisted body is truncated, so its stored length understates a pathological result.

## Watchdog intervention

Ordinary corrective guidance is the watchdog's job, not the parent's. Luna sends one concise correction through V1 `send_input` with `interrupt=false`, or omits the flag only when omission means queued input. The continuation texts are fixed so a cheap model never has to author technical instruction.

### First progress stall: continue the same worker

A `progress_stall` escalation never justifies killing a live worker by itself. Recent persisted activity still means the worker is alive; suspicion is a reason for a narrow correction, not automatic abandonment.

On the first `progress_stall` or `pre_mutation_stall`:

1. Call `inspect_v1_agent` once for a small detailed window.
2. If that trace confirms the diagnosis is already established, the implementation plan is concrete, and the worker has repeatedly compacted, replanned, or simply kept investigating without mutating the repository, send ONE focused continuation to the SAME worker through `send_input` with `interrupt=false`:

   ```text
   Stop investigating. Use the diagnosis and implementation plan you already established.
   Implement the smallest supported fix now, then run the focused tests.
   Do not broaden scope unless implementation evidence requires it.
   ```

3. Resume the same worker and the same health-window loop. Do not replace the worker and do not spawn a second worker, and do not wake the parent for this.

While reviewing that trace, also check whether the worker expanded past the originally requested task after it had already identified a sufficient fix. If it did, the continuation may add one sentence telling it to implement the smallest fix supported by the original task and to defer adjacent architectural concerns unless correctness requires them. This is a scope instruction, not a code review; the watchdog never judges which fix is correct.

### First post-mutation stall: continue the same worker

A `post_mutation_stall` is not the repeated-stall case, even when guidance has already been sent earlier in the run. Earlier guidance may be exactly why the mutation exists: the worker was told to implement, and it did. A later post-mutation stall therefore does not mean the worker ignored that guidance, and it does not enter the replacement path.

On the first `post_mutation_stall`:

1. Call `inspect_v1_agent` once for a small detailed window.
2. If that trace confirms the implementation has already been made and the worker is stuck in validation or adjacent investigation, send ONE concise continuation to the SAME worker through `send_input` with `interrupt=false`:

   ```text
   Preserve the implementation you already made.
   Stop expanding into adjacent approaches or validation infrastructure.
   Run the narrowest existing build/tests that apply, then finish and report.
   Do not refactor production code or add new infrastructure solely to make validation easier unless the original task requires it.
   ```

3. Resume the same worker and the same health-window loop. Do not replace the worker and do not spawn a second worker, and do not wake the parent for this.

If the worker then trips `post_guidance_stall` against THIS newest continuation — at least three read/search calls and zero mutations since it — the existing replacement policy applies normally, and that is the point at which the parent is woken. In other words, first guidance -> mutation -> `post_mutation_stall` does not justify replacement, while `post_mutation_stall` -> focused continuation -> `post_guidance_stall` may.

### Repeated progress stall after guidance

If the same worker stalls again after that explicit implementation guidance — another compaction/replanning cycle with no mutation, reported as `progress_stall_after_guidance: true`, or renewed investigation with no mutation since the guidance, reported as `post_guidance_stall: true` — replacement becomes justified, and replacement is a parent decision. The watchdog stops guiding and returns `NEEDS_SOL_REVIEW`.

The parent then closes that worker and spawns a replacement whose initial task carries the established diagnosis, the implementation plan, and an explicit instruction to implement before investigating further.

Do not add progress polling to detect any of this. Progress analysis happens only at the existing logical health-window boundaries or when the worker emits a terminal or suspicious state.

An inactivity-only or watchdog-transport escalation is a request to inspect, not permission to abandon the worker. If detailed inspection shows `state: running` and recent persisted activity below the applicable inactivity threshold, keep the existing worker. Replace or interrupt only when there is separate concrete evidence such as a terminal abort/error, an unreadable rollout that prevents safe supervision, or a clear repeated loop/failure pattern. Do not weaken those terminal and loop cases.

## Completion handoff

`summarize_v1_worker_handoff` builds the parent-facing summary deterministically from the persisted worker rollout, so the watchdog never reconstructs the run in prose and the handoff cannot grow into a second transcript. It returns:

- `worker_thread_id`, `worker_status`
- `task_summary` — the delegated task, truncated
- `result_summary` — the worker's own final message, truncated. This is where the worker states its result and its root cause; the handoff forwards it rather than re-deriving it.
- `files_changed` — the paths named by persisted repository-mutation calls
- `verification` / `verification_performed` — persisted build/test commands with `passed`, `failed`, or `unknown` outcomes
- `warnings` — material warnings, capped
- `watchdog` — whether Luna intervened, how many times, and one short reason when materially relevant
- `material_concern` and `parent_action`

A clean run therefore arrives at the parent as `material_concern: false` and `parent_action: "use_handoff"`, which is the explicit signal that no independent re-investigation is warranted.

The handoff reads the same tail-capped rollout window as the rest of the watcher. On a rollout larger than that window the earliest records fall outside it, so `task_summary` can resolve to a later message and the earliest `files_changed` entries can be missing.

## Graceful fallback

Plugins currently distribute this workflow as a skill plus MCP server; they do not need to install user-specific `.codex/agents` configuration. Request Luna directly in the spawn call.

That model-only spawn is specific to the watchdog, whose whole contract is the prompt in this skill. Do not generalize it to the worker: role configuration such as `model_provider` lives in the registered agent definition and not in the model name, so a Qwen worker must be spawned as the `qwen` agent type. See "Worker role selection".

The sibling-safe `wait_v1_agent` MCP operation is part of this plugin and is required for the Luna architecture. If it is unavailable, report the missing plugin capability rather than substituting native sibling `wait_agent`, which is ownership-scoped and may be unavailable to Luna. If `summarize_v1_worker_handoff` is unavailable, Luna returns `DONE: worker completed` with the worker's final message and nothing else; the parent may then inspect once. If `gpt-5.6-luna` itself is unavailable, the parent may perform the same persisted-rollout wait/compact-health loop while preserving the model-specific cadence and three-attempt startup grace.
