# Changelog

## 0.7.1

Reliability fix for the v0.7.0 supervision architecture: let Luna compose a long logical health window across its own ordinary turns instead of requiring one long-lived Code Mode execution.

v0.7.0 moved routine supervision from Sol to Luna and that part worked. What did not work was how Luna was told to wait. The contract required the whole 900000 ms Qwen health window to be composed inside ONE foreground Code Mode execution holding a 960000 ms outer yield, so the four transport-safe wait chunks were loop iterations inside a single tool call. The real Codex runtime does not guarantee an execution stays attached that long, and it ended the execution at roughly the first health-window boundary. The contract treated that as an enclosing runtime failure, so the run died on `NEEDS_SOL_REVIEW: watchdog Code Mode execution could not remain attached` after about fifteen minutes of healthy supervision.

**Chunked supervision is the normal path.** Luna now runs exactly one `wait_v1_agent` chunk per Code Mode execution inside a 240000 ms outer yield, and composes the logical window across as many executions and model turns as it takes. A 900000 ms Qwen window is four ordinary Luna turns. No execution has to survive longer than one 225000 ms chunk. The inspection cadence is unchanged: one `inspect_v1_agent_health` per completed logical window, still 900000 ms for Qwen, 300000 ms for Ornith, and 600000 ms for an unknown local worker.

**A turn boundary is not a failure.** The `NEEDS_SOL_REVIEW: watchdog Code Mode execution could not remain attached` terminal line is removed. An execution ending between chunks is ordinary continuation: it costs no elapsed health-window time, counts toward no failure limit, and never escalates by itself. A chunk genuinely lost to a background-cell yield still observes nothing, still contributes zero elapsed time, still never counts as a missing worker, and is retried under the same existing three-attempt transport limit.

**Accumulator state crosses turns in the arguments.** The health-window accumulator was already stateless, so this needed no redesign — only the state that used to live in JavaScript loop variables had to move into it. `wait_v1_agent` now also accepts and returns `missing_health_windows`, and every windowed result carries `health_window.next_wait_args`: a complete, ready-to-send argument object with the exact `thread_id`, the next `timeout_ms`, the same `health_window_ms`, and the carried accumulator, already reset when the chunk completed a window. `health_window.next_action` names the one thing to do before the next chunk — `continue_window`, `inspect_health`, or `note_missing_window` — so the boundary is never watchdog arithmetic. `elapsed_ms` / `found_in_window`, their `elapsed_health_window_ms` / `found_in_health_window` aliases, `inspect_now`, and `missing_window` are all unchanged.

**One continuation recipe, not two.** `next_wait_args` is now the only continuation mechanism the watchdog contract teaches. The v0.6.5 recipe — assign `elapsed_health_window_ms` from `health_window.elapsed_ms` and `found_in_health_window` from `health_window.found_in_window` — is equivalent inside an incomplete window but wrong at a boundary, where `next_wait_args` has already reset and those fields still report the completed window's 900000/true. A watchdog following the old recipe would start every new window already full, so the next 225000 ms chunk would look like another completed window and health would be inspected every chunk instead of every fifteen minutes. The raw fields and aliases remain in the API for diagnostics and backward compatibility; the contract and the tool schema now label them as such and name `next_wait_args` as the single source of next-call arguments.

**Sol stays exactly as dormant as in v0.7.0.** The parent still enters one native `wait_agent` on the watchdog with a matching one-hour Code Mode yield and does nothing else. Luna's chunking is invisible to it because Luna never finishes a message between chunks: its agent turn does not end, so the parent's wait does not return. The contract states this from both sides — Luna may only end its turn on `DONE`, `NEEDS_SOL_REVIEW`, or `NEEDS_SOL_RELAY`, and the parent must not wake, poll, or participate because Luna needed another turn.

Preserved unchanged: Luna-owned routine supervision, the compact deterministic completion handoff and `parent_action: use_handoff`, Luna's direct intervention for `progress_stall`, `pre_mutation_stall`, and `post_mutation_stall`, the v0.6.6 post-mutation-stall behavior, exceptional Sol escalation and the `NEEDS_SOL_RELAY` fallback, the intervention limits, the registered `qwen` role requirement with no generic worker fallback, the Qwen developer prompt, every health threshold and the signal check order, `interrupt=false` for ordinary guidance, and the 225000 ms transport-safe wait cap.

No token savings are claimed. Luna now spends roughly four inferences per Qwen health window instead of one, and the v0.7.0 measurement of Luna's own usage looked cache-dominated rather than reasoning-dominated; both need separate benchmarking. The economic target of v0.7.0 — Sol below the direct-Sol baseline — is structurally untouched.

## 0.7.0

Move routine supervision off the expensive parent and onto the cheap watchdog.

