import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_LIST_LIMIT = 12;
const DEFAULT_EVENT_LIMIT = 16;
const DEFAULT_TEXT_LIMIT = 700;
const DEFAULT_READ_BYTES = 8 * 1024 * 1024;
const MAX_READ_CACHE_ENTRIES = 8;
const HEALTH_EVENT_LIMIT = 100;
const HEALTH_TEXT_LIMIT = 1200;
export const TRANSPORT_SAFE_WAIT_TIMEOUT_MS = 225 * 1000;
const DEFAULT_WAIT_TIMEOUT_MS = TRANSPORT_SAFE_WAIT_TIMEOUT_MS;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 5000;

// Progress screening. A stall requires several independent persisted facts, so
// every individual threshold below is deliberately conservative on its own.
const LARGE_TOOL_OUTPUT_TOKENS = 20000;
const ESTIMATED_CHARS_PER_TOKEN = 4;
const PROGRESS_STALL_COMPACTIONS = 2;
const PROGRESS_STALL_REDISCOVERY_COMMANDS = 3;
const COMPACTION_BRIDGE_RECORDS = 3;
const COMPACTION_EVENT_TYPES = new Set([
  'context_compacted',
  'conversation_compacted',
  'compacted',
  'auto_compact_completed',
]);

const recentRolloutCache = new Map();

export function getCodexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

function normalizePath(value) {
  if (!value) return null;
  const normalized = path.normalize(path.resolve(String(value)));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sessionMatchesOptions(session, options) {
  if (options.threadId && session.threadId !== options.threadId) return false;
  if (options.collaborationChildrenOnly && (!session.parentThreadId || !session.isCollabChild)) return false;
  if (options.cwd && normalizePath(session.cwd) !== normalizePath(options.cwd)) return false;
  if (options.provider && session.modelProvider?.toLowerCase() !== options.provider.toLowerCase()) return false;
  if (options.parentThreadId && session.parentThreadId !== options.parentThreadId) return false;
  return true;
}

async function collectRolloutFiles(root, maxFiles = DEFAULT_MAX_FILES) {
  const files = [];

  async function walk(dir) {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') return;
      throw error;
    }

    entries.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
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

async function collectExactRolloutFiles(root, threadId) {
  const files = [];
  const suffix = `-${threadId}.jsonl`.toLowerCase();

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') return;
      throw error;
    }

    entries.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()
        && entry.name.startsWith('rollout-')
        && entry.name.toLowerCase().endsWith(suffix)) {
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

async function readFileRange(filePath, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function touchReadCache(filePath, entry) {
  recentRolloutCache.delete(filePath);
  recentRolloutCache.set(filePath, entry);
  while (recentRolloutCache.size > MAX_READ_CACHE_ENTRIES) {
    recentRolloutCache.delete(recentRolloutCache.keys().next().value);
  }
}

async function readRecentRollout(filePath, maxBytes = DEFAULT_READ_BYTES) {
  const byteLimit = clampInt(maxBytes, 64 * 1024, 64 * 1024 * 1024, DEFAULT_READ_BYTES);
  const stat = await fs.stat(filePath);
  const cached = recentRolloutCache.get(filePath);
  let buffer;
  let status = cached?.status ?? 'unknown';

  if (cached && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
    buffer = cached.buffer;
  } else if (cached && stat.size > cached.size && stat.size - cached.size <= byteLimit) {
    const appended = await readFileRange(filePath, cached.size, stat.size - cached.size);
    buffer = Buffer.concat([cached.buffer, appended]);
    if (buffer.length > byteLimit) buffer = buffer.subarray(buffer.length - byteLimit);
  } else {
    const start = Math.max(0, stat.size - byteLimit);
    buffer = await readFileRange(filePath, start, stat.size - start);
    status = 'unknown';
  }

  const entry = { buffer, size: stat.size, mtimeMs: stat.mtimeMs, status };
  touchReadCache(filePath, entry);

  let text = buffer.toString('utf8');
  const truncated = stat.size > buffer.length;
  if (truncated) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  }
  return { entry, lines: text.split(/\r?\n/), stat };
}

export async function readRecentRolloutLines(filePath, options = {}) {
  const recent = await readRecentRollout(filePath, options.maxBytes);
  return recent.lines;
}

function threadSpawnSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const subagent = source.subagent ?? source.sub_agent ?? source.subAgent;
  if (!subagent || typeof subagent !== 'object' || Array.isArray(subagent)) return null;
  const spawn = subagent.thread_spawn ?? subagent.threadSpawn;
  return spawn && typeof spawn === 'object' && !Array.isArray(spawn) ? spawn : null;
}

function isCollabChild(meta) {
  const version = String(meta.multi_agent_version ?? '').toLowerCase();
  if (version === 'disabled' || version === 'v2') return false;

  const source = meta.source ?? meta.session_source;
  const spawn = threadSpawnSource(source);
  if (spawn) {
    const sourceParent = spawn.parent_thread_id ?? spawn.parentThreadId ?? null;
    if (sourceParent && meta.parent_thread_id && sourceParent !== meta.parent_thread_id) return false;
    return true;
  }

  if (source !== null && source !== undefined) return false;

  // Older V1 rollouts did not always persist SessionSource. Agent identity plus
  // an explicit V1 marker is the narrow compatibility fallback.
  const hasAgentIdentity = Boolean(meta.agent_path || meta.agent_nickname || meta.agent_role);
  return hasAgentIdentity && version === 'v1';
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
    sessionSource: meta.source ?? meta.session_source ?? null,
    threadSource: meta.thread_source ?? null,
    isCollabChild: isCollabChild(meta),
    createdAt: meta.timestamp ?? record.timestamp ?? null,
    updatedAt: stat.mtime.toISOString(),
    updatedAtMs: stat.mtimeMs,
    filePath,
  };
}

