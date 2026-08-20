#!/usr/bin/env node

import process from 'node:process';
import {
  inspectAgentSession,
  listAgentSessions,
  readRecentRolloutLines,
} from '../mcp/watcher.mjs';

const DEFAULT_INTERVAL_MS = 750;
const DEFAULT_EVENT_LIMIT = 40;
const DEFAULT_TEXT_LIMIT = 2400;

const ANSI = {
  clear: '\x1b[2J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

function parseArgs(argv) {
  const options = {
    agent: null,
    provider: null,
    cwd: null,
    intervalMs: DEFAULT_INTERVAL_MS,
    eventLimit: DEFAULT_EVENT_LIMIT,
    textLimit: DEFAULT_TEXT_LIMIT,
    raw: false,
    once: false,
    stream: false,
    help: false,
  };

  const takeValue = (index, name) => {
    if (index + 1 >= argv.length) throw new Error(`${name} requires a value.`);
    return argv[index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const original = argv[i];
    const arg = original.toLowerCase();

    switch (arg) {
      case '--agent':
      case '-a':
      case '-agent':
        options.agent = takeValue(i, original);
        i += 1;
        break;
      case '--provider':
      case '-p':
      case '-provider':
        options.provider = takeValue(i, original);
        i += 1;
        break;
      case '--cwd':
      case '-c':
      case '-cwd':
        options.cwd = takeValue(i, original);
        i += 1;
        break;
      case '--interval':
      case '-i':
      case '-interval':
        options.intervalMs = parsePositiveInt(takeValue(i, original), original, 100, 60_000);
        i += 1;
        break;
      case '--events':
      case '-n':
      case '-events':
        options.eventLimit = parsePositiveInt(takeValue(i, original), original, 1, 500);
        i += 1;
        break;
      case '--text-limit':
      case '-textlimit':
        options.textLimit = parsePositiveInt(takeValue(i, original), original, 80, 20_000);
        i += 1;
        break;
      case '--raw':
      case '-raw':
        options.raw = true;
        break;
      case '--once':
      case '-once':
        options.once = true;
        break;
      case '--stream':
      case '-stream':
        options.stream = true;
        break;
      case '--help':
      case '-h':
      case '/?':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${original}`);
    }
  }

  return options;
}

function parsePositiveInt(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function usage() {
  return `V1 Agent Watcher\n\nUsage:\n  v1watch [options]\n\nOptions:\n  -Agent, --agent <name>       Follow the newest matching child agent\n  -Provider, --provider <id>   Filter by model provider (for example lmstudio)\n  -Cwd, --cwd <path>           Filter by child working directory\n  -Interval, --interval <ms>   Refresh interval (default ${DEFAULT_INTERVAL_MS})\n  -Events, --events <count>    Activity items to keep on screen (default ${DEFAULT_EVENT_LIMIT})\n  -TextLimit, --text-limit <n> Max characters per summarized event (default ${DEFAULT_TEXT_LIMIT})\n  -Raw, --raw                  Show raw rollout JSON instead of summarized activity\n  -Stream, --stream            Append new activity instead of redrawing a dashboard\n  -Once, --once                Print one snapshot and exit\n  -h, --help                   Show this help\n\nExamples:\n  v1watch\n  v1watch -Agent ornith\n  v1watch -Provider lmstudio\n  v1watch -Agent ornith -Stream\n  v1watch -Raw\n`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function labelFor(agent) {
  return agent.agentNickname ?? agent.agentRole ?? agent.agentPath ?? agent.threadId ?? '(unknown)';
}

function shortId(value) {
  if (!value) return '?';
  return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
}

function formatClock(timestamp) {
  if (!timestamp) return '--:--:--';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function activityPrefix(kind) {
  switch (kind) {
    case 'reasoning': return 'thinking';
    case 'assistant': return 'assistant';
    case 'tool_call': return 'tool';
    case 'tool_result': return 'result';
    case 'shell': return 'shell';
    case 'state': return 'state';
    default: return kind;
  }
}

function wrap(text, width, indent = '') {
  const safeWidth = Math.max(24, width - indent.length);
  const words = String(text).replace(/\r?\n/g, ' ↵ ').split(/\s+/).filter(Boolean);
  if (!words.length) return [indent];

  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if (`${line} ${word}`.length <= safeWidth) {
      line += ` ${word}`;
    } else {
      lines.push(`${indent}${line}`);
      line = word;
    }
  }
  if (line) lines.push(`${indent}${line}`);
  return lines;
}

function formatEvent(event, width) {
  const header = `${formatClock(event.timestamp)}  ${activityPrefix(event.kind)}`;
  const body = wrap(event.text, width, '  ');
  return [header, ...body, ''];
}

async function readRawTail(filePath, limit) {
  try {
    const lines = await readRecentRolloutLines(filePath, { maxBytes: 4 * 1024 * 1024 });
    return lines.filter(Boolean).slice(-limit);
  } catch {
    return [];
  }
}

async function inspect(options) {
  const base = {
    provider: options.provider,
    cwd: options.cwd,
    eventLimit: options.eventLimit,
    textLimit: options.textLimit,
  };

  if (!options.agent) return inspectAgentSession(base);

  const needle = options.agent.toLowerCase();
  const agents = await listAgentSessions({
    provider: options.provider,
    cwd: options.cwd,
    limit: 100,
  });
  const candidate = agents.find((agent) => {
    const fields = [agent.agentNickname, agent.agentRole, agent.agentPath, agent.threadId]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return fields.some((value) => value === needle || value.endsWith(`/${needle}`) || value.includes(needle));
  });

  if (!candidate) return null;
  return inspectAgentSession({ ...base, threadId: candidate.threadId });
}

async function renderDashboard(result, options) {
  const width = Math.max(60, process.stdout.columns || 110);
  const height = Math.max(18, process.stdout.rows || 40);

  if (!result) {
    return [
      `${ANSI.bold}V1 Agent Watcher${ANSI.reset}`,
      '',
      'Waiting for a matching child-agent rollout…',
      options.agent ? `agent filter: ${options.agent}` : 'agent filter: newest child',
      options.provider ? `provider filter: ${options.provider}` : null,
      options.cwd ? `cwd filter: ${options.cwd}` : null,
      '',
      `${ANSI.dim}Ctrl+C to exit${ANSI.reset}`,
    ].filter(Boolean).join('\n');
  }

  const { agent } = result;
  const header = [
    `${ANSI.bold}V1 Agent Watcher${ANSI.reset}  ${labelFor(agent)}`,
    `state: ${result.status}   provider: ${agent.modelProvider ?? '?'}   last activity: ${result.secondsSinceActivity}s ago`,
    `thread: ${shortId(agent.threadId)}   parent: ${shortId(agent.parentThreadId)}   mode: ${agent.multiAgentVersion ?? '?'}`,
    `cwd: ${agent.cwd ?? '?'}`,
    `${ANSI.dim}${options.raw ? 'RAW rollout JSON' : 'reasoning + tool activity'}   refresh ${options.intervalMs}ms   Ctrl+C to exit${ANSI.reset}`,
    '─'.repeat(Math.min(width, 140)),
  ];

  let body;
  if (options.raw) {
    const lines = await readRawTail(agent.filePath, Math.max(5, height - header.length - 1));
    body = lines.flatMap((line) => wrap(line, width));
  } else {
    body = result.events.flatMap((event) => formatEvent(event, width));
  }

  const available = Math.max(1, height - header.length - 1);
  body = body.slice(-available);
  return [...header, ...body].join('\n');
}

function eventIdentity(threadId, event) {
  return `${threadId}\u0000${event.timestamp ?? ''}\u0000${event.kind}\u0000${event.text}`;
}

async function streamSnapshot(result, options, state) {
  if (!result) {
    if (!state.waitingPrinted) {
      process.stdout.write('V1 Agent Watcher: waiting for a matching child-agent rollout…\n');
      state.waitingPrinted = true;
    }
    return;
  }

  state.waitingPrinted = false;
  const threadId = result.agent.threadId ?? result.agent.filePath;
  if (state.threadId !== threadId) {
    state.threadId = threadId;
    state.seen.clear();
    state.streamText.clear();
    process.stdout.write(`\n=== ${labelFor(result.agent)} | ${threadId} | ${result.agent.modelProvider ?? '?'} | ${result.agent.cwd ?? '?'} ===\n`);
  }

  if (options.raw) {
    const lines = await readRawTail(result.agent.filePath, options.eventLimit);
    for (const line of lines) {
      const key = `${threadId}\u0000raw\u0000${line}`;
      if (state.seen.has(key)) continue;
      state.seen.add(key);
      process.stdout.write(`${line}\n`);
    }
    return;
  }

  for (const event of result.events) {
    if (event.append && event.streamKey) {
      const streamKey = `${threadId}\u0000${event.streamKey}`;
      const fullText = event.rawText ?? event.text;
      const previousText = state.streamText.get(streamKey) ?? '';
      if (fullText === previousText) continue;
      const delta = fullText.startsWith(previousText) ? fullText.slice(previousText.length) : fullText;
      state.streamText.set(streamKey, fullText);
      if (delta) process.stdout.write(`${formatClock(event.timestamp)}  ${activityPrefix(event.kind)}\n${delta}\n\n`);
      continue;
    }
    const key = eventIdentity(threadId, event);
    if (state.seen.has(key)) continue;
    state.seen.add(key);
    process.stdout.write(`${formatClock(event.timestamp)}  ${activityPrefix(event.kind)}\n${event.text}\n\n`);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const interactiveDashboard = process.stdout.isTTY && !options.stream && !options.once;
  const streamState = { threadId: null, seen: new Set(), streamText: new Map(), waitingPrinted: false };

  if (interactiveDashboard) process.stdout.write(ANSI.hideCursor);

  const cleanup = () => {
    if (interactiveDashboard) process.stdout.write(ANSI.showCursor + ANSI.reset + '\n');
  };
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  try {
    while (true) {
      let result;
      try {
        result = await inspect(options);
      } catch (error) {
        if (interactiveDashboard) {
          process.stdout.write(`${ANSI.clear}${ANSI.bold}V1 Agent Watcher${ANSI.reset}\n\nError: ${error.message}\n`);
        } else {
          process.stderr.write(`V1 Agent Watcher: ${error.message}\n`);
        }
        if (options.once) break;
        await sleep(options.intervalMs);
        continue;
      }

      if (options.once) {
        if (!result) {
          process.stdout.write('No matching child-agent rollout session found.\n');
        } else if (options.raw) {
          const lines = await readRawTail(result.agent.filePath, options.eventLimit);
          process.stdout.write(`${lines.join('\n')}\n`);
        } else {
          process.stdout.write(await renderDashboard(result, { ...options, once: true }));
          process.stdout.write('\n');
        }
        break;
      }

      if (interactiveDashboard) {
        process.stdout.write(ANSI.clear);
        process.stdout.write(await renderDashboard(result, options));
      } else {
        await streamSnapshot(result, options, streamState);
      }

      await sleep(options.intervalMs);
    }
  } finally {
    cleanup();
  }
}

await main();
