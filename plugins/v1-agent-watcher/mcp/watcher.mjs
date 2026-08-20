import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_LIST_LIMIT = 12;
const DEFAULT_EVENT_LIMIT = 16;
const DEFAULT_TEXT_LIMIT = 700;

export function getCodexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

function normalizePath(value) {
  if (!value) return null;
  return path.resolve(value).toLowerCase();
}

async function collectRolloutFiles(root, maxFiles = DEFAULT_MAX_FILES) {
  const files = [];

  async function walk(dir) {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  }

  await walk(root);
  return files;
}

async function readFirstLine(filePath, maxBytes = 4 * 1024 * 1024) {
  const handle = await fs.open(filePath, 'r');
  try {
    const chunkSize = 64 * 1024;
    let offset = 0;
    const chunks = [];

    while (offset < maxBytes) {
      const length = Math.min(chunkSize, maxBytes - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      const slice = buffer.subarray(0, bytesRead);
      const newline = slice.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(slice.subarray(0, newline));
        break;
      }
      chunks.push(slice);
      offset += bytesRead;
    }

    return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
  } finally {
    await handle.close();
  }
}

function parseSessionMetaLine(line, filePath, stat) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (record?.type !== 'session_meta') return null;

  const payload = record.payload ?? {};
  const meta = payload.meta ?? payload;
  const threadId = meta.id ?? meta.session_id ?? meta.thread_id ?? null;
  const parentThreadId = meta.parent_thread_id ?? null;

  return {
    threadId,
    parentThreadId,
    cwd: meta.cwd ?? null,
    agentPath: meta.agent_path ?? null,
    agentNickname: meta.agent_nickname ?? null,
    agentRole: meta.agent_role ?? null,
    modelProvider: meta.model_provider ?? null,
    multiAgentVersion: meta.multi_agent_version ?? null,
    createdAt: meta.timestamp ?? record.timestamp ?? null,
    updatedAt: stat.mtime.toISOString(),
    updatedAtMs: stat.mtimeMs,
    filePath,
  };
}

export async function listAgentSessions(options = {}) {
  const codexHome = options.codexHome ? path.resolve(options.codexHome) : getCodexHome();
  const sessionsRoot = path.join(codexHome, 'sessions');
  const maxFiles = clampInt(options.maxFiles, 1, 20000, DEFAULT_MAX_FILES);
  const limit = clampInt(options.limit, 1, 100, DEFAULT_LIST_LIMIT);
  const wantedCwd = normalizePath(options.cwd);
  const wantedProvider = options.provider?.toLowerCase() ?? null;
  const wantedParent = options.parentThreadId ?? null;

  const files = await collectRolloutFiles(sessionsRoot, maxFiles);
  const withStats = await Promise.all(files.map(async (filePath) => {
    try {
      return { filePath, stat: await fs.stat(filePath) };
    } catch {
      return null;
    }
  }));

  withStats.sort((a, b) => (b?.stat?.mtimeMs ?? 0) - (a?.stat?.mtimeMs ?? 0));

  const agents = [];
  for (const item of withStats) {
    if (!item) continue;
    let firstLine;
    try {
      firstLine = await readFirstLine(item.filePath);
    } catch {
      continue;
    }
    const meta = parseSessionMetaLine(firstLine, item.filePath, item.stat);
    if (!meta?.parentThreadId) continue;
    if (wantedCwd && normalizePath(meta.cwd) !== wantedCwd) continue;
    if (wantedProvider && meta.modelProvider?.toLowerCase() !== wantedProvider) continue;
    if (wantedParent && meta.parentThreadId !== wantedParent) continue;
    agents.push(meta);
    if (agents.length >= limit) break;
  }

  return agents;
}

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function truncate(text, max = DEFAULT_TEXT_LIMIT) {
  if (text === null || text === undefined) return '';
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function textBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part && typeof part.text === 'string')
    .map((part) => part.text)
    .filter(Boolean);
}

function summarizeResponseItem(record, textLimit) {
  const payload = record.payload ?? {};
  switch (payload.type) {
    case 'reasoning': {
      const summary = Array.isArray(payload.summary)
        ? payload.summary.map((part) => part?.text).filter(Boolean)
        : [];
      const content = textBlocks(payload.content);
      const text = summary.length ? summary.join(' ') : content.join(' ');
      return text ? { kind: 'reasoning', text: truncate(text, textLimit) } : null;
    }
    case 'message': {
      if (payload.role !== 'assistant') return null;
      const text = textBlocks(payload.content).join(' ');
      return text ? { kind: 'assistant', text: truncate(text, textLimit) } : null;
    }
    case 'function_call': {
      const namespace = payload.namespace ? `${payload.namespace}.` : '';
      const args = truncate(payload.arguments ?? '', Math.min(textLimit, 360));
      return { kind: 'tool_call', text: `${namespace}${payload.name ?? 'function'}${args ? ` ${args}` : ''}` };
    }
    case 'local_shell_call': {
      const action = payload.action ?? {};
      const command = action.command ?? action.cmd ?? action.script ?? JSON.stringify(action);
      return { kind: 'shell', text: truncate(command, Math.min(textLimit, 420)) };
    }
    case 'function_call_output': {
      const output = payload.output ?? payload.result ?? '';
      if (!output) return null;
      return { kind: 'tool_result', text: truncate(typeof output === 'string' ? output : JSON.stringify(output), Math.min(textLimit, 360)) };
    }
    default:
      return null;
  }
}