export async function listRolloutSessions(options = {}) {
  const codexHome = options.codexHome ? path.resolve(options.codexHome) : getCodexHome();
  const sessionsRoot = path.join(codexHome, 'sessions');
  const maxFiles = clampInt(options.maxFiles, 1, 20000, DEFAULT_MAX_FILES);
  const maximumLimit = options.allowLargeLimit || options.threadId ? 20000 : 100;
  const limit = clampInt(options.limit, 1, maximumLimit, DEFAULT_LIST_LIMIT);
  const files = await collectRolloutFiles(sessionsRoot, maxFiles);
  const withStats = await Promise.all(files.map(async (filePath) => {
    try {
      return { filePath, stat: await fs.stat(filePath) };
    } catch {
      return null;
    }
  }));

  withStats.sort((a, b) => {
    const timeDifference = (b?.stat?.mtimeMs ?? 0) - (a?.stat?.mtimeMs ?? 0);
    if (timeDifference) return timeDifference;
    return String(b?.filePath ?? '').localeCompare(String(a?.filePath ?? ''), undefined, { numeric: true });
  });

  const sessions = [];
  for (const item of withStats) {
    if (!item) continue;
    let firstLine;
    try {
      firstLine = await readFirstLine(item.filePath);
    } catch {
      continue;
    }
    const meta = parseSessionMetaLine(firstLine, item.filePath, item.stat);
    if (!meta?.threadId) continue;
    if (!sessionMatchesOptions(meta, options)) continue;
    sessions.push(meta);
    if (sessions.length >= limit) break;
  }

  return sessions;
}

export async function findRolloutSession(options = {}) {
  if (!options.threadId) return null;
  const codexHome = options.codexHome ? path.resolve(options.codexHome) : getCodexHome();
  const exactFiles = await collectExactRolloutFiles(path.join(codexHome, 'sessions'), options.threadId);
  const exactSessions = (await Promise.all(exactFiles.map(async (filePath) => {
    try {
      const stat = await fs.stat(filePath);
      return parseSessionMetaLine(await readFirstLine(filePath), filePath, stat);
    } catch {
      return null;
    }
  })))
    .filter((session) => session && sessionMatchesOptions(session, options))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  if (exactSessions.length) return exactSessions[0];

  const sessions = await listRolloutSessions({
    ...options,
    codexHome,
    maxFiles: options.maxFiles ?? 20000,
    limit: 1,
    allowLargeLimit: true,
  });
  return sessions[0] ?? null;
}

export async function listAgentSessions(options = {}) {
  return listRolloutSessions({
    ...options,
    collaborationChildrenOnly: true,
  });
}

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max = DEFAULT_TEXT_LIMIT) {
  const normalized = normalizeText(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function truncateTail(text, max = DEFAULT_TEXT_LIMIT) {
  const normalized = normalizeText(text);
  if (normalized.length <= max) return normalized;
  return `…${normalized.slice(-(max - 1))}`;
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
      const text = content.length ? content.join(' ') : summary.join(' ');
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
    case 'custom_tool_call': {
      const input = truncate(payload.input ?? '', Math.min(textLimit, 360));
      return { kind: 'tool_call', text: `${payload.name ?? 'custom_tool'}${input ? ` ${input}` : ''}` };
    }
    case 'custom_tool_call_output': {
      const output = payload.output ?? '';
      return output ? { kind: 'tool_result', text: truncate(typeof output === 'string' ? output : JSON.stringify(output), Math.min(textLimit, 360)) } : null;
    }
    default:
      return null;
  }
}

function latestPersistedActivityMs(lines) {
  let latest = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== 'event_msg' && record.type !== 'response_item') continue;
    const timestampMs = Date.parse(record.timestamp);
    if (Number.isFinite(timestampMs) && (latest === null || timestampMs > latest)) latest = timestampMs;
  }
  return latest;
}

function rolloutActivity(lines, fallbackMs) {
  const persistedEventMs = latestPersistedActivityMs(lines);
  const timestampMs = persistedEventMs ?? fallbackMs;
  return {
    timestampMs,
    source: persistedEventMs === null ? 'file_mtime' : 'persisted_event',
  };
}

function reasoningDelta(payload, prefix, indexField) {
  if (!payload.delta) return null;
  const partIndex = payload[indexField] ?? 0;
  return {
    kind: 'reasoning',
    text: payload.delta,
    append: true,
    streamKey: `${prefix}:${payload.item_id ?? payload.turn_id ?? 'current'}:${partIndex}`,
  };
}

function errorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.message ?? value.error ?? JSON.stringify(value);
}

