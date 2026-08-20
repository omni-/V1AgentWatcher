# V1 Agent Watcher

A small Codex plugin for supervising V1 child agents, especially local-model workers delegated from a stronger parent model.

Codex V1 can spawn, wait for, interrupt, and send follow-up input to child agents, but the parent does not get a useful live view of the child's intermediate progress. Codex already persists child activity under `~/.codex/sessions/.../rollout-*.jsonl`. V1 Agent Watcher exposes a compact view of that persisted activity back to the parent as MCP tools.

## Tools

- `list_v1_agents` — list recent child rollout sessions and their thread/parent/provider metadata.
- `inspect_v1_agent` — inspect recent reasoning, assistant messages, and tool activity for a specific child.
- `inspect_latest_v1_agent` — convenience tool for supervising the most recently active child, optionally filtered by cwd/provider.

The watcher intentionally returns only a short recent window and truncates individual events so supervision costs far fewer parent-model tokens than replaying the full rollout.

## Install in Codex

Add this repository as a plugin marketplace, then install the plugin:

```powershell
codex plugin marketplace add omni-/V1AgentWatcher
codex plugin add v1-agent-watcher@v1-agent-watcher
```

Restart Codex after installation. The bundled stdio MCP server uses only Node.js built-ins and needs no `npm install`.

## Typical parent prompt

```text
Delegate the implementation to the `ornith` agent. While it is working, use
V1 Agent Watcher occasionally to inspect its progress. If it is looping or
following a clearly invalid premise, send one concise corrective message.
After it finishes, review the diff yourself.
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
