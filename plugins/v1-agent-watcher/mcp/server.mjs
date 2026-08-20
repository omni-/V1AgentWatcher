#!/usr/bin/env node
import readline from 'node:readline';
import {
  formatAgentList,
  formatInspection,
  inspectAgentSession,
  listAgentSessions,
} from './watcher.mjs';

const SERVER_INFO = { name: 'v1-agent-watcher', version: '0.1.0' };
const TOOLS = [
  {
    name: 'list_v1_agents',
    description: 'List recent Codex child-agent rollout sessions. Use this to find a running V1 subagent before inspecting it.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Optional exact project working directory to filter child sessions.' },
        provider: { type: 'string', description: 'Optional model provider filter, for example lmstudio.' },
        parent_thread_id: { type: 'string', description: 'Optional parent Codex thread id.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 12 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_v1_agent',
    description: 'Inspect recent persisted reasoning, assistant output, and tool activity for a Codex child agent. Use during waits to detect loops or bad approaches before sending corrective input.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'Exact child thread id. Preferred when known.' },
        nickname: { type: 'string', description: 'Agent nickname or agent path. Used when thread_id is omitted.' },
        cwd: { type: 'string', description: 'Optional exact project cwd filter.' },
        provider: { type: 'string', description: 'Optional provider filter, for example lmstudio.' },
        parent_thread_id: { type: 'string', description: 'Optional parent thread filter.' },
        event_limit: { type: 'integer', minimum: 1, maximum: 100, default: 16 },
        text_limit: { type: 'integer', minimum: 80, maximum: 4000, default: 700 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_latest_v1_agent',
    description: 'Inspect the most recently active Codex child agent, optionally filtered by project cwd or provider. Convenience tool for supervising a single delegated worker.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Optional exact project cwd filter.' },
        provider: { type: 'string', description: 'Optional provider filter, for example lmstudio.' },
        parent_thread_id: { type: 'string', description: 'Optional parent thread filter.' },
        event_limit: { type: 'integer', minimum: 1, maximum: 100, default: 16 },
        text_limit: { type: 'integer', minimum: 80, maximum: 4000, default: 700 },
      },
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function resultText(text) {
  return { content: [{ type: 'text', text }] };
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'list_v1_agents': {
      const agents = await listAgentSessions({
        cwd: args.cwd,
        provider: args.provider,
        parentThreadId: args.parent_thread_id,
        limit: args.limit,
      });
      return resultText(formatAgentList(agents));
    }
    case 'inspect_v1_agent': {
      if (!args.thread_id && !args.nickname) {
        return { ...resultText('Provide thread_id or nickname.'), isError: true };
      }
      const result = await inspectAgentSession({
        threadId: args.thread_id,
        nickname: args.nickname,
        cwd: args.cwd,
        provider: args.provider,
        parentThreadId: args.parent_thread_id,
        eventLimit: args.event_limit,
        textLimit: args.text_limit,
      });
      return resultText(formatInspection(result));
    }
    case 'inspect_latest_v1_agent': {
      const result = await inspectAgentSession({
        cwd: args.cwd,
        provider: args.provider,
        parentThreadId: args.parent_thread_id,
        eventLimit: args.event_limit,
        textLimit: args.text_limit,
      });
      return resultText(formatInspection(result));
    }
    default:
      return { ...resultText(`Unknown tool: ${name}`), isError: true };
  }
}

async function handle(message) {
  const { id, method, params = {} } = message;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    try {
      const result = await callTool(params.name, params.arguments ?? {});
      send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `V1 Agent Watcher error: ${error?.message ?? String(error)}` }],
          isError: true,
        },
      });
    }
    return;
  }

  if (id !== undefined && id !== null) rpcError(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  void handle(message);
});