function summarizeEvent(record, textLimit) {
  const payload = record.payload ?? {};
  switch (payload.type) {
    case 'agent_reasoning':
      return payload.text ? { kind: 'reasoning', text: truncate(payload.text, textLimit) } : null;
    case 'agent_reasoning_raw_content':
      return payload.text ? { kind: 'reasoning', text: truncate(payload.text, textLimit), raw: true } : null;
    case 'reasoning_raw_content_delta':
      return reasoningDelta(payload, 'raw', 'content_index');
    case 'reasoning_content_delta':
      return reasoningDelta(payload, 'summary', 'summary_index');
    case 'task_started':
    case 'turn_started':
      return { kind: 'state', text: 'turn started' };
    case 'task_complete':
    case 'turn_complete':
      return payload.error
        ? { kind: 'state', text: `turn failed: ${truncate(errorText(payload.error), 240)}` }
        : { kind: 'state', text: 'turn complete' };
    case 'turn_aborted':
      return { kind: 'state', text: `turn aborted${payload.reason ? `: ${truncate(payload.reason, 240)}` : ''}` };
    case 'error':
      return { kind: 'state', text: `error: ${truncate(errorText(payload), 240)}` };
    case 'context_compacted':
      return { kind: 'state', text: 'context compacted' };
    case 'exec_command_begin': {
      const command = Array.isArray(payload.command) ? payload.command.join(' ') : payload.command;
      return command ? { kind: 'shell', text: truncate(command, Math.min(textLimit, 420)) } : null;
    }
    case 'exec_command_end': {
      if (payload.exit_code === 0 && payload.status !== 'failed') return null;
      const command = Array.isArray(payload.command) ? payload.command.join(' ') : payload.command;
      const detail = payload.stderr || payload.aggregated_output || payload.formatted_output || '';
      const text = `${command ? `${command} — ` : ''}exit ${payload.exit_code ?? '?'}${detail ? `: ${detail}` : ''}`;
      return { kind: 'tool_result', text: truncate(text, Math.min(textLimit, 420)) };
    }
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
  let status = options.initialStatus ?? 'unknown';
  const streams = new Map();

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
      if (type === 'task_started' || type === 'turn_started') status = 'running';
      else if (type === 'task_complete' || type === 'turn_complete') {
        status = record.payload?.error ? 'errored' : 'idle';
      }
      else if (type === 'turn_aborted') status = 'aborted';
      else if (type === 'error') status = 'errored';
    }

    if (!event) continue;
    event.timestamp = record.timestamp ?? null;

    if (event.append) {
      const streamed = streams.get(event.streamKey);
      if (streamed) {
        streamed.rawText = `${streamed.rawText ?? streamed.text ?? ''}${event.text}`;
        if (streamed.rawText.length > textLimit * 8) streamed.rawText = streamed.rawText.slice(-(textLimit * 8));
        streamed.text = truncateTail(streamed.rawText, textLimit);
        streamed.timestamp = event.timestamp;
        const previousIndex = events.indexOf(streamed);
        if (previousIndex >= 0) {
          events.splice(previousIndex, 1);
          events.push(streamed);
        }
        continue;
      }
      event.rawText = event.text;
      event.text = truncateTail(event.text, textLimit);
      streams.set(event.streamKey, event);
    }

    if (!event.append && event.kind === 'reasoning') {
      const streamedDuplicate = [...streams.values()].find((candidate) => eventKey(candidate) === eventKey(event));
      if (streamedDuplicate) {
        streamedDuplicate.timestamp = event.timestamp;
        continue;
      }
    }

    const previous = events.at(-1);
    if (!previous || eventKey(previous) !== eventKey(event)) events.push(event);
  }

  return { status, events: events.slice(-eventLimit) };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseArguments(value) {
  if (!value || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function commandFromCall(payload) {
  const name = String(payload.name ?? payload.tool_name ?? 'tool');
  const args = parseArguments(payload.arguments ?? payload.input ?? '');
  const direct = args && typeof args === 'object'
    ? args.cmd ?? args.command ?? args.script ?? null
    : null;
  const argumentText = direct
    ? (Array.isArray(direct) ? direct.join(' ') : String(direct))
    : (typeof args === 'string' ? args : stableStringify(args));
  return {
    callId: payload.call_id ?? payload.id ?? null,
    display: normalizeText(`${name}${argumentText ? ` ${argumentText}` : ''}`),
  };
}

function normalizeCommand(value) {
  return normalizeText(value).toLowerCase();
}

function commandTokens(value) {
  return new Set(normalizeCommand(value).match(/[a-z0-9_.:/\\-]+/g) ?? []);
}

function nearIdentical(left, right) {
  const a = commandTokens(left);
  const b = commandTokens(right);
  if (a.size < 5 || b.size < 5) return false;
  const [firstA] = a;
  const [firstB] = b;
  if (firstA !== firstB) return false;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union > 0 && intersection / union >= 0.88;
}

function explicitFailure(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    const exitCode = value.exit_code ?? value.exitCode ?? value.metadata?.exit_code ?? value.metadata?.exitCode;
    if (exitCode !== null && exitCode !== undefined && exitCode !== '' && Number.isFinite(Number(exitCode))) {
      return Number(exitCode) !== 0;
    }
    if (value.isError === true || value.success === false) return true;
    if (value.status && /^(failed|error|errored|declined)$/i.test(String(value.status))) return true;
    return explicitFailure(value.output ?? value.result ?? null);
  }

  const text = String(value);
  const parsed = parseArguments(text);
  if (parsed !== text) return explicitFailure(parsed);
  if (/\b(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|exit_code)\s*[:=]?\s*-?[1-9]\d*\b/i.test(text)) return true;
  if (/\b(?:command failed|tool failed|execution failed|uncaught error)\b/i.test(text)) return true;
  return null;
}

function repeatedGroup(commands) {
  const exact = new Map();
  for (const command of commands) {
    const key = normalizeCommand(command.display);
    const group = exact.get(key) ?? [];
    group.push(command);
    exact.set(key, group);
  }
  const exactBest = [...exact.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  if (exactBest.length >= 3) return { commands: exactBest, kind: 'identical' };

  let nearBest = [];
  for (const command of commands) {
    const group = commands.filter((candidate) => nearIdentical(command.display, candidate.display));
    if (group.length > nearBest.length) nearBest = group;
  }
  return nearBest.length >= 3 ? { commands: nearBest, kind: 'near-identical' } : null;
}

function collectHealthFacts(lines) {
  const commands = [];
  const commandsByCallId = new Map();
  const pendingFailures = new Set();
  let compactions = 0;
  let malformedLines = 0;

  const addCommand = (fact) => {
    if (!fact?.display) return;
    if (fact.callId && commandsByCallId.has(fact.callId)) return;
    const command = { ...fact, failed: fact.callId ? pendingFailures.has(fact.callId) : false };
    commands.push(command);
    if (fact.callId) commandsByCallId.set(fact.callId, command);
  };
  const markFailure = (callId, failed) => {
    if (!callId || failed !== true) return;
    const command = commandsByCallId.get(callId);
    if (command) command.failed = true;
    else pendingFailures.add(callId);
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }

    const payload = record.payload ?? {};
    if (record.type === 'response_item') {
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        addCommand(commandFromCall(payload));
      } else if (payload.type === 'local_shell_call') {
        const action = payload.action ?? {};
        const direct = action.command ?? action.cmd ?? action.script ?? stableStringify(action);
        addCommand({
          callId: payload.call_id ?? payload.id ?? null,
          display: normalizeText(`shell ${Array.isArray(direct) ? direct.join(' ') : direct}`),
        });
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        markFailure(payload.call_id ?? payload.id ?? null, explicitFailure(payload.output ?? payload.result));
      }
    } else if (record.type === 'event_msg') {
      if (payload.type === 'context_compacted') compactions += 1;
      else if (payload.type === 'exec_command_begin') {
        const command = Array.isArray(payload.command) ? payload.command.join(' ') : payload.command;
        addCommand({ callId: payload.call_id ?? null, display: normalizeText(`shell ${command ?? ''}`) });
      } else if (payload.type === 'exec_command_end') {
        const exitCode = payload.exit_code;
        const failed = (exitCode !== null && exitCode !== undefined && Number(exitCode) !== 0)
          || /^(?:failed|error|errored)$/i.test(String(payload.status ?? ''));
        markFailure(payload.call_id ?? null, failed);
      }
    }
  }

  return { commands: commands.slice(-200), compactions, malformedLines };
}