The parent's supervision cost was structural, not incidental: it woke on every escalation, re-inspected the worker, re-derived the watchdog's diagnosis, authored ordinary corrective guidance itself, and then reviewed the worker's changes from the transcript on completion. Luna tokens are cheap and the local worker is free, so all of that routine work now belongs to Luna and the parent pays only for final judgement.

**Luna owns routine supervision.** After the worker and watchdog are running, the parent does not inspect the worker thread, poll its progress, read intermediate transcript, duplicate Luna's diagnosis, issue ordinary guidance, or periodically check that the worker is still alive. Waiting on the watchdog is its whole supervision duty. The wait mechanism is unchanged: one native one-hour `wait_agent` inside a matching one-hour Code Mode yield.

**Luna intervenes itself.** `progress_stall`, `pre_mutation_stall`, and `post_mutation_stall` are now handled by the watchdog: it inspects one small detailed window and sends the matching fixed continuation to the same worker through `send_input` with `interrupt=false`, then resumes the same health-window cadence. The continuation texts are fixed so a cheap model never authors technical instruction, and Luna sends at most one per stall class and at most two per run. The cadence, thresholds, and replacement rules are unchanged.

**Escalation is exceptional.** The parent is woken for a `post_guidance_stall` against guidance already delivered (the replacement path, which remains a parent decision), a worker still materially stuck after Luna's guidance, an ambiguous technical or design decision, a terminal/unreadable state, or an unrecoverable watchdog transport or Code Mode failure. Taking a long time or making one recoverable mistake is not an escalation.

**Compact completion handoff.** New MCP tool `summarize_v1_worker_handoff` builds the parent-facing summary deterministically from the persisted worker rollout — worker status, delegated task, the worker's own final message, paths named by its persisted mutation calls, build/test commands with `passed`/`failed`/`unknown` outcomes, capped material warnings, and the watchdog intervention record. Because it is tool-built and capped, the handoff cannot grow into a second transcript. Luna calls it once and returns its JSON verbatim after `DONE`.

**The parent trusts a clean handoff.** `parent_action: "use_handoff"` means nothing in the persisted run warrants inspection, and the skill states explicitly that the parent must not re-inspect the worker transcript or the repository merely to reconfirm routine work. `parent_action: "review_concern"` scopes the parent to the specific concern. `verification_missing` and `no_mutation` are reported facts and are never materially concerning on their own.

**V1 API limitation.** V1 documents no sibling-safe `send_input` the way this plugin deliberately provides a sibling-safe `wait_v1_agent`, and there is no way to asynchronously wake a genuinely dormant parent. The closest clean design is implemented: the parent blocks on the watchdog result rather than supervising the worker, and if `send_input` to the worker is unavailable to a watchdog, Luna returns the new `NEEDS_SOL_RELAY` terminal line with the exact continuation text. The parent delivers it verbatim without inspecting the worker and re-enters the same wait — one small parent turn instead of the full inspect-diagnose-steer cycle, with Luna still the sole routine observer.

**Recognize Codex's own patch applier.** Qwen edits through `& $codex --codex-run-as-apply-patch $patch`. The flag is hyphenated, so the underscored `apply_patch` spelling never matched it and every real Qwen edit persisted as a non-mutation: an empty `files_changed`, a spurious `no_mutation` warning, and a `post_mutation_stall` that could never fire. Mutation classification now matches the hyphenated flag, and the existing patch-body path extraction reads the changed file straight out of the persisted script.

Preserved unchanged: the v0.6.6 post-mutation-stall thresholds and its "first stall keeps the same worker" rule, every stall-signal threshold and the signal check order, the health-window cadence and accumulator contract, the registered-`qwen`-role requirement and its fail-fast behavior, the refusal to fall back to a generic `worker` spawn with a model override, mutation safety, and `interrupt=false` for all non-cancellation steering.

Known limitation: the handoff reads the same tail-capped rollout window as the rest of the watcher (8 MiB by default), so on a rollout larger than that window `task_summary` can resolve to a later message and the earliest `files_changed` entries can be missing.

No token reduction is claimed here; it has not been benchmarked. The change removes the structural sources of duplicated parent supervision.

## 0.6.7

Keep `SERVER_INFO` in step with the manifests; drop the unmeasured persisted-provider claim from the worker-role rule.

## 0.6.6

Require the registered `qwen` role for Qwen delegation and fail fast when it is unavailable. Detect the `post_mutation_stall`: a worker that changed the repository and then kept investigating instead of finishing.

## 0.6.5

Harden the health-window accumulator by exposing `elapsed_health_window_ms` / `found_in_health_window` aliases alongside the canonical returned fields.

## 0.6.4

Compaction-independent progress-stall detection: `pre_mutation_stall` and `post_guidance_stall`, with `post_guidance_stall` checked before the first-stall signals.

## 0.6.3

Fix the Luna health-window cadence and add `progress_stall` detection.
