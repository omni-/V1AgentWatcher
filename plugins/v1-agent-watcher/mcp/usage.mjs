import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import readline from 'node:readline';
import {
  findRolloutSession,
  listRolloutSessions,
} from './watcher.mjs';

const USAGE_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
];
const REQUIRED_USAGE_FIELDS = USAGE_FIELDS.filter((field) => field !== 'cache_write_input_tokens');
const MAX_USAGE_CACHE_ENTRIES = 8;
const usageRolloutCache = new Map();

function asNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function rawUsage(value) {
  const result = {};
  for (const field of USAGE_FIELDS) {
    result[field] = value && Object.hasOwn(value, field)
      ? asNonNegativeInteger(value[field])
      : null;
  }
  return result;
}

function zeroRawUsage() {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
}

function addRawUsages(values) {
  if (!values.length) return null;
  const result = {};
  for (const field of USAGE_FIELDS) {
    result[field] = values.every((value) => value[field] !== null)
      ? values.reduce((sum, value) => sum + value[field], 0)
      : null;
  }
  return result;
}

function subtractRawUsage(end, start, warnings, label) {
  const result = {};
  for (const field of USAGE_FIELDS) {
    if (end?.[field] === null || end?.[field] === undefined
      || start?.[field] === null || start?.[field] === undefined) {
      result[field] = null;
      continue;
    }
    const delta = end[field] - start[field];
    if (delta < 0) {
      result[field] = null;
      warnings.push(`${label}: cumulative ${field} decreased across the selected boundary`);
    } else {
      result[field] = delta;
    }
  }
  return result;
}

function derivedUsage(value, warnings = [], label = 'usage') {
  if (!value) return null;
  const missing = REQUIRED_USAGE_FIELDS.filter((field) => value[field] === null);
  if (missing.length) warnings.push(`${label}: missing persisted fields: ${missing.join(', ')}`);

  const input = value.input_tokens;
  const cached = value.cached_input_tokens;
  const output = value.output_tokens;
  const reasoning = value.reasoning_output_tokens;
  let nonCached = null;
  if (input !== null && cached !== null) {
    if (cached > input) warnings.push(`${label}: cached_input_tokens exceeds input_tokens; Codex-style non-cached input was clamped to zero`);
    nonCached = Math.max(0, input - cached);
  }
  if (reasoning !== null && output !== null && reasoning > output) {
    warnings.push(`${label}: reasoning_output_tokens exceeds output_tokens; reasoning was not added to output`);
  }

  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: value.cache_write_input_tokens,
    non_cached_input_tokens: nonCached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    raw_total_tokens: value.total_tokens,
    effective_tokens: nonCached !== null && output !== null ? nonCached + output : null,
  };
}

function usageState(usage) {
  if (!usage) return { available: false, completeness: 'unavailable' };
  const values = [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.raw_total_tokens,
  ];
  if (values.every((value) => value === null)) return { available: false, completeness: 'unavailable' };
  return {
    available: true,
    completeness: values.every((value) => value !== null) ? 'complete' : 'partial',
  };
}

function parseSessionMeta(record) {
  if (record?.type !== 'session_meta') return null;
  const payload = record.payload ?? {};
  return payload.meta ?? payload;
}

function textParts(output) {
  if (typeof output === 'string') return [output];
  if (!Array.isArray(output)) return [];
  return output.map((part) => part?.text).filter((part) => typeof part === 'string');
}

function outputSpawnRelations(payload, line, timestamp) {
  if (!['custom_tool_call_output', 'function_call_output'].includes(payload?.type)) return [];
  const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id ?? null;
  const relations = [];
  for (const text of textParts(payload.output ?? payload.result)) {
    const pattern = /"agent_id"\s*:\s*"([^"]+)"/g;
    for (const match of text.matchAll(pattern)) {
      relations.push({ childThreadId: match[1], turnId, line, timestamp, source: 'tool_output' });
    }
  }
  return relations;
}

function nativeSpawnRelations(payload, line, timestamp) {
  if (payload?.type !== 'item_completed') return [];
  const item = payload.item ?? {};
  if (item.tool !== 'spawn_agent') return [];
  const ids = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : [];
  return ids.map((childThreadId) => ({
    childThreadId,
    turnId: payload.turn_id ?? null,
    line,
    timestamp,
    source: 'collab_item_completed',
  }));
}

function cacheUsageRollout(filePath, entry) {
  usageRolloutCache.delete(filePath);
  usageRolloutCache.set(filePath, entry);
  while (usageRolloutCache.size > MAX_USAGE_CACHE_ENTRIES) {
    usageRolloutCache.delete(usageRolloutCache.keys().next().value);
  }
}