// Read-only discovery calls. Used both for the existing investigation-only
// signal and for post-compaction rediscovery.
const INVESTIGATION_COMMAND_PATTERN = /^(?:exec_command|shell|local_shell|container\.exec)?\s*(?:rg|grep|egrep|find|fd|ls|dir|tree|gci|get-childitem|get-content|cat|type|head|tail|sed\s+-n|select-string|read_file|list_dir|glob|git\s+(?:diff|status|log|show))\b/i;

// Persisted evidence that the worker actually changed the repository. This is
// intentionally broad: a false mutation only suppresses a stall signal, while a
// missed mutation could produce a false stall.
const MUTATION_COMMAND_PATTERNS = [
  /\b(?:apply_patch|applypatch|write_file|edit_file|create_file|str_replace|update_file|patch_file|set-content|add-content|out-file|new-item|tee|sed\s+-i|git\s+(?:apply|add|commit|mv|rm|restore|checkout\s+-b))\b/i,
  /\s1?>>?\s*[a-z0-9_.\\/-]+/i,
];

// Explicit commitment to an implementation phase. These must stay anchored
// multi-word phrases; bare words such as "fix" or "plan" are ordinary discourse.
const IMPLEMENTATION_PHASE_PATTERNS = [
  /\bimplementation plan\b/i,
  /\b(?:i|we)(?:'m|'ll| am| will) (?:now )?(?:going to )?(?:apply|implement|make|write) (?:the|these|those|my|our) (?:change|changes|fix|fixes|edit|edits|patch|implementation)\b/i,
  /\b(?:now|let(?:'s| me)) (?:apply|implement|write) (?:the|these|those) (?:change|changes|fix|fixes|edit|edits|patch)\b/i,
  /\bready to (?:implement|apply) (?:the|this|these) (?:fix|change|changes|patch|plan)\b/i,
  /\btime to (?:implement|apply) (?:the|this|these) (?:fix|change|changes|patch)\b/i,
];

function isInvestigationCommand(display) {
  return INVESTIGATION_COMMAND_PATTERN.test(String(display ?? ''));
}

function isMutationCommand(display) {
  const text = String(display ?? '');
  return MUTATION_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

function isImplementationPhaseText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return IMPLEMENTATION_PHASE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function toolOutputText(payload) {
  const raw = payload.output ?? payload.result ?? payload.aggregated_output ?? payload.formatted_output ?? payload.stdout ?? '';
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const nested = raw.output ?? raw.result ?? raw.stdout ?? null;
    return typeof nested === 'string' ? nested : JSON.stringify(raw);
  }
  return '';
}

function toolOutputTokens(payload) {
  const containers = [
    payload,
    payload.metadata,
    typeof payload.output === 'object' ? payload.output : null,
    typeof payload.output === 'object' ? payload.output?.metadata : null,
    typeof payload.result === 'object' ? payload.result : null,
    typeof payload.result === 'object' ? payload.result?.metadata : null,
  ];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const key of ['original_token_count', 'originalTokenCount', 'token_count', 'tokenCount', 'output_tokens', 'outputTokens']) {
      const value = Number(container[key]);
      if (Number.isFinite(value) && value > 0) return { tokens: Math.round(value), source: 'metadata' };
    }
  }

  const text = toolOutputText(payload);
  if (!text) return null;
  return { tokens: Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN), source: 'estimated' };
}

function reasoningText(payload) {
  const summary = Array.isArray(payload.summary)
    ? payload.summary.map((part) => part?.text).filter(Boolean)
    : [];
  const content = textBlocks(payload.content);
  return content.length ? content.join(' ') : summary.join(' ');
}

function lastIndexOfKind(events, kind) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].kind === kind) return index;
  }
  return -1;
}

export function emptyProgressFacts() {
  return {
    compactions: 0,
    mutations: 0,
    compactionsSinceMutation: 0,
    secondsSinceMutation: null,
    implementationPhaseCommitted: false,
    implementationPhaseReentered: false,
    postCompactionRediscovery: false,
    stalled: false,
    stalledAfterGuidance: false,
    guidanceMessages: 0,
    largeToolOutputs: 0,
    largestToolOutputTokens: 0,
    largestToolOutputSource: null,
  };
}