function summarizeEvent(record, textLimit) {
  const payload = record.payload ?? {};
  switch (payload.type) {
    case 'agent_reasoning':
      return payload.text ? { kind: 'reasoning', text: truncate(payload.text, textLimit) } : null;
    case 'turn_started':
      return { kind: 'state', text: 'turn started' };
    case 'turn_complete':
      return { kind: 'state', text: 'turn complete' };
    case 'turn_aborted':
      return { kind: 'state', text: `turn aborted${payload.reason ? `: ${truncate(payload.reason, 240)}` : ''}` };
    default:
      return null;
  }
}

function eventKey(event) {
  return `${event.kind}\u0000${event.text}`;
}

export function summarizeRolloutLines(lines, options = {}) {
  const eventLimit = clampInt(options.eventLimit, 1, 100, DEFAULT_EVENT_LIMIT);
  const textLimit = clampInt(options.textLimit, 80, 4000, DEFAULT_TEXT_LIMIT);
  const events = [];
  let status = 'unknown';

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    let event = null;
    if (record.type === 'response_item') event = summarizeResponseItem(record, textLimit);
    else if (record.type === 'event_msg') {
      event = summarizeEvent(record, textLimit);
      const type = record.payload?.type;
      if (type === 'turn_started') status = 'running';
      else if (type === 'turn_complete') status = 'idle';
      else if (type === 'turn_aborted') status = 'aborted';
    }

    if (event) {
      event.timestamp = record.timestamp ?? null;
      const previous = events.at(-1);
      if (!previous || eventKey(previous) !== eventKey(event)) events.push(event);
    }
  }

  return { status, events: events.slice(-eventLimit) };
}

async function resolveAgent(options = {}) {
  const agents = await listAgentSessions({
    codexHome: options.codexHome,
    cwd: options.cwd,
    provider: options.provider,
    parentThreadId: options.parentThreadId,
    limit: 100,
    maxFiles: options.maxFiles,
  });

  if (options.threadId) {
    return agents.find((agent) => agent.threadId === options.threadId) ?? null;
  }
  if (options.nickname) {
    const needle = options.nickname.toLowerCase();
    return agents.find((agent) =>
      agent.agentNickname?.toLowerCase() === needle ||
      agent.agentPath?.toLowerCase() === needle ||
      agent.agentPath?.toLowerCase().endsWith(`/${needle}`)
    ) ?? null;
  }
  return agents[0] ?? null;
}

export async function inspectAgentSession(options = {}) {
  const agent = await resolveAgent(options);
  if (!agent) return null;

  let contents;
  try {
    contents = await fs.readFile(agent.filePath, 'utf8');
  } catch {
    return { agent, status: 'unreadable', events: [] };
  }

  const summary = summarizeRolloutLines(contents.split(/\r?\n/), options);
  return {
    agent,
    status: summary.status,
    secondsSinceActivity: Math.max(0, Math.round((Date.now() - agent.updatedAtMs) / 1000)),
    events: summary.events,
  };
}

export function formatAgentList(agents) {
  if (!agents.length) return 'No child-agent rollout sessions found.';
  return agents.map((agent, index) => {
    const label = agent.agentNickname ?? agent.agentPath ?? agent.threadId ?? '(unknown)';
    const provider = agent.modelProvider ?? 'unknown-provider';
    const version = agent.multiAgentVersion ?? 'unknown-version';
    return `${index + 1}. ${label} | thread=${agent.threadId ?? '?'} | parent=${agent.parentThreadId ?? '?'} | ${provider} | ${version} | cwd=${agent.cwd ?? '?'} | updated=${agent.updatedAt}`;
  }).join('\n');
}

export function formatInspection(result) {
  if (!result) return 'No matching child-agent rollout session found.';
  const { agent } = result;
  const label = agent.agentNickname ?? agent.agentPath ?? agent.threadId ?? '(unknown)';
  const lines = [
    `agent: ${label}`,
    `thread: ${agent.threadId ?? '?'}`,
    `parent: ${agent.parentThreadId ?? '?'}`,
    `provider: ${agent.modelProvider ?? '?'}`,
    `multi-agent: ${agent.multiAgentVersion ?? '?'}`,
    `cwd: ${agent.cwd ?? '?'}`,
    `state: ${result.status}`,
    `last activity: ${result.secondsSinceActivity}s ago`,
    '',
    'recent activity:',
  ];

  if (!result.events.length) lines.push('- (no readable reasoning/tool events yet)');
  else {
    for (const event of result.events) {
      const timestamp = event.timestamp ? ` ${event.timestamp}` : '';
      lines.push(`- [${event.kind}]${timestamp} ${event.text}`);
    }
  }
  return lines.join('\n');
}
