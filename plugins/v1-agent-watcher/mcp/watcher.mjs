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

const recentRolloutCache = new Map();

export function getCodexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

function normalizePath(value) {
  if (!value) return null;
  const normalized = path.normalize(path.resolve(String(value)));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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

export async function listAgentSessions(options = {}) {
  const codexHome = options.codexHome ? path.resolve(options.codexHome) : getCodexHome();
  const sessionsRoot = path.join(codexHome, 'sessions');
  const maxFiles = clampInt(options.maxFiles, 1, 20000, DEFAULT_MAX_FILES);
  const maximumLimit = options.allowLargeLimit ? 20000 : 100;
  const limit = clampInt(options.limit, 1, maximumLimit, DEFAULT_LIST_LIMIT);
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

  withStats.sort((a, b) => {
    const timeDifference = (b?.stat?.mtimeMs ?? 0) - (a?.stat?.mtimeMs ?? 0);
    if (timeDifference) return timeDifference;
    return String(b?.filePath ?? '').localeCompare(String(a?.filePath ?? ''), undefined, { numeric: true });
  });

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
    if (!meta?.parentThreadId || !meta.isCollabChild) continue;
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
  if (identity.includes('qwen')) return 30 * 60;
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
  const reversalPattern = /\b(?:wait|actually|hold on|reconsider|that's wrong|that is wrong|i was wrong|scratch that)\b/i;
  const reversalCount = reasoningEvents.filter((event) => reversalPattern.test(event.text)).length;
  const repeatedCommands = repeatedGroup(facts.commands);
  const failedCommands = facts.commands.filter((command) => command.failed);
  const repeatedFailures = repeatedGroup(failedCommands);
  const investigationCount = facts.commands.filter((command) =>
    /^(?:exec_command|shell)?\s*(?:rg|grep|find|fd|ls|dir|get-childitem|get-content|select-string|git\s+(?:diff|status|log|show))\b/i.test(command.display)
  ).length;
  const mutationCount = facts.commands.filter((command) =>
    /\b(?:apply_patch|write_file|edit_file|set-content|add-content|out-file|sed\s+-i|git\s+(?:add|commit|mv|rm))\b/i.test(command.display)
  ).length;

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
    cwd: options.cwd,
    provider: options.provider,
    parentThreadId: options.parentThreadId,
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
  const currentAgent = {
    ...agent,
    updatedAt: recent.stat.mtime.toISOString(),
    updatedAtMs: recent.stat.mtimeMs,
  };
  return {
    agent: currentAgent,
    status: summary.status,
    secondsSinceActivity: Math.max(0, Math.round(((options.nowMs ?? Date.now()) - currentAgent.updatedAtMs) / 1000)),
    events: summary.events,
  };
}

export async function inspectAgentHealth(options = {}) {
  const agent = await resolveAgent(options);
  if (!agent) return null;

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
      recentSummary: {
        reasoningUpdates: 0,
        commandCalls: 0,
        failedCommands: 0,
        contextCompactions: 0,
        malformedLinesIgnored: 0,
      },
    };
  }

  const currentAgent = {
    ...agent,
    updatedAt: recent.stat.mtime.toISOString(),
    updatedAtMs: recent.stat.mtimeMs,
  };
  const secondsSinceActivity = Math.max(0, Math.round(((options.nowMs ?? Date.now()) - currentAgent.updatedAtMs) / 1000));
  const analysis = analyzeAgentHealth(recent.lines, {
    agent: currentAgent,
    secondsSinceActivity,
    inactivitySeconds: options.inactivitySeconds,
    initialStatus: recent.entry.status,
  });
  recent.entry.status = analysis.state;

  return { agent: currentAgent, secondsSinceActivity, ...analysis };
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
  return JSON.stringify({
    agent: label,
    thread: result.agent.threadId,
    state: result.state,
    health: result.health,
    seconds_since_activity: result.secondsSinceActivity,
    signals: result.signals,
    recent_summary: {
      reasoning_updates: result.recentSummary.reasoningUpdates,
      command_calls: result.recentSummary.commandCalls,
      failed_commands: result.recentSummary.failedCommands,
      context_compactions: result.recentSummary.contextCompactions,
      malformed_lines_ignored: result.recentSummary.malformedLinesIgnored,
    },
  }, null, 2);
}