/**
 * Evaluate the progress-stall conditions over one ordered slice of progress
 * events. Every condition must hold: an implementation phase was committed, at
 * least two compactions followed it, and the newest compaction was followed by
 * renewed rediscovery or replanning rather than implementation.
 */
function evaluateStall(events) {
  const firstImplementation = events.findIndex((event) => event.kind === 'implementation_phase');
  const afterImplementation = firstImplementation >= 0 ? events.slice(firstImplementation) : [];
  const compactionsAfterImplementation = afterImplementation.filter((event) => event.kind === 'compaction').length;
  const lastCompaction = lastIndexOfKind(events, 'compaction');
  const afterLastCompaction = lastCompaction >= 0 ? events.slice(lastCompaction + 1) : [];
  const rediscoveryCommands = afterLastCompaction.filter((event) => event.kind === 'investigation').length;
  const replanned = afterLastCompaction.some((event) => event.kind === 'implementation_phase');
  const postCompactionRediscovery = rediscoveryCommands >= PROGRESS_STALL_REDISCOVERY_COMMANDS || replanned;

  return {
    compactions: events.filter((event) => event.kind === 'compaction').length,
    implementationPhaseCommitted: firstImplementation >= 0,
    implementationPhaseReentered: afterImplementation.filter((event) => event.kind === 'implementation_phase').length >= 2,
    postCompactionRediscovery,
    stalled: firstImplementation >= 0
      && compactionsAfterImplementation >= PROGRESS_STALL_COMPACTIONS
      && postCompactionRediscovery,
  };
}

/**
 * Collect deterministic whole-rollout progress facts. This never interprets the
 * worker's engineering theory; it only counts persisted mutation, compaction,
 * rediscovery, and implementation-phase markers.
 */
export function collectProgressFacts(lines, options = {}) {
  const events = [];
  const seenCallIds = new Set();
  let recordsSinceCompaction = Number.POSITIVE_INFINITY;
  let userMessages = 0;
  let previousUserText = null;
  let largeToolOutputs = 0;
  let largestToolOutputTokens = 0;
  let largestToolOutputSource = null;

  const addCommand = (callId, display, timestampMs) => {
    if (callId) {
      if (seenCallIds.has(callId)) return;
      seenCallIds.add(callId);
    }
    if (!display) return;
    if (isMutationCommand(display)) events.push({ kind: 'mutation', timestampMs });
    else if (isInvestigationCommand(display)) events.push({ kind: 'investigation', timestampMs });
  };

  const addText = (text, timestampMs) => {
    if (isImplementationPhaseText(text)) events.push({ kind: 'implementation_phase', timestampMs });
  };

  const addUserMessage = (text, timestampMs) => {
    const normalized = normalizeText(text);
    if (normalized && normalized === previousUserText) return;
    previousUserText = normalized;
    userMessages += 1;
    // The first user message is the delegated task, and a message persisted
    // immediately after compaction is the compaction bridge summary. Neither is
    // parent guidance.
    if (userMessages === 1) return;
    if (recordsSinceCompaction <= COMPACTION_BRIDGE_RECORDS) return;
    events.push({ kind: 'guidance', timestampMs });
  };

  const addOutput = (payload) => {
    const size = toolOutputTokens(payload);
    if (!size) return;
    if (size.tokens >= LARGE_TOOL_OUTPUT_TOKENS) largeToolOutputs += 1;
    if (size.tokens > largestToolOutputTokens) {
      largestToolOutputTokens = size.tokens;
      largestToolOutputSource = size.source;
    }
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = record.payload ?? {};
    const parsedTimestamp = Date.parse(record.timestamp);
    const timestampMs = Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
    recordsSinceCompaction += 1;

    if (record.type === 'event_msg') {
      if (COMPACTION_EVENT_TYPES.has(payload.type)) {
        events.push({ kind: 'compaction', timestampMs });
        recordsSinceCompaction = 0;
      } else if (payload.type === 'exec_command_begin') {
        const command = Array.isArray(payload.command) ? payload.command.join(' ') : payload.command;
        addCommand(payload.call_id ?? null, normalizeText(`shell ${command ?? ''}`), timestampMs);
      } else if (payload.type === 'exec_command_end') {
        addOutput(payload);
      } else if (payload.type === 'agent_reasoning' || payload.type === 'agent_reasoning_raw_content' || payload.type === 'agent_message') {
        addText(payload.text ?? payload.message, timestampMs);
      } else if (payload.type === 'user_message') {
        addUserMessage(payload.message ?? payload.text, timestampMs);
      }
    } else if (record.type === 'response_item') {
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const command = commandFromCall(payload);
        addCommand(command.callId, command.display, timestampMs);
      } else if (payload.type === 'local_shell_call') {
        const action = payload.action ?? {};
        const direct = action.command ?? action.cmd ?? action.script ?? stableStringify(action);
        addCommand(
          payload.call_id ?? payload.id ?? null,
          normalizeText(`shell ${Array.isArray(direct) ? direct.join(' ') : direct}`),
          timestampMs,
        );
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        addOutput(payload);
      } else if (payload.type === 'reasoning') {
        addText(reasoningText(payload), timestampMs);
      } else if (payload.type === 'message') {
        const text = textBlocks(payload.content).join(' ');
        if (payload.role === 'assistant') addText(text, timestampMs);
        else if (payload.role === 'user') addUserMessage(text, timestampMs);
      }
    }
  }

  const lastMutationIndex = lastIndexOfKind(events, 'mutation');
  const lastGuidanceIndex = lastIndexOfKind(events, 'guidance');
  // Any mutation clears prior stall evidence: only events after the newest
  // observed repository change can describe a current stall. The same
  // evaluation restarted after the newest parent guidance message distinguishes
  // a first stall from one that repeated despite explicit guidance.
  const stallFrom = (start) => evaluateStall(events.slice(start));
  const sinceMutation = stallFrom(lastMutationIndex + 1);
  const sinceGuidance = lastGuidanceIndex >= 0
    ? stallFrom(Math.max(lastMutationIndex, lastGuidanceIndex) + 1)
    : null;
  const lastMutationMs = lastMutationIndex >= 0 ? events[lastMutationIndex].timestampMs : null;
  const nowMs = options.nowMs ?? Date.now();

  return {
    compactions: events.filter((event) => event.kind === 'compaction').length,
    mutations: events.filter((event) => event.kind === 'mutation').length,
    compactionsSinceMutation: sinceMutation.compactions,
    secondsSinceMutation: lastMutationMs === null ? null : Math.max(0, Math.round((nowMs - lastMutationMs) / 1000)),
    implementationPhaseCommitted: sinceMutation.implementationPhaseCommitted,
    implementationPhaseReentered: sinceMutation.implementationPhaseReentered,
    postCompactionRediscovery: sinceMutation.postCompactionRediscovery,
    stalled: sinceMutation.stalled,
    stalledAfterGuidance: Boolean(sinceGuidance?.stalled),
    guidanceMessages: events.filter((event) => event.kind === 'guidance').length,
    largeToolOutputs,
    largestToolOutputTokens,
    largestToolOutputSource,
  };
}