async function parseUsageRollout(session) {
  const stat = await fs.stat(session.filePath);
  const cached = usageRolloutCache.get(session.filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.parsed;

  const parsed = {
    session,
    model: null,
    provider: session.modelProvider ?? null,
    malformedLines: 0,
    tokenEventsWithoutUsage: 0,
    cumulativeEvents: [],
    responseUsageEvents: [],
    turnStarts: [],
    turnCompletes: [],
    turnModels: new Map(),
    spawnRelations: [],
    compactions: 0,
  };

  const input = createReadStream(session.filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let line = 0;
  for await (const text of lines) {
    line += 1;
    if (!text.trim()) continue;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      parsed.malformedLines += 1;
      continue;
    }

    const meta = parseSessionMeta(record);
    if (meta) {
      parsed.provider = meta.model_provider ?? parsed.provider;
      parsed.model = meta.model ?? parsed.model;
      continue;
    }

    const payload = record.payload ?? {};
    if (record.type === 'turn_context') {
      const model = payload.model ?? payload.collaboration_mode?.settings?.model ?? null;
      if (payload.turn_id && model) parsed.turnModels.set(payload.turn_id, model);
      parsed.model = model ?? parsed.model;
      continue;
    }

    if (record.type === 'response_item') {
      parsed.spawnRelations.push(...outputSpawnRelations(payload, line, record.timestamp ?? null));
      continue;
    }
    if (record.type !== 'event_msg') continue;

    const type = payload.type;
    if (type === 'token_count') {
      if (payload.info?.total_token_usage) {
        parsed.cumulativeEvents.push({
          line,
          timestamp: record.timestamp ?? null,
          usage: rawUsage(payload.info.total_token_usage),
          lastUsage: rawUsage(payload.info.last_token_usage),
        });
      } else {
        parsed.tokenEventsWithoutUsage += 1;
      }
    } else if (type === 'raw_response_completed' && payload.token_usage) {
      parsed.responseUsageEvents.push({
        line,
        timestamp: record.timestamp ?? null,
        usage: rawUsage(payload.token_usage),
      });
    } else if (type === 'task_started' || type === 'turn_started') {
      parsed.turnStarts.push({ line, timestamp: record.timestamp ?? null, turnId: payload.turn_id ?? null });
    } else if (type === 'task_complete' || type === 'turn_complete') {
      parsed.turnCompletes.push({ line, timestamp: record.timestamp ?? null, turnId: payload.turn_id ?? null });
    } else if (type === 'context_compacted') {
      parsed.compactions += 1;
    } else if (type === 'thread_settings_applied') {
      const settings = payload.thread_settings ?? {};
      parsed.provider = settings.model_provider_id ?? parsed.provider;
      parsed.model = settings.model ?? parsed.model;
    }
    parsed.spawnRelations.push(...nativeSpawnRelations(payload, line, record.timestamp ?? null));
  }

  cacheUsageRollout(session.filePath, { size: stat.size, mtimeMs: stat.mtimeMs, parsed });
  return parsed;
}

function warningList(parsed) {
  const warnings = [];
  if (parsed.malformedLines) warnings.push(`${parsed.malformedLines} malformed or truncated JSONL line(s) were ignored`);
  if (parsed.tokenEventsWithoutUsage) warnings.push(`${parsed.tokenEventsWithoutUsage} token_count event(s) had no usage info`);
  return warnings;
}

function inspectParsedLifetime(parsed) {
  const warnings = warningList(parsed);
  let source = 'unavailable';
  let selectedRaw = null;
  let latestTimestamp = null;
  let accountingEvents = 0;

  if (parsed.cumulativeEvents.length) {
    const latest = parsed.cumulativeEvents.at(-1);
    selectedRaw = latest.usage;
    latestTimestamp = latest.timestamp;
    accountingEvents = parsed.cumulativeEvents.length;
    source = 'latest_cumulative_token_count';
  } else if (parsed.responseUsageEvents.length) {
    selectedRaw = addRawUsages(parsed.responseUsageEvents.map((event) => event.usage));
    latestTimestamp = parsed.responseUsageEvents.at(-1).timestamp;
    accountingEvents = parsed.responseUsageEvents.length;
    source = 'summed_raw_response_completed_deltas';
    warnings.push('cumulative token_count usage was absent; summed exact per-response raw_response_completed usage');
  }

  const cumulative = derivedUsage(selectedRaw, warnings, 'cumulative usage');
  const state = usageState(cumulative);
  if (!state.available) warnings.push('provider usage is unavailable in the persisted rollout');
  if (parsed.provider && parsed.provider.toLowerCase() !== 'openai') {
    warnings.push('external-provider fields are only as complete as the provider response; persisted zero values may not distinguish unsupported details from true zero usage');
  }

  return {
    thread: parsed.session.threadId,
    provider: parsed.provider,
    model: parsed.model,
    agent: {
      nickname: parsed.session.agentNickname,
      role: parsed.session.agentRole,
      path: parsed.session.agentPath,
      source: parsed.session.sessionSource,
    },
    parent_thread: parsed.session.parentThreadId,
    rollout_path: parsed.session.filePath,
    usage_available: state.available,
    usage_completeness: state.completeness,
    accounting_source: source,
    cumulative,
    accounting_events: accountingEvents,
    latest_accounting_timestamp: latestTimestamp,
    context_compactions: parsed.compactions,
    warnings,
  };
}

export async function inspectThreadUsage(options = {}) {
  if (!options.threadId) throw new Error('threadId is required');
  const session = await findRolloutSession(options);
  if (!session) return null;
  return inspectParsedLifetime(await parseUsageRollout(session));
}

function distinctBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function resolveBenchmarkTurn(parsed, workerThreadId) {
  const warnings = [];
  const relations = distinctBy(
    parsed.spawnRelations.filter((relation) => relation.childThreadId === workerThreadId),
    (relation) => `${relation.turnId ?? '?'}:${relation.source}`,
  );
  if (!relations.length) {
    return { warnings: [`no exact parent spawn relation was found for worker ${workerThreadId}`] };
  }

  const relationTurnIds = [...new Set(relations.map((relation) => relation.turnId).filter(Boolean))];
  if (relationTurnIds.length > 1) {
    return { warnings: [`worker ${workerThreadId} appears in spawn relations for multiple parent turns; benchmark turn is ambiguous`] };
  }

  const spawn = relations[0];
  let start;
  if (relationTurnIds.length === 1) {
    start = parsed.turnStarts.find((candidate) => candidate.turnId === relationTurnIds[0] && candidate.line <= spawn.line);
  }
  if (!start) {
    start = parsed.turnStarts.filter((candidate) => candidate.line <= spawn.line).at(-1);
    if (start) warnings.push('spawn relation lacked a usable turn id; selected the enclosing persisted turn by event order');
  }
  if (!start) return { warnings: [...warnings, 'no parent turn start precedes the exact worker spawn relation'] };

  const complete = parsed.turnCompletes.find((candidate) =>
    candidate.line > spawn.line && (!start.turnId || !candidate.turnId || candidate.turnId === start.turnId)
  ) ?? null;
  const nextStart = parsed.turnStarts.find((candidate) => candidate.line > start.line) ?? null;
  const boundaryEndLine = complete?.line ?? (nextStart ? nextStart.line - 1 : Number.POSITIVE_INFINITY);
  const before = parsed.cumulativeEvents.filter((event) => event.line < start.line).at(-1) ?? null;
  const final = parsed.cumulativeEvents.filter((event) => event.line <= boundaryEndLine).at(-1) ?? null;

  let selectedRaw = null;
  let source = 'unavailable';
  if (final && final.line >= start.line) {
    if (before) {
      selectedRaw = subtractRawUsage(final.usage, before.usage, warnings, 'benchmark turn');
    } else if (parsed.turnStarts[0] === start) {
      selectedRaw = subtractRawUsage(final.usage, zeroRawUsage(), warnings, 'benchmark turn');
    } else {
      warnings.push('no cumulative snapshot exists before a non-initial benchmark turn');
    }
    if (selectedRaw) source = 'cumulative_token_count_delta';
  } else {
    const responseEvents = parsed.responseUsageEvents.filter((event) =>
      event.line >= start.line && event.line <= boundaryEndLine
    );
    if (responseEvents.length) {
      selectedRaw = addRawUsages(responseEvents.map((event) => event.usage));
      source = 'summed_raw_response_completed_deltas';
      warnings.push('benchmark turn used exact per-response usage because cumulative token_count boundaries were unavailable');
    } else {
      warnings.push('no persisted usage event was found inside the benchmark turn');
    }
  }

  if (!complete) warnings.push('parent benchmark turn has no persisted completion event; usage is provisional and may omit the final response');
  const usage = derivedUsage(selectedRaw, warnings, 'benchmark turn usage');
  const state = usageState(usage);
  const exact = Boolean(complete && state.available);
  return {
    turn_id: start.turnId,
    exact,
    usage_available: state.available,
    usage_completeness: state.completeness,
    accounting_source: source,
    ...usage,
    boundary: {
      strategy: 'exact_worker_spawn_turn',
      turn_started_at: start.timestamp,
      spawn_at: spawn.timestamp,
      spawn_source: spawn.source,
      final_accounting_at: final?.timestamp ?? parsed.responseUsageEvents
        .filter((event) => event.line >= start.line && event.line <= boundaryEndLine).at(-1)?.timestamp ?? null,
      turn_completed_at: complete?.timestamp ?? null,
      final_response_accounting: complete && state.available
        ? 'included: final usage is persisted before the matching turn completion'
        : 'uncertain: matching completed turn and final usage boundary were not both available',
    },
    warnings,
  };
}

function roleResult(usage, role) {
  return usage ? {
    role,
    thread: usage.thread,
    provider: usage.provider,
    model: usage.model,
    identity: usage.agent,
    lifetime: usage.cumulative,
    usage_available: usage.usage_available,
    usage_completeness: usage.usage_completeness,
    accounting_events: usage.accounting_events,
    latest_accounting_timestamp: usage.latest_accounting_timestamp,
    warnings: usage.warnings,
  } : null;
}

function providerClass(provider) {
  const value = String(provider ?? '').toLowerCase();
  if (value === 'openai') return 'hosted';
  if (value.includes('lmstudio') || value.includes('lm-studio') || value.includes('ollama') || value === 'local') return 'local';
  return 'unknown';
}

function combinedEffective(entries) {
  if (!entries.length || entries.some((entry) => entry?.effective_tokens === null || entry?.effective_tokens === undefined)) return null;
  return entries.reduce((sum, entry) => sum + entry.effective_tokens, 0);
}

function effectiveAvailable(usage) {
  return usage?.effective_tokens !== null && usage?.effective_tokens !== undefined;
}

async function discoverWatchdog({ codexHome, maxFiles, parentSession, parentParsed, benchmark, workerThreadId }) {
  if (!benchmark?.turn_id) {
    return { selected: null, warnings: ['watchdog discovery requires an exact persisted parent benchmark turn; pass watchdog_thread_id explicitly'] };
  }
  const siblings = await listRolloutSessions({
    codexHome,
    maxFiles,
    parentThreadId: parentSession.threadId,
    collaborationChildrenOnly: true,
    allowLargeLimit: true,
    limit: 20000,
  });
  const candidates = [];
  for (const sibling of siblings) {
    if (sibling.threadId === workerThreadId) continue;
    const parsed = await parseUsageRollout(sibling);
    const identity = [sibling.agentNickname, sibling.agentRole, sibling.agentPath, parsed.model]
      .filter(Boolean).join(' ').toLowerCase();
    const sameTurn = parentParsed.spawnRelations.some((relation) =>
      relation.childThreadId === sibling.threadId && relation.turnId === benchmark.turn_id
    );
    if (sameTurn && (identity.includes('luna') || identity.includes('watchdog'))) candidates.push({ sibling, parsed });
  }
  if (candidates.length === 1) return { selected: candidates[0], warnings: [] };
  if (candidates.length > 1) {
    return { selected: null, warnings: [`watchdog discovery is ambiguous among exact sibling threads: ${candidates.map((item) => item.sibling.threadId).join(', ')}`] };
  }
  return { selected: null, warnings: ['no unambiguous Luna/watchdog sibling was found; pass watchdog_thread_id explicitly'] };
}

export async function inspectSupervisionUsage(options = {}) {
  const workerThreadId = options.workerThreadId;
  if (!workerThreadId) throw new Error('workerThreadId is required');
  const lookup = { codexHome: options.codexHome, maxFiles: options.maxFiles };
  const workerSession = await findRolloutSession({ ...lookup, threadId: workerThreadId });
  if (!workerSession) throw new Error(`worker thread not found: ${workerThreadId}`);
  if (!workerSession.parentThreadId) throw new Error(`worker ${workerThreadId} has no persisted parent_thread_id`);

  const parentSession = await findRolloutSession({ ...lookup, threadId: workerSession.parentThreadId });
  if (!parentSession) throw new Error(`parent thread not found: ${workerSession.parentThreadId}`);
  const [workerParsed, parentParsed] = await Promise.all([
    parseUsageRollout(workerSession),
    parseUsageRollout(parentSession),
  ]);
  const workerUsage = inspectParsedLifetime(workerParsed);
  const parentLifetime = inspectParsedLifetime(parentParsed);
  const benchmark = resolveBenchmarkTurn(parentParsed, workerThreadId);
  const warnings = [...benchmark.warnings.map((warning) => `parent: ${warning}`)];

  let watchdogUsage = null;
  if (options.watchdogThreadId) {
    const watchdogSession = await findRolloutSession({ ...lookup, threadId: options.watchdogThreadId });
    if (!watchdogSession) {
      warnings.push(`watchdog thread not found: ${options.watchdogThreadId}`);
    } else if (watchdogSession.parentThreadId !== parentSession.threadId) {
      warnings.push(`watchdog ${options.watchdogThreadId} is not an exact sibling of worker ${workerThreadId}`);
    } else if (!watchdogSession.isCollabChild) {
      warnings.push(`watchdog ${options.watchdogThreadId} is not a persisted thread-spawn collaboration child`);
    } else if (!benchmark.turn_id || !parentParsed.spawnRelations.some((relation) =>
      relation.childThreadId === options.watchdogThreadId && relation.turnId === benchmark.turn_id
    )) {
      warnings.push(`watchdog ${options.watchdogThreadId} has no exact spawn relation in parent benchmark turn ${benchmark.turn_id ?? '(unresolved)'}`);
    } else {
      watchdogUsage = inspectParsedLifetime(await parseUsageRollout(watchdogSession));
    }
  } else {
    const discovery = await discoverWatchdog({
      ...lookup,
      parentSession,
      parentParsed,
      benchmark,
      workerThreadId,
    });
    warnings.push(...discovery.warnings);
    if (discovery.selected) watchdogUsage = inspectParsedLifetime(discovery.selected.parsed);
  }

  const hosted = [];
  const local = [];
  const parentClass = providerClass(parentLifetime.provider);
  if (parentClass === 'hosted') hosted.push(benchmark);
  else warnings.push(`parent provider could not be classified as hosted: ${parentLifetime.provider ?? 'unknown'}`);
  let watchdogClass = 'unknown';
  if (watchdogUsage) {
    watchdogClass = providerClass(watchdogUsage.provider);
    if (watchdogClass === 'hosted') hosted.push(watchdogUsage.cumulative);
    else if (watchdogClass === 'local') local.push(watchdogUsage.cumulative);
    else warnings.push(`watchdog provider could not be classified: ${watchdogUsage.provider ?? 'unknown'}`);
  }
  const workerClass = providerClass(workerUsage.provider);
  if (workerClass === 'local') local.push(workerUsage.cumulative);
  else if (workerClass === 'hosted') hosted.push(workerUsage.cumulative);
  else warnings.push(`worker provider could not be classified: ${workerUsage.provider ?? 'unknown'}`);

  const hostedComplete = parentClass === 'hosted'
    && watchdogClass === 'hosted'
    && effectiveAvailable(benchmark)
    && effectiveAvailable(watchdogUsage?.cumulative)
    && (workerClass !== 'hosted' || effectiveAvailable(workerUsage.cumulative));
  if (!hostedComplete) warnings.push('hosted effective total is unavailable until both Sol benchmark-turn and Luna lifetime usage are resolved');
  const localComplete = workerClass === 'local'
    && effectiveAvailable(workerUsage.cumulative)
    && (watchdogClass !== 'local' || effectiveAvailable(watchdogUsage?.cumulative))
    && (parentClass !== 'local' || effectiveAvailable(benchmark));

  return {
    worker_thread: workerThreadId,
    watchdog_thread: watchdogUsage?.thread ?? null,
    parent: {
      role: 'parent',
      thread: parentLifetime.thread,
      provider: parentLifetime.provider,
      model: parentParsed.turnModels.get(benchmark.turn_id) ?? parentLifetime.model,
      identity: parentLifetime.agent,
      benchmark_turn: benchmark,
      lifetime: parentLifetime.cumulative,
      lifetime_usage_available: parentLifetime.usage_available,
      lifetime_usage_completeness: parentLifetime.usage_completeness,
      accounting_events: parentLifetime.accounting_events,
      latest_accounting_timestamp: parentLifetime.latest_accounting_timestamp,
      warnings: parentLifetime.warnings,
    },
    watchdog: roleResult(watchdogUsage, 'watchdog'),
    worker: roleResult(workerUsage, 'worker'),
    combined: {
      hosted_effective_tokens: hostedComplete ? combinedEffective(hosted) : null,
      local_effective_tokens: localComplete ? combinedEffective(local) : null,
      semantics: 'Sol benchmark-turn plus Luna lifetime are hosted; worker lifetime is local. No cost estimate or cross-provider token total is produced.',
    },
    warnings: [...new Set(warnings)],
  };
}
