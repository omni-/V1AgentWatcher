#!/usr/bin/env node

import process from 'node:process';
import { inspectSupervisionUsage, inspectThreadUsage } from '../mcp/usage.mjs';

function parseArgs(argv) {
  const options = { threadId: null, workerThreadId: null, watchdogThreadId: null, codexHome: null, json: false, help: false };
  const takeValue = (index, name) => {
    if (index + 1 >= argv.length) throw new Error(`${name} requires a value.`);
    return argv[index + 1];
  };

  for (let index = 0; index < argv.length; index += 1) {
    const original = argv[index];
    switch (original.toLowerCase()) {
      case '-thread':
      case '--thread':
      case '-t':
        options.threadId = takeValue(index, original);
        index += 1;
        break;
      case '-worker':
      case '--worker':
      case '-w':
        options.workerThreadId = takeValue(index, original);
        index += 1;
        break;
      case '-watchdog':
      case '--watchdog':
        options.watchdogThreadId = takeValue(index, original);
        index += 1;
        break;
      case '-codexhome':
      case '--codex-home':
        options.codexHome = takeValue(index, original);
        index += 1;
        break;
      case '-json':
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
      case '/?':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${original}`);
    }
  }
  return options;
}

function usage() {
  return `V1 supervision token usage

Usage:
  v1usage -Thread <exact-sol-thread-id> [options]
  v1usage -Worker <exact-qwen-thread-id> [options]

Options:
  -Thread, --thread <id>       Exact standalone/root or child thread lifetime
  -Worker, --worker <id>       Exact worker thread ID for supervision-tree accounting
  -Watchdog, --watchdog <id>   Exact Luna thread ID; otherwise discover only if unambiguous
  -Json, --json                Print structured JSON
  -CodexHome, --codex-home <p> Override the Codex home directory
  -h, --help                   Show this help

Examples:
  v1usage -Thread 01abc...
  v1usage -Thread 01abc... -Json
  v1usage -Worker 01abc...
  v1usage -Worker 01abc... -Watchdog 01def...
  v1usage -Worker 01abc... -Json
`;
}

function renderThreadReport(result) {
  const usage = result.cumulative;
  const rows = [
    ['Input', number(usage?.input_tokens)],
    ['Cached input', number(usage?.cached_input_tokens)],
    ['Cache-write input', number(usage?.cache_write_input_tokens)],
    ['Non-cached input', number(usage?.non_cached_input_tokens)],
    ['Output', number(usage?.output_tokens)],
    ['Reasoning output', number(usage?.reasoning_output_tokens)],
    ['Raw total', number(usage?.raw_total_tokens)],
    ['Effective total', number(usage?.effective_tokens)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = [
    'V1 Codex thread token usage',
    '',
    `Thread:         ${result.thread}`,
    `Model/provider: ${modelProvider(result)}`,
    `Accounting:     ${result.accounting_source}`,
    '',
    ...rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`),
    '',
    'Lifetime usage is the benchmark usage for a fresh single-purpose root thread.',
  ];
  if (result.warnings?.length) lines.push('', 'Warnings:', ...result.warnings.map((warning) => `- ${warning}`));
  return `${lines.join('\n')}\n`;
}

function number(value) {
  return value === null || value === undefined ? 'unavailable' : value.toLocaleString('en-US');
}

function modelProvider(role) {
  const model = role?.model ?? '?';
  const provider = role?.provider ?? '?';
  return model === '?' ? provider : `${model}/${provider}`;
}

function cellsFor(result) {
  return [
    {
      role: 'Sol parent',
      model: modelProvider(result.parent),
      usage: result.parent?.benchmark_turn,
    },
    {
      role: 'Luna',
      model: modelProvider(result.watchdog),
      usage: result.watchdog?.lifetime,
    },
    {
      role: 'Qwen',
      model: modelProvider(result.worker),
      usage: result.worker?.lifetime,
    },
  ].map((row) => [
    row.role,
    row.model,
    number(row.usage?.effective_tokens),
    number(row.usage?.input_tokens),
    number(row.usage?.cached_input_tokens),
    number(row.usage?.cache_write_input_tokens),
    number(row.usage?.output_tokens),
    number(row.usage?.reasoning_output_tokens),
  ]);
}

function renderTable(rows) {
  const headers = ['Role', 'Model/provider', 'Effective', 'Input', 'Cached', 'CacheWrite', 'Output', 'Reasoning'];
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)));
  const render = (row) => row.map((cell, index) => {
    const numeric = index >= 2;
    return numeric ? cell.padStart(widths[index]) : cell.padEnd(widths[index]);
  }).join('  ');
  return [render(headers), render(widths.map((width) => '-'.repeat(width))), ...rows.map(render)].join('\n');
}

function allWarnings(result) {
  return [...new Set([
    ...(result.warnings ?? []),
    ...(result.parent?.warnings ?? []).map((warning) => `Sol lifetime: ${warning}`),
    ...(result.parent?.benchmark_turn?.warnings ?? []).map((warning) => `Sol benchmark turn: ${warning}`),
    ...(result.watchdog?.warnings ?? []).map((warning) => `Luna: ${warning}`),
    ...(result.worker?.warnings ?? []).map((warning) => `Qwen: ${warning}`),
  ])];
}

function renderReport(result) {
  const warnings = allWarnings(result);
  const lines = [
    'V1 supervision token usage',
    '',
    renderTable(cellsFor(result)),
    '',
    `Sol benchmark turn: ${number(result.parent?.benchmark_turn?.effective_tokens)} effective tokens`,
    `Sol lifetime:       ${number(result.parent?.lifetime?.effective_tokens)} effective tokens`,
    `Hosted providers:   ${number(result.combined?.hosted_effective_tokens)} effective tokens`,
    `Local providers:    ${number(result.combined?.local_effective_tokens)} effective tokens`,
    '',
    `Worker thread:   ${result.worker_thread}`,
    `Watchdog thread: ${result.watchdog_thread ?? 'unresolved'}`,
    `Parent thread:   ${result.parent?.thread ?? 'unresolved'}`,
  ];
  if (warnings.length) lines.push('', 'Warnings:', ...warnings.map((warning) => `- ${warning}`));
  return `${lines.join('\n')}\n`;
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
  if (Boolean(options.threadId) === Boolean(options.workerThreadId)) {
    process.stderr.write(`Provide exactly one of -Thread or -Worker.\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.threadId && options.watchdogThreadId) {
    process.stderr.write(`-Watchdog is valid only with -Worker.\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }

  try {
    if (options.threadId) {
      const result = await inspectThreadUsage(options);
      if (!result) throw new Error(`thread not found: ${options.threadId}`);
      process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : renderThreadReport(result));
    } else {
      const result = await inspectSupervisionUsage(options);
      process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : renderReport(result));
    }
  } catch (error) {
    process.stderr.write(`V1 usage error: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}

await main();