function latestTurnLines(lines) {
  let latestStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const record = JSON.parse(lines[index]);
      const type = record?.type === 'event_msg' ? record.payload?.type : null;
      if (type === 'task_started' || type === 'turn_started') latestStart = index;
    } catch {
      // Malformed and truncated lines are expected while a rollout is being appended.
    }
  }
  return latestStart >= 0 ? lines.slice(latestStart) : lines;
}

function countMalformedLines(lines) {
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      count += 1;
    }
  }
  return count;
}

function inactivityThreshold(agent) {
  const identity = [agent?.agentNickname, agent?.agentRole, agent?.agentPath]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (identity.includes('qwen')) return 60 * 60;
  if (identity.includes('ornith')) return 10 * 60;
  return 15 * 60;
}

export function analyzeAgentHealth(lines, options = {}) {
  const currentTurnLines = latestTurnLines(lines);
  const summary = summarizeRolloutLines(currentTurnLines, {
    eventLimit: HEALTH_EVENT_LIMIT,
    textLimit: HEALTH_TEXT_LIMIT,
    initialStatus: options.initialStatus,
  });
  const facts = collectHealthFacts(currentTurnLines);
  const malformedLines = countMalformedLines(lines);
  const reasoningEvents = summary.events.filter((event) => event.kind === 'reasoning');
  const reversalPatterns = [
    /\b(?:i|we)\s+(?:was|were|am|are)\s+(?:wrong|mistaken)\b/i,
    /\b(?:scratch|forget)\s+(?:that|the\s+(?:earlier|previous|prior)\s+(?:approach|plan|idea))\b/i,
    /\b(?:that's|that\s+(?:is|was)|this\s+(?:is|was))\s+(?:wrong|incorrect|mistaken|false)\b/i,
    /\b(?:my|our|the)\s+(?:earlier|previous|prior|initial|original)\s+(?:assumption|premise|approach|plan|conclusion|interpretation|branch|theory|idea)\s+(?:is|was|seems?|turned\s+out\s+to\s+be)\s+(?:wrong|incorrect|mistaken|false|invalid|flawed)\b/i,
    /\b(?:that|this|my|our|the\s+(?:earlier|previous|prior|initial|original))\s+(?:assumption|premise)\s+(?:does\s+not|doesn't|did\s+not|didn't|cannot|can't)\s+(?:hold|work|apply)\b/i,
  ];
  const reversalCount = reasoningEvents.filter((event) =>
    reversalPatterns.some((pattern) => pattern.test(event.text))
  ).length;
  const repeatedCommands = repeatedGroup(facts.commands);
  const failedCommands = facts.commands.filter((command) => command.failed);
  const repeatedFailures = repeatedGroup(failedCommands);
  const investigationCount = facts.commands.filter((command) => isInvestigationCommand(command.display)).length;
  const mutationCount = facts.commands.filter((command) => isMutationCommand(command.display)).length;
  const progress = collectProgressFacts(lines, { nowMs: options.nowMs });

  const signals = [];
  let concernScore = 0;
  if (summary.status === 'aborted' || summary.status === 'errored') {
    signals.push(`terminal_state: worker is ${summary.status}`);
    concernScore += 3;
  }
  if (reversalCount >= 3) {
    signals.push(`premise_reversals: ${reversalCount} recent reasoning updates contain self-correction language`);
    concernScore += 2;
  }
  if (repeatedFailures) {
    signals.push(`repeated_failures: ${repeatedFailures.commands.length} failed ${repeatedFailures.kind} calls (${truncate(repeatedFailures.commands[0].display, 120)})`);
    concernScore += 3;
  } else if (repeatedCommands) {
    signals.push(`repeated_command: ${repeatedCommands.commands.length} ${repeatedCommands.kind} calls (${truncate(repeatedCommands.commands[0].display, 120)})`);
    concernScore += 2;
  }
  if (facts.compactions >= 2) {
    signals.push(`context_compaction: ${facts.compactions} recent compactions`);
    concernScore += 2;
  }
  if (investigationCount >= 15 && mutationCount === 0) {
    signals.push(`investigation_only: ${investigationCount} read/search calls without an observed write action`);
    concernScore += 1;
  }
  if (progress.stalled) {
    const guidance = progress.stalledAfterGuidance ? ' after earlier parent guidance' : '';
    signals.push(`progress_stall: implementation phase established${guidance}, then ${progress.compactionsSinceMutation} context compactions with no repository mutation and renewed investigation/replanning`);
    concernScore += 2;
  }
  if (progress.largeToolOutputs) {
    signals.push(`large_tool_output: ${progress.largeToolOutputs} tool results above ~${LARGE_TOOL_OUTPUT_TOKENS} tokens (largest ~${progress.largestToolOutputTokens}, ${progress.largestToolOutputSource})`);
  }

  const secondsSinceActivity = Number(options.secondsSinceActivity ?? 0);
  const inactivitySeconds = options.inactivitySeconds ?? inactivityThreshold(options.agent);
  if (summary.status === 'running' && secondsSinceActivity >= inactivitySeconds) {
    signals.push(`inactivity: no persisted activity for ${Math.round(secondsSinceActivity)}s while running`);
    concernScore += 2;
  }

  const completed = summary.status === 'idle';
  return {
    state: summary.status,
    health: !completed && concernScore >= 2 ? 'suspicious' : 'healthy',
    signals,
    progress,
    recentSummary: {
      reasoningUpdates: reasoningEvents.length,
      commandCalls: facts.commands.length,
      failedCommands: failedCommands.length,
      contextCompactions: facts.compactions,
      malformedLinesIgnored: malformedLines,
    },
  };
}

async function resolveAgent(options = {}) {
  const exactThreadLookup = Boolean(options.threadId);
  const agents = await listAgentSessions({
    codexHome: options.codexHome,
    // An exact thread ID is authoritative. Persisted cwd/provider metadata can
    // describe the parent launch context rather than the worker's shell state,
    // so optional discovery hints must not hide an otherwise exact match.
    cwd: exactThreadLookup ? undefined : options.cwd,
    provider: exactThreadLookup ? undefined : options.provider,
    parentThreadId: exactThreadLookup ? undefined : options.parentThreadId,
    limit: exactThreadLookup ? 20000 : 100,
    allowLargeLimit: exactThreadLookup,
    maxFiles: options.maxFiles,
  });

  if (options.threadId) {
    return agents.find((agent) => agent.threadId === options.threadId) ?? null;
  }
  if (options.nickname) {
    const needle = options.nickname.toLowerCase();
    return agents.find((agent) =>
      agent.agentNickname?.toLowerCase() === needle ||
      agent.agentRole?.toLowerCase() === needle ||
      agent.agentPath?.toLowerCase() === needle ||
      agent.agentPath?.replace(/\\/g, '/').toLowerCase().endsWith(`/${needle}`)
    ) ?? null;
  }
  return agents[0] ?? null;
}

export async function inspectAgentSession(options = {}) {
  const agent = await resolveAgent(options);
  if (!agent) return null;

  let recent;
  try {
    recent = await readRecentRollout(agent.filePath, options.maxReadBytes);
  } catch {
    return {
      agent,
      status: 'unreadable',
      secondsSinceActivity: Math.max(0, Math.round(((options.nowMs ?? Date.now()) - agent.updatedAtMs) / 1000)),
      events: [],
    };
  }

  const summary = summarizeRolloutLines(recent.lines, { ...options, initialStatus: recent.entry.status });
  recent.entry.status = summary.status;
  const activity = rolloutActivity(recent.lines, recent.stat.mtimeMs);
  const currentAgent = {
    ...agent,
    updatedAt: new Date(activity.timestampMs).toISOString(),
    updatedAtMs: activity.timestampMs,
  };
  return {
    agent: currentAgent,
    status: summary.status,
    secondsSinceActivity: Math.max(0, Math.round(((options.nowMs ?? Date.now()) - currentAgent.updatedAtMs) / 1000)),
    activitySource: activity.source,
    events: summary.events,
  };
}

async function inspectResolvedAgentHealth(agent, options = {}) {
  let recent;
  try {
    recent = await readRecentRollout(agent.filePath, options.maxReadBytes);
  } catch {
    return {
      agent,
      state: 'unreadable',
      health: 'suspicious',
      secondsSinceActivity: Math.max(0, Math.round(((options.nowMs ?? Date.now()) - agent.updatedAtMs) / 1000)),
      signals: ['rollout_unreadable: the selected rollout could not be read'],
      progress: emptyProgressFacts(),
      recentSummary: {
        reasoningUpdates: 0,
        commandCalls: 0,
        failedCommands: 0,
        contextCompactions: 0,
        malformedLinesIgnored: 0,
      },
    };
  }

  const activity = rolloutActivity(recent.lines, recent.stat.mtimeMs);
  const currentAgent = {
    ...agent,
    updatedAt: new Date(activity.timestampMs).toISOString(),
    updatedAtMs: activity.timestampMs,
  };
  const secondsSinceActivity = Math.max(0, Math.round(((options.nowMs ?? Date.now()) - currentAgent.updatedAtMs) / 1000));
  const analysis = analyzeAgentHealth(recent.lines, {
    agent: currentAgent,
    secondsSinceActivity,
    inactivitySeconds: options.inactivitySeconds,
    initialStatus: recent.entry.status,
    nowMs: options.nowMs,
  });
  recent.entry.status = analysis.state;

  return { agent: currentAgent, secondsSinceActivity, activitySource: activity.source, ...analysis };
}

export async function inspectAgentHealth(options = {}) {
  const agent = await resolveAgent(options);
  return agent ? inspectResolvedAgentHealth(agent, options) : null;
}

function waitDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function normalizeWaitTimeoutMs(value, maximum = TRANSPORT_SAFE_WAIT_TIMEOUT_MS) {
  const maximumTimeoutMs = clampInt(
    maximum,
    1,
    TRANSPORT_SAFE_WAIT_TIMEOUT_MS,
    TRANSPORT_SAFE_WAIT_TIMEOUT_MS,
  );
  return clampInt(value, 1, maximumTimeoutMs, Math.min(DEFAULT_WAIT_TIMEOUT_MS, maximumTimeoutMs));
}

/**
 * Deterministic logical health-window accounting for composed transport-safe
 * wait chunks. Only a completed `timeout` chunk contributes elapsed time, and a
 * chunk that observed the worker never triggers an inspection by itself: health
 * inspection happens exactly once per completed logical window.
 */
export function accumulateHealthWindow(options = {}) {
  const windowMs = clampInt(options.windowMs, 1, 24 * 60 * 60 * 1000, TRANSPORT_SAFE_WAIT_TIMEOUT_MS);
  const previousElapsedMs = clampInt(options.elapsedMs, 0, 24 * 60 * 60 * 1000, 0);
  const contributedMs = options.outcome === 'timeout'
    ? clampInt(options.waitedMs, 0, 24 * 60 * 60 * 1000, 0)
    : 0;
  const elapsedMs = previousElapsedMs + contributedMs;
  const foundInWindow = Boolean(options.foundInWindow) || (options.outcome === 'timeout' && Boolean(options.found));
  const remainingMs = Math.max(0, windowMs - elapsedMs);
  return {
    windowMs,
    elapsedMs,
    remainingMs,
    nextChunkMs: Math.min(TRANSPORT_SAFE_WAIT_TIMEOUT_MS, remainingMs > 0 ? remainingMs : windowMs),
    foundInWindow,
    inspectNow: elapsedMs >= windowMs && foundInWindow,
    missingWindow: elapsedMs >= windowMs && !foundInWindow,
  };
}

export async function waitForAgent(options = {}) {
  if (!options.threadId) throw new Error('threadId is required');

  const timeoutMs = normalizeWaitTimeoutMs(options.timeoutMs, options.maximumTimeoutMs);
  const pollIntervalMs = clampInt(
    options.pollIntervalMs,
    1,
    60_000,
    DEFAULT_WAIT_POLL_INTERVAL_MS,
  );
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastHealth = null;
  let agent = null;
  let found = false;

  while (true) {
    // Exact ID is the complete identity here. This wait deliberately does not
    // depend on Codex parent/child ownership or persisted cwd/provider hints.
    agent ??= await resolveAgent({ codexHome: options.codexHome, threadId: options.threadId });
    lastHealth = agent
      ? await inspectResolvedAgentHealth(agent, { maxReadBytes: options.maxReadBytes })
      : null;
    found ||= Boolean(lastHealth);

    if (lastHealth?.state === 'idle') {
      return {
        outcome: 'completed',
        threadId: options.threadId,
        found: true,
        state: lastHealth.state,
        health: lastHealth.health,
        waitedMs: Date.now() - startedAt,
      };
    }
    if (lastHealth?.state === 'aborted' || lastHealth?.state === 'errored') {
      return {
        outcome: 'terminal_error',
        threadId: options.threadId,
        found: true,
        state: lastHealth.state,
        health: lastHealth.health,
        signals: lastHealth.signals,
        waitedMs: Date.now() - startedAt,
      };
    }

    const now = Date.now();
    if (now >= deadline) {
      return {
        outcome: 'timeout',
        threadId: options.threadId,
        found,
        state: lastHealth?.state ?? 'missing',
        health: lastHealth?.health ?? null,
        waitedMs: now - startedAt,
      };
    }
    await waitDelay(Math.min(pollIntervalMs, deadline - now));
  }
}

export function formatAgentList(agents) {
  if (!agents.length) return 'No V1 collaboration child-agent rollout sessions found.';
  return agents.map((agent, index) => {
    const label = agent.agentNickname ?? agent.agentRole ?? agent.agentPath ?? agent.threadId ?? '(unknown)';
    const provider = agent.modelProvider ?? 'unknown-provider';
    const version = agent.multiAgentVersion ?? 'unknown-version';
    return `${index + 1}. ${label} | thread=${agent.threadId ?? '?'} | parent=${agent.parentThreadId ?? '?'} | ${provider} | ${version} | cwd=${agent.cwd ?? '?'} | updated=${agent.updatedAt}`;
  }).join('\n');
}

export function formatInspection(result) {
  if (!result) return 'No matching V1 collaboration child-agent rollout session found.';
  const { agent } = result;
  const label = agent.agentNickname ?? agent.agentRole ?? agent.agentPath ?? agent.threadId ?? '(unknown)';
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

export function formatHealthInspection(result) {
  if (!result) return 'No matching V1 collaboration child-agent rollout session found.';
  const label = result.agent.agentNickname ?? result.agent.agentRole ?? result.agent.agentPath ?? result.agent.threadId ?? '(unknown)';
  const progress = result.progress ?? emptyProgressFacts();
  return JSON.stringify({
    agent: label,
    thread: result.agent.threadId,
    state: result.state,
    health: result.health,
    seconds_since_activity: result.secondsSinceActivity,
    activity_source: result.activitySource,
    signals: result.signals,
    progress: {
      progress_stall: progress.stalled,
      progress_stall_after_guidance: progress.stalledAfterGuidance,
      compactions: progress.compactions,
      compactions_since_mutation: progress.compactionsSinceMutation,
      mutation_events: progress.mutations,
      seconds_since_mutation: progress.secondsSinceMutation,
      implementation_phase_committed: progress.implementationPhaseCommitted,
      implementation_phase_reentered: progress.implementationPhaseReentered,
      post_compaction_rediscovery: progress.postCompactionRediscovery,
      parent_guidance_messages: progress.guidanceMessages,
      large_tool_outputs: progress.largeToolOutputs,
      largest_tool_output_tokens: progress.largestToolOutputTokens,
      largest_tool_output_source: progress.largestToolOutputSource,
    },
    recent_summary: {
      reasoning_updates: result.recentSummary.reasoningUpdates,
      command_calls: result.recentSummary.commandCalls,
      failed_commands: result.recentSummary.failedCommands,
      context_compactions: result.recentSummary.contextCompactions,
      malformed_lines_ignored: result.recentSummary.malformedLinesIgnored,
    },
  }, null, 2);
}
