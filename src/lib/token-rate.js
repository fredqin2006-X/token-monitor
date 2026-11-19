"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const {
  resolveCodebuddyHome,
  resolveCodebuddyProjectFiles,
  resolveCodebuddyDefaultModel,
  resolveAntigravityBrainDirs,
  listAntigravityTranscriptsWithStatus,
  resolveAntigravityDbPath,
  readAntigravityConversationDb,
  normalizeAntigravityTranscriptModel,
  parseAntigravityModelSelection,
  readAntigravityDefaultModel,
  antigravityContextTokens,
  antigravityValueTokens,
} = require("./rollout");
const { discoverT3AntigravityBrainDirs, mergeAntigravityInventories } = require("./antigravity-discovery");
const {
  normalizePerformance,
  createStreamingPerformanceCollector,
  createAntigravityPerformanceCollector,
} = require("./session-performance");
const { readOpencodeApiRates } = require("./opencode-rate");
const { readCodebuddyStreamTimings } = require("./codebuddy-stream-timing");
const { computeRowCost, getModelPricingInfo } = require("./pricing");
const { readSqliteJsonRows } = require("./sqlite-reader");

const IDLE_GAP_MS = 15 * 60 * 1000;
const DEFAULT_ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SAMPLES_PER_PROJECT = 24;

const CODEBUDDY_EDIT_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "replace",
  "search_replace",
  "str_replace",
  "create_file",
  "write_file",
  "apply_patch",
]);

const ANTIGRAVITY_EDIT_TOOLS = new Set([
  "edit_file",
  "write_file",
  "replace_file_content",
  "multi_replace_file_content",
  "create_file",
  "apply_patch",
]);

function finite(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function toNonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function flexibleTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const number = Number(trimmed);
      return Number.isFinite(number) && number > 0 ? (number < 1e11 ? number * 1000 : number) : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cleanTitle(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned || null;
}

function emptyTokenTotals() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function addTokenTotals(target, delta) {
  for (const field of [
    "input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]) {
    target[field] = finite(target[field]) + finite(delta?.[field]);
  }
}

function deriveProjectKey(cwd, fallbackPath = "") {
  if (typeof cwd === "string" && cwd.trim()) {
    const cleaned = cwd
      .trim()
      .replace(/^file:\/\//i, "")
      .replace(/[\\/]+$/, "");
    const parts = cleaned.split(/[\\/]/).filter(Boolean);
    const base = parts[parts.length - 1];
    if (base) return base;
  }
  if (typeof fallbackPath === "string" && fallbackPath.trim()) {
    return path.basename(path.dirname(fallbackPath)) || "unknown";
  }
  return "unknown";
}

function decodeFileUriToPath(uri) {
  if (typeof uri !== "string" || !uri.trim()) return null;
  const trimmed = uri.trim();
  if (!/^file:\/\//i.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    let pathname = decodeURIComponent(parsed.pathname || "");
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    if (process.platform === "win32") {
      pathname = pathname.replace(/\//g, "\\");
    }
    return pathname || null;
  } catch {
    return trimmed.replace(/^file:\/\/\/?/i, "");
  }
}

function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readCodebuddyActiveSessions(codebuddyHome) {
  const bySessionId = new Map();
  if (!codebuddyHome || typeof codebuddyHome !== "string") return bySessionId;
  const sessionsDir = path.join(codebuddyHome, "sessions");
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return bySessionId;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(sessionsDir, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId.trim() : "";
      if (!sessionId) continue;
      const pid = Number(parsed?.pid) || null;
      const alive = pid ? isPidAlive(pid) : false;
      const updatedAtMs = flexibleTimestampMs(parsed?.updatedAt ?? parsed?.lastHeartbeat ?? parsed?.startedAt);
      const startedAtMs = flexibleTimestampMs(parsed?.startedAt);
      const cwd = typeof parsed?.cwd === "string" && parsed.cwd.trim() ? parsed.cwd.trim() : null;
      const prev = bySessionId.get(sessionId);
      if (
        !prev ||
        (alive && !prev.alive) ||
        (updatedAtMs || 0) > (prev.updatedAtMs || 0)
      ) {
        bySessionId.set(sessionId, {
          sessionId,
          pid,
          alive,
          cwd,
          startedAtMs,
          updatedAtMs,
          mode: typeof parsed?.mode === "string" ? parsed.mode : null,
        });
      }
    } catch {
      /* ignore malformed session pid file */
    }
  }
  return bySessionId;
}

function normalizeCodebuddyModel(rawModel, fallback = "codebuddy-unknown") {
  if (typeof rawModel === "string" && rawModel.trim()) {
    return rawModel.trim();
  }
  return fallback || "codebuddy-unknown";
}

function extractCodebuddyRawUsageDelta(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const promptTokens = toNonNegativeInt(rawUsage.prompt_tokens);
  const completionTokensRaw = toNonNegativeInt(rawUsage.completion_tokens);
  const details =
    rawUsage.prompt_tokens_details && typeof rawUsage.prompt_tokens_details === "object"
      ? rawUsage.prompt_tokens_details
      : {};
  const completionDetails =
    rawUsage.completion_tokens_details && typeof rawUsage.completion_tokens_details === "object"
      ? rawUsage.completion_tokens_details
      : {};
  const cachedTokens = Math.max(
    toNonNegativeInt(details.cached_tokens),
    toNonNegativeInt(rawUsage.prompt_cache_hit_tokens),
    toNonNegativeInt(rawUsage.cache_read_input_tokens),
  );
  const cacheCreation = Math.max(
    toNonNegativeInt(rawUsage.cache_creation_input_tokens),
    toNonNegativeInt(rawUsage.prompt_cache_write_tokens),
  );
  const reasoningTokens = Math.min(
    completionTokensRaw,
    toNonNegativeInt(completionDetails.reasoning_tokens ?? rawUsage.completion_thinking_tokens),
  );
  const outputTokens = Math.max(0, completionTokensRaw - reasoningTokens);
  const inputTokens = Math.max(0, promptTokens - cachedTokens - cacheCreation);
  const totalTokens = inputTokens + outputTokens + cachedTokens + cacheCreation + reasoningTokens;
  if (totalTokens <= 0) return null;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedTokens,
    cache_creation_input_tokens: cacheCreation,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningTokens,
    total_tokens: totalTokens,
  };
}

function createBoundsTracker() {
  return {
    startedAtMs: null,
    endedAtMs: null,
    lastEventMs: null,
    activeMs: 0,
  };
}

function updateBoundsTracker(bounds, timestampValue) {
  const ms = flexibleTimestampMs(timestampValue);
  if (ms === null) return null;
  if (bounds.startedAtMs === null || ms < bounds.startedAtMs) bounds.startedAtMs = ms;
  if (bounds.endedAtMs === null || ms > bounds.endedAtMs) bounds.endedAtMs = ms;
  if (bounds.lastEventMs !== null && ms >= bounds.lastEventMs && ms - bounds.lastEventMs <= IDLE_GAP_MS) {
    bounds.activeMs += ms - bounds.lastEventMs;
  }
  if (bounds.lastEventMs === null || ms > bounds.lastEventMs) {
    bounds.lastEventMs = ms;
  }
  return ms;
}

async function scanCodebuddySessionFile(filePath, { env = process.env, defaultModel, sessionMetaById } = {}) {
  const resolvedPath = Array.isArray(filePath) ? filePath[0] : filePath;
  if (!resolvedPath || typeof resolvedPath !== "string") return null;
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const fallbackModel = defaultModel || resolveCodebuddyDefaultModel(env);
  const tokens = emptyTokenTotals();
  const performanceCollector = createStreamingPerformanceCollector();
  const timedRequests = [];
  const modelUsageByModel = new Map();
  const usageBuckets = new Map();
  const editTurnsByModel = new Map();
  const bounds = createBoundsTracker();
  const seenMessageIds = new Set();

  let rawSessionId = path.basename(resolvedPath, path.extname(resolvedPath));
  let observedSessionId = null;
  let cwd = null;
  let model = "unknown";
  let title = null;
  let turns = 0;
  let editTurns = 0;
  let currentHadEdit = false;
  let currentTurnModel = null;
  let toolCalls = 0;
  let toolFailures = 0;
  let usageEvents = 0;
  let lastRecordType = null;
  let lastRecordRole = null;

  function closeTurn() {
    if (currentHadEdit) {
      editTurns += 1;
      const key = currentTurnModel || model || "unknown";
      editTurnsByModel.set(key, (editTurnsByModel.get(key) || 0) + 1);
    }
    currentHadEdit = false;
  }

  const stream = fs.createReadStream(resolvedPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line || !line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    const tsMs = updateBoundsTracker(bounds, entry.timestamp ?? entry.message?.timestamp);
    if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
      rawSessionId = entry.sessionId.trim();
      observedSessionId = rawSessionId;
    }
    if (typeof entry.cwd === "string" && entry.cwd.trim()) {
      cwd = entry.cwd.trim();
    }
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
      const cleaned = cleanTitle(entry.aiTitle);
      if (cleaned) title = cleaned;
    } else if (entry.type === "topic" && typeof entry.topic === "string" && !title) {
      const cleaned = cleanTitle(entry.topic);
      if (cleaned) title = cleaned;
    }

    lastRecordType = typeof entry.type === "string" ? entry.type : lastRecordType;
    lastRecordRole = typeof entry.role === "string" ? entry.role : null;

    if (entry.type === "user" || (entry.type === "message" && entry.role === "user")) {
      closeTurn();
      turns += 1;
    }

    if (entry.type === "function_call") {
      toolCalls += 1;
      const toolName = String(entry.name || "").trim().toLowerCase();
      if (CODEBUDDY_EDIT_TOOLS.has(toolName)) {
        currentHadEdit = true;
      }
    } else if (entry.type === "function_call_result") {
      if (entry.status === "error" || entry.output?.rawResponse?.is_error) {
        toolFailures += 1;
      }
    }

    const provider = entry.providerData && typeof entry.providerData === "object" ? entry.providerData : null;
    const rawUsage = provider?.rawUsage && typeof provider.rawUsage === "object" ? provider.rawUsage : null;
    const messageId =
      (typeof provider?.messageId === "string" && provider.messageId) ||
      (typeof entry.uuid === "string" && entry.uuid) ||
      (typeof entry.id === "string" && entry.id) ||
      (tsMs !== null ? `${rawSessionId}:${tsMs}` : null);

    const candidateModel = normalizeCodebuddyModel(
      provider?.model || entry.model || entry.message?.model,
      fallbackModel,
    );
    if (candidateModel && candidateModel !== "codebuddy-unknown") {
      model = candidateModel;
      currentTurnModel = candidateModel;
    }

    let countedUsage = null;
    if (rawUsage && messageId && !seenMessageIds.has(messageId)) {
      countedUsage = extractCodebuddyRawUsageDelta(rawUsage);
      if (countedUsage) {
        seenMessageIds.add(messageId);
        if (typeof entry.id === "string" && entry.id && entry.id !== messageId) {
          seenMessageIds.add(entry.id);
        }
        const effectiveModel = candidateModel || (model !== "unknown" ? model : fallbackModel);
        if (provider?.messageId === messageId && tsMs !== null && !provider.isPartialAborted &&
            !provider.error && !entry.error && !entry.isApiErrorMessage && !entry.message?.error) {
          timedRequests.push({ messageId, model: effectiveModel, usage: countedUsage, timestampMs: tsMs });
        }
        model = effectiveModel;
        currentTurnModel = effectiveModel;
        addTokenTotals(tokens, countedUsage);
        usageEvents += 1;

        const modelRow = modelUsageByModel.get(effectiveModel) || {
          model: effectiveModel,
          ...emptyTokenTotals(),
          usage_events: 0,
        };
        addTokenTotals(modelRow, countedUsage);
        modelRow.usage_events += 1;
        modelUsageByModel.set(effectiveModel, modelRow);

        if (tsMs !== null) {
          const bucketIso = new Date(Math.floor(tsMs / 60_000) * 60_000).toISOString();
          const bucketKey = `${bucketIso}\u0000${effectiveModel}`;
          const bucket = usageBuckets.get(bucketKey) || {
            timestamp: bucketIso,
            model: effectiveModel,
            ...emptyTokenTotals(),
            usage_events: 0,
          };
          addTokenTotals(bucket, countedUsage);
          bucket.usage_events += 1;
          usageBuckets.set(bucketKey, bucket);
        }
      }
    }
  }

  closeTurn();
  const timings = await readCodebuddyStreamTimings(resolvedPath, timedRequests.map((request) => request.timestampMs));
  for (const request of timedRequests) {
    const timing = timings.get(request.messageId);
    if (!timing) continue;
    performanceCollector.consumeUsage({
      ...timing,
      model: request.model,
      timestampMs: request.timestampMs,
      outputTokens: request.usage.output_tokens,
      reasoningTokens: request.usage.reasoning_output_tokens,
      totalTokens: request.usage.total_tokens,
    });
  }
  const performance = performanceCollector.finish();
  const sessionMeta = sessionMetaById instanceof Map ? sessionMetaById.get(rawSessionId) : null;
  if (!cwd && sessionMeta?.cwd) cwd = sessionMeta.cwd;

  const modelUsage = [...modelUsageByModel.values()].map((row) => ({
    ...row,
    edit_turns: finite(editTurnsByModel.get(row.model)),
    performance: performance.byModel.get(row.model) || normalizePerformance(),
    cost_usd: computeRowCost({ source: "codebuddy", model: row.model, ...row }),
    pricing: getModelPricingInfo(row.model, { source: "codebuddy" }),
  }));
  const totalCostUsd = modelUsage.reduce((sum, row) => sum + finite(row.cost_usd), 0);
  const resolvedModel =
    modelUsage.length > 1
      ? "mixed"
      : modelUsage[0]?.model || (model !== "unknown" ? model : fallbackModel);

  return {
    session_hash: crypto.createHash("sha256").update(`codebuddy\0${rawSessionId}`).digest("hex").slice(0, 24),
    session_id: observedSessionId || rawSessionId || null,
    title: title || null,
    source: "codebuddy",
    project_key: deriveProjectKey(cwd, resolvedPath),
    project_ref: cwd || null,
    model: resolvedModel,
    model_usage: modelUsage,
    usage_buckets: [...usageBuckets.values()],
    performance: performance.performance,
    rate_samples: performance.samples || [],
    started_at: bounds.startedAtMs ? new Date(bounds.startedAtMs).toISOString() : null,
    ended_at: bounds.endedAtMs ? new Date(bounds.endedAtMs).toISOString() : null,
    duration_ms: bounds.activeMs,
    active_ms: bounds.activeMs,
    turns,
    edit_turns: editTurns,
    retry_turns: 0,
    subagent_calls: 0,
    subagent_types: {},
    tool_calls: toolCalls,
    tool_failures: toolFailures,
    usage_events: usageEvents,
    model_calls: usageEvents,
    tokens,
    total_tokens: tokens.total_tokens,
    cost_usd: totalCostUsd,
    cost_source: "model_pricing",
    usage_precision: usageEvents > 0 ? "reported" : "unavailable",
    file_mtime_ms: Number(stat.mtimeMs) || 0,
    session_store_bytes: Number(stat.size) || 0,
    session_store_metric: "logical",
    pid: sessionMeta?.pid || null,
    process_alive: Boolean(sessionMeta?.alive),
    heartbeat_ms: sessionMeta?.updatedAtMs || null,
    last_record_type: lastRecordType,
    last_record_role: lastRecordRole,
    provenance: {
      source: "local-session-log",
      confidence: "observed",
      retry_confidence: "unavailable",
      content_retained: false,
    },
  };
}

function readAntigravitySummariesByDir(brainDir) {
  const byId = new Map();
  if (!brainDir || typeof brainDir !== "string") return byId;
  const variantRoot = path.dirname(brainDir);
  const summariesDbPath = path.join(variantRoot, "conversation_summaries.db");
  try {
    if (!fs.existsSync(summariesDbPath)) return byId;
    const rows = readSqliteJsonRows(
      summariesDbPath,
      "SELECT conversation_id, title, step_count, last_modified_time, workspace_uris, status, project_id, agent_name, parent_conversation_id, not_fully_idle, killed, last_user_input_time FROM conversation_summaries",
      {
        label: "AntigravitySummaries",
        readOnly: true,
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = typeof row?.conversation_id === "string" ? row.conversation_id.trim() : "";
      if (!id) continue;
      let workspacePath = null;
      if (typeof row.workspace_uris === "string" && row.workspace_uris.trim()) {
        try {
          const uris = JSON.parse(row.workspace_uris);
          if (Array.isArray(uris) && uris.length > 0) {
            workspacePath = decodeFileUriToPath(uris[0]);
          }
        } catch {
          workspacePath = decodeFileUriToPath(row.workspace_uris);
        }
      }
      byId.set(id, {
        conversationId: id,
        title: cleanTitle(row.title),
        stepCount: Number(row.step_count) || 0,
        lastModifiedMs: flexibleTimestampMs(row.last_modified_time),
        lastUserInputMs: flexibleTimestampMs(row.last_user_input_time),
        workspacePath,
        status: typeof row.status === "string" ? row.status.trim() : "",
        agentName: typeof row.agent_name === "string" && row.agent_name.trim() ? row.agent_name.trim() : null,
        parentConversationId:
          typeof row.parent_conversation_id === "string" && row.parent_conversation_id.trim()
            ? row.parent_conversation_id.trim()
            : null,
        notFullyIdle: Boolean(Number(row.not_fully_idle)),
        killed: Boolean(Number(row.killed)),
      });
    }
  } catch {
    /* optional summary db may be locked or absent */
  }
  return byId;
}

function extractWorkspaceFromAntigravityContent(content) {
  if (typeof content !== "string" || !content) return null;
  const cwdMatch = content.match(/Command Working Directory:\s*([^\r\n<]+)/i);
  if (cwdMatch && cwdMatch[1]?.trim()) {
    return cwdMatch[1].trim();
  }
  const activeMatch = content.match(/Active Workspaces:\s*\r?\n-\s*([^\r\n<]+)/i);
  if (activeMatch && activeMatch[1]?.trim()) {
    return activeMatch[1].trim();
  }
  return null;
}

async function scanAntigravitySessionFile(filePath, { summaryById } = {}) {
  const resolvedPath = Array.isArray(filePath) ? filePath[0] : filePath;
  if (!resolvedPath || typeof resolvedPath !== "string") return null;
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const raw = await fsp.readFile(resolvedPath, "utf8").catch(() => null);
  if (!raw || !raw.trim()) return null;

  const match = resolvedPath.match(/^(.*)[/\\]brain[/\\]([^/\\]+)[/\\]\.system_generated[/\\]logs[/\\]transcript.*\.jsonl$/);
  const conversationId = match ? match[2] : path.basename(resolvedPath, ".jsonl");
  const brainDir = match ? path.join(match[1], "brain") : null;
  const summaries = summaryById instanceof Map
    ? summaryById
    : brainDir
      ? readAntigravitySummariesByDir(brainDir)
      : new Map();
  const summary = summaries.get(conversationId) || null;

  const dbPath = resolveAntigravityDbPath(resolvedPath);
  const stepMap = dbPath ? readAntigravityConversationDb(dbPath) : null;
  let currentModel = await readAntigravityDefaultModel(resolvedPath);
  let lastPlannerModel = null;
  let contextTokens = 0;
  let previousContextTokens = 0;

  const tokens = emptyTokenTotals();
  const performanceCollector = createAntigravityPerformanceCollector();
  const modelUsageByModel = new Map();
  const usageBuckets = new Map();
  const editTurnsByModel = new Map();
  const bounds = createBoundsTracker();

  let workspacePath = summary?.workspacePath || null;
  let turns = 0;
  let editTurns = 0;
  let currentHadEdit = false;
  let currentTurnModel = null;
  let toolCalls = 0;
  let errorCount = 0;
  let usageEvents = 0;
  let lastStepType = null;
  let lastStepStatus = null;

  function closeTurn() {
    if (currentHadEdit) {
      editTurns += 1;
      const key = currentTurnModel || currentModel || "unknown";
      editTurnsByModel.set(key, (editTurnsByModel.get(key) || 0) + 1);
    }
    currentHadEdit = false;
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    const tsMs = updateBoundsTracker(bounds, parsed.created_at ?? parsed.timestamp);
    lastStepType = typeof parsed.type === "string" ? parsed.type : lastStepType;
    lastStepStatus = typeof parsed.status === "string" ? parsed.status : lastStepStatus;

    if (!workspacePath && (parsed.type === "USER_INPUT" || i < 5)) {
      const extracted = extractWorkspaceFromAntigravityContent(parsed.content);
      if (extracted) workspacePath = extracted;
    }

    if (parsed.type === "USER_INPUT" || parsed.type === "USER_SETTINGS_CHANGE") {
      const content = typeof parsed.content === "string" ? parsed.content : "";
      const selectedModel = parseAntigravityModelSelection(content);
      if (selectedModel) currentModel = selectedModel;
      if (parsed.type === "USER_INPUT") {
        closeTurn();
        turns += 1;
      }
    }

    const eventContextTokens = antigravityContextTokens(parsed);
    const dbTurn =
      parsed.type === "PLANNER_RESPONSE" && stepMap && Number.isFinite(parsed.step_index)
        ? stepMap.get(parsed.step_index)
        : null;
    const dbContextTokens = dbTurn && dbTurn.contextTokens > 0 ? dbTurn.contextTokens : 0;
    if (dbTurn && dbTurn.model) {
      const norm = normalizeAntigravityTranscriptModel(dbTurn.model);
      if (norm) currentModel = norm;
    } else if (parsed.type === "PLANNER_RESPONSE" && typeof parsed.model === "string" && parsed.model.trim()) {
      const norm = normalizeAntigravityTranscriptModel(parsed.model);
      if (norm) currentModel = norm;
    }

    if (parsed.type !== "PLANNER_RESPONSE") {
      contextTokens += eventContextTokens;
      continue;
    }

    if (String(parsed.status || "").toUpperCase() === "ERROR") {
      errorCount += 1;
    }

    const calls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
    toolCalls += calls.length;
    for (const call of calls) {
      const name = String(call?.name || "").trim().toLowerCase();
      if (ANTIGRAVITY_EDIT_TOOLS.has(name)) {
        currentHadEdit = true;
      }
    }

    const model = currentModel || "antigravity-unknown";
    currentTurnModel = model;
    const delta = emptyTokenTotals();

    if (dbTurn?.hasUsageMetadata) {
      const uncached = toNonNegativeInt(dbTurn.uncachedInput);
      const cached = toNonNegativeInt(dbTurn.cachedInput);
      const reasoning = toNonNegativeInt(dbTurn.reasoningOutput);
      let output = 0;
      if (Number.isFinite(dbTurn.textOutput) && dbTurn.textOutput > 0) {
        output = toNonNegativeInt(dbTurn.textOutput);
      } else if (Number.isFinite(dbTurn.outputTokens)) {
        output = Math.max(0, toNonNegativeInt(dbTurn.outputTokens) - reasoning);
      }
      delta.input_tokens = uncached;
      delta.cached_input_tokens = cached;
      delta.output_tokens = output;
      delta.reasoning_output_tokens = reasoning;
      delta.total_tokens = uncached + cached + output + reasoning;
      contextTokens = dbContextTokens > 0 ? dbContextTokens : uncached + cached;
    } else if (
      Number.isFinite(Number(parsed.input_tokens)) ||
      Number.isFinite(Number(parsed.output_tokens)) ||
      Number.isFinite(Number(parsed.cache_read_tokens))
    ) {
      const uncached = toNonNegativeInt(parsed.input_tokens);
      const cached = toNonNegativeInt(parsed.cache_read_tokens ?? parsed.cached_input_tokens);
      const cacheCreation = toNonNegativeInt(parsed.cache_creation_tokens ?? parsed.cache_creation_input_tokens);
      const rawOut = toNonNegativeInt(parsed.output_tokens);
      const reasoning = toNonNegativeInt(
        parsed.reasoning_tokens ?? parsed.reasoning_output_tokens ?? antigravityValueTokens(parsed.thinking || ""),
      );
      const output = rawOut >= reasoning && parsed.reasoning_tokens != null ? rawOut - reasoning : rawOut;
      delta.input_tokens = uncached;
      delta.cached_input_tokens = cached;
      delta.cache_creation_input_tokens = cacheCreation;
      delta.output_tokens = output;
      delta.reasoning_output_tokens = parsed.reasoning_tokens != null ? reasoning : 0;
      delta.total_tokens =
        uncached + cached + cacheCreation + output + delta.reasoning_output_tokens;
      contextTokens = uncached + cached;
    } else {
      const content = typeof parsed.content === "string" ? parsed.content : "";
      const thinking = typeof parsed.thinking === "string" ? parsed.thinking : "";
      if (dbContextTokens > 0) {
        contextTokens = dbContextTokens;
      }
      if (lastPlannerModel && model !== lastPlannerModel) {
        previousContextTokens = 0;
      }
      const inputDelta = Math.max(0, contextTokens - previousContextTokens);
      const outputTokens = antigravityValueTokens(content) + antigravityValueTokens(parsed.tool_calls);
      const reasoningTokens = antigravityValueTokens(thinking);
      delta.input_tokens = inputDelta;
      delta.output_tokens = outputTokens;
      delta.reasoning_output_tokens = reasoningTokens;
      delta.total_tokens = inputDelta + outputTokens + reasoningTokens;
    }

    if (delta.total_tokens > 0) {
      addTokenTotals(tokens, delta);
      usageEvents += 1;
      const modelRow = modelUsageByModel.get(model) || {
        model,
        ...emptyTokenTotals(),
        usage_events: 0,
      };
      addTokenTotals(modelRow, delta);
      modelRow.usage_events += 1;
      modelUsageByModel.set(model, modelRow);

      if (tsMs !== null) {
        const bucketIso = new Date(Math.floor(tsMs / 60_000) * 60_000).toISOString();
        const bucketKey = `${bucketIso}\u0000${model}`;
        const bucket = usageBuckets.get(bucketKey) || {
          timestamp: bucketIso,
          model,
          ...emptyTokenTotals(),
          usage_events: 0,
        };
        addTokenTotals(bucket, delta);
        bucket.usage_events += 1;
        usageBuckets.set(bucketKey, bucket);
      }
    }

    performanceCollector.consume(parsed, {
      model,
      outputTokens: delta.output_tokens,
      reasoningTokens: delta.reasoning_output_tokens,
      totalTokens: delta.total_tokens,
      dbTurn,
    });

    previousContextTokens = contextTokens;
    lastPlannerModel = model;
    contextTokens += eventContextTokens;
  }

  closeTurn();
  const performance = performanceCollector.finish();
  const modelUsage = [...modelUsageByModel.values()].map((row) => ({
    ...row,
    edit_turns: finite(editTurnsByModel.get(row.model)),
    performance: performance.byModel.get(row.model) || normalizePerformance(),
    cost_usd: computeRowCost({ source: "antigravity", model: row.model, ...row }),
    pricing: getModelPricingInfo(row.model, { source: "antigravity" }),
  }));
  const totalCostUsd = modelUsage.reduce((sum, row) => sum + finite(row.cost_usd), 0);
  const resolvedModel =
    modelUsage.length > 1
      ? "mixed"
      : modelUsage[0]?.model || currentModel || "antigravity-unknown";

  return {
    session_hash: crypto.createHash("sha256").update(`antigravity\0${conversationId}`).digest("hex").slice(0, 24),
    session_id: conversationId,
    parent_session_id: summary?.parentConversationId || null,
    agent_nickname: summary?.agentName || null,
    agent_role: summary?.agentName || null,
    title: summary?.title || null,
    source: "antigravity",
    project_key: workspacePath ? deriveProjectKey(workspacePath, resolvedPath) : deriveProjectKey(null, resolvedPath),
    project_ref: workspacePath || null,
    model: resolvedModel,
    model_usage: modelUsage,
    usage_buckets: [...usageBuckets.values()],
    performance: performance.performance,
    rate_samples: performance.samples || [],
    started_at: bounds.startedAtMs ? new Date(bounds.startedAtMs).toISOString() : null,
    ended_at: bounds.endedAtMs ? new Date(bounds.endedAtMs).toISOString() : null,
    duration_ms: bounds.activeMs,
    active_ms: bounds.activeMs,
    turns,
    edit_turns: editTurns,
    retry_turns: 0,
    subagent_calls: 0,
    subagent_types: {},
    tool_calls: toolCalls,
    error_count: errorCount,
    usage_events: usageEvents,
    model_calls: usageEvents,
    context_tokens_used: contextTokens,
    tokens,
    total_tokens: tokens.total_tokens,
    cost_usd: totalCostUsd,
    cost_source: "model_pricing",
    usage_precision: stepMap && stepMap.size > 0 ? "reported" : "mixed",
    // Do not fold SQLite db/wal mtime into activity time: opening or checkpointing
    // old conversation DBs updates file mtimes without any actual turn activity.
    file_mtime_ms: Math.max(Number(stat.mtimeMs) || 0, summary?.lastModifiedMs || 0),
    session_store_bytes: Number(stat.size) || 0,
    session_store_metric: "logical",
    run_status: summary?.status || null,
    not_fully_idle: Boolean(summary?.notFullyIdle),
    killed: Boolean(summary?.killed),
    last_step_type: lastStepType,
    last_step_status: lastStepStatus,
    provenance: {
      source: "local-session-log",
      confidence: "observed",
      retry_confidence: "unavailable",
      content_retained: false,
    },
  };
}

async function discoverAntigravityTranscriptFiles({ home = os.homedir(), env = process.env, homedir = os.homedir } = {}) {
  const usingMachineHome = path.resolve(home) === path.resolve(homedir());
  const hasExplicitEnv = env && env !== process.env;
  const geminiHome = (usingMachineHome || hasExplicitEnv) && env?.GEMINI_HOME
    ? path.resolve(home, env.GEMINI_HOME)
    : path.join(home, ".gemini");
  const overrideHome =
    (usingMachineHome || hasExplicitEnv) &&
    typeof env?.TOKENTRACKER_ANTIGRAVITY_HOME === "string" &&
    env.TOKENTRACKER_ANTIGRAVITY_HOME.trim()
      ? path.resolve(home, env.TOKENTRACKER_ANTIGRAVITY_HOME.trim())
      : null;
  const extraBrainDirs = overrideHome ? [path.join(overrideHome, "brain")] : [];
  const t3Discovery = await discoverT3AntigravityBrainDirs({
    home,
    env: usingMachineHome || hasExplicitEnv ? env : { HOME: home },
    platform: usingMachineHome ? process.platform : "darwin",
  });
  const listing = await listAntigravityTranscriptsWithStatus(
    geminiHome,
    null,
    [...extraBrainDirs, ...(t3Discovery.brainDirs || [])],
  );
  return mergeAntigravityInventories([listing]);
}

function discoverCodebuddyJsonlFiles({ home = os.homedir(), env = process.env, homedir = os.homedir } = {}) {
  const usingMachineHome = path.resolve(home) === path.resolve(homedir());
  const hasExplicitEnv = env && env !== process.env;
  const codebuddyHome =
    (usingMachineHome || hasExplicitEnv) && typeof env?.CODEBUDDY_HOME === "string" && env.CODEBUDDY_HOME.trim()
      ? path.resolve(home, env.CODEBUDDY_HOME.trim())
      : path.join(home, ".codebuddy");
  const jsonlFiles = [];
  if (codebuddyHome) {
    const projectsDir = path.join(codebuddyHome, "projects");
    if (fs.existsSync(projectsDir)) {
      const walkJsonl = (dir) => {
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          let isDir = entry.isDirectory();
          let isFile = entry.isFile();
          if (!isDir && !isFile) {
            try {
              const st = fs.statSync(full);
              isDir = st.isDirectory();
              isFile = st.isFile();
            } catch {
              continue;
            }
          }
          if (isDir) walkJsonl(full);
          else if (isFile && entry.name.endsWith(".jsonl")) jsonlFiles.push(full);
        }
      };
      walkJsonl(projectsDir);
    }
  }
  jsonlFiles.sort((a, b) => a.localeCompare(b));
  return {
    codebuddyHome,
    jsonlFiles,
  };
}

function computeRecentWindowRate(buckets, nowMs, windowMs = 5 * 60 * 1000) {
  const cutoff = nowMs - windowMs;
  let recentTokens = 0;
  let recentRequests = 0;
  const byModel = new Map();
  for (const bucket of buckets || []) {
    const ms = flexibleTimestampMs(bucket?.timestamp);
    if (ms === null || ms < cutoff || ms > nowMs) continue;
    const count = finite(bucket.total_tokens);
    recentTokens += count;
    recentRequests += finite(bucket.usage_events) || 1;
    byModel.set(bucket.model, (byModel.get(bucket.model) || 0) + count);
  }
  return {
    recentTokens,
    byModel,
    tokensPerMinute: recentTokens * 60_000 / windowMs,
    requestsPerMinute: recentRequests * 60_000 / windowMs,
  };
}

function streamRate(sample) {
  // TPOT excludes the first token, whose wait is measured by TTFT.
  if ((sample.timing && sample.timing !== "stream") || !(sample.duration_ms > 0 && sample.output_tokens > 1)) return null;
  return (sample.output_tokens - 1) * 1000 / sample.duration_ms;
}

function summarizeRateSamples(samples, windowTokens, windowMs) {
  const stream = samples.filter((sample) => streamRate(sample) !== null);
  const recent = [...stream].sort((a, b) => b.timestamp_ms - a.timestamp_ms).slice(0, 3);
  const output = stream.reduce((sum, sample) => sum + sample.output_tokens - 1, 0);
  const duration = stream.reduce((sum, sample) => sum + sample.duration_ms, 0);
  const latestOutput = recent.reduce((sum, sample) => sum + sample.output_tokens - 1, 0);
  const latestDuration = recent.reduce((sum, sample) => sum + sample.duration_ms, 0);
  const peak = stream.reduce((max, sample) => Math.max(max, streamRate(sample)), 0);
  const first = samples.filter((sample) => Number.isFinite(sample.first_response_ms) && sample.first_response_ms >= 0);
  const measured = samples.filter((sample) =>
    sample.output_tokens > 0 && (sample.end_to_end_ms > 0 || (sample.timing === "request" && sample.duration_ms > 0)),
  );
  const estimates = samples.filter((sample) => sample.timing === "estimated" && sample.duration_ms > 0);
  const endToEnd = measured.length ? measured : estimates;
  const endToEndOutput = endToEnd.reduce((sum, sample) => sum + sample.output_tokens, 0);
  const endToEndDuration = endToEnd.reduce((sum, sample) => sum + (sample.end_to_end_ms || sample.duration_ms), 0);
  const round = (value) => Number(value.toFixed(1));
  return {
    output_tokens_per_second: duration > 0 ? round(output * 1000 / duration) : null,
    latest_tokens_per_second: latestDuration > 0 ? round(latestOutput * 1000 / latestDuration) : null,
    peak_tokens_per_second: peak > 0 ? round(peak) : null,
    total_tokens_per_second: windowTokens > 0 ? round(windowTokens * 1000 / windowMs) : null,
    end_to_end_tokens_per_second: endToEndDuration > 0 ? round(endToEndOutput * 1000 / endToEndDuration) : null,
    end_to_end_estimated: measured.length === 0 && estimates.length > 0,
    estimated_output_tokens: output + stream.length,
    estimated_duration_ms: duration,
    estimated_request_count: samples.filter((sample) => sample.output_tokens > 0 && (sample.duration_ms > 0 || sample.end_to_end_ms > 0)).length,
    first_response_ms: first.length ? Math.round(first.reduce((sum, sample) => sum + sample.first_response_ms, 0) / first.length) : null,
    first_response_sample_count: first.length,
  };
}

function classifySessionActivity(session, { nowMs = Date.now(), activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS, recentWindowMs = DEFAULT_RECENT_WINDOW_MS } = {}) {
  const endedMs = flexibleTimestampMs(session.ended_at || session.started_at);
  const mtimeMs = Number(session.file_mtime_ms) || 0;
  const heartbeatMs = Number(session.heartbeat_ms) || 0;
  const lastActivityMs = Math.max(endedMs || 0, mtimeMs, heartbeatMs);
  const ageMs = lastActivityMs > 0 ? Math.max(0, nowMs - lastActivityMs) : Infinity;

  if (session.source === "codebuddy") {
    if (session.process_alive && ageMs <= Math.max(activeWindowMs * 4, 60 * 60 * 1000)) {
      return { status: "running", lastActivityMs, ageMs };
    }
    return { status: ageMs <= recentWindowMs ? "recent" : "idle", lastActivityMs, ageMs };
  }
  if (session.source === "antigravity") {
    if (session.killed) {
      return { status: ageMs <= recentWindowMs ? "recent" : "idle", lastActivityMs, ageMs };
    }
    if (session.run_status) {
      const activeStatus =
        session.run_status === "CASCADE_RUN_STATUS_RUNNING" || Boolean(session.not_fully_idle);
      if (activeStatus && ageMs <= Math.max(activeWindowMs * 4, 60 * 60 * 1000)) {
        return { status: "running", lastActivityMs, ageMs };
      }
      return { status: ageMs <= recentWindowMs ? "recent" : "idle", lastActivityMs, ageMs };
    }
  }
  if (ageMs <= activeWindowMs) {
    return { status: "running", lastActivityMs, ageMs };
  }
  if (ageMs <= recentWindowMs) {
    return { status: "recent", lastActivityMs, ageMs };
  }
  return { status: "idle", lastActivityMs, ageMs };
}

async function computeProjectTokenRates({
  home = os.homedir(),
  env = process.env,
  now = Date.now(),
  activeWindowMinutes = 15,
  recentWindowMinutes = 1440,
  refresh = false,
} = {}) {
  const nowMs = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const activeWindowMs = Math.max(1, Number(activeWindowMinutes) || 15) * 60 * 1000;
  const recentWindowMs = Math.max(activeWindowMinutes, Number(recentWindowMinutes) || 1440) * 60 * 1000;

  const { buildSessionAnalytics, listSessionsForBrowser } = require("./session-analytics");
  const baseSessionsRaw = await buildSessionAnalytics({ home, recheck: refresh, cacheTtlMs: 5_000 });
  const browserSessions = listSessionsForBrowser(baseSessionsRaw, {
    includeBuckets: true,
    includeModelDetail: true,
    includeRateSamples: true,
  }).sessions || [];
  const cutoffMs = nowMs - activeWindowMs;
  const opencodeRates = await readOpencodeApiRates(browserSessions.filter((row) =>
    row.source === "opencode" && row.session_id &&
    row.rate_samples.some((sample) => sample.timestamp_ms >= cutoffMs),
  ), { home, env, cutoffMs });

  const { codebuddyHome, jsonlFiles: codebuddyFiles } = discoverCodebuddyJsonlFiles({ home, env });
  const sessionMetaById = readCodebuddyActiveSessions(codebuddyHome);
  const defaultCodebuddyModel = resolveCodebuddyDefaultModel(
    path.resolve(home) === path.resolve(os.homedir()) ? env : { HOME: home, CODEBUDDY_HOME: codebuddyHome },
  );

  // Scan fresh CodeBuddy and Antigravity sessions directly so live rate samples
  // and process/running flags are always up-to-the-second.
  const recentCutoffMs = nowMs - Math.max(recentWindowMs * 2, 7 * 24 * 60 * 60 * 1000);
  const candidateCodebuddyFiles = codebuddyFiles.filter((filePath) => {
    try {
      const st = fs.statSync(filePath);
      if (st.size <= 0) return false;
      const sid = path.basename(filePath, ".jsonl");
      if (sessionMetaById.get(sid)?.alive) return true;
      return st.mtimeMs >= recentCutoffMs;
    } catch {
      return false;
    }
  });

  const antigravityFiles = await discoverAntigravityTranscriptFiles({ home, env });
  const summariesByBrainDir = new Map();
  const getSummaryMap = (filePath) => {
    const m = filePath.match(/^(.*[/\\]brain)[/\\][^/\\]+[/\\]\.system_generated/);
    const brainDir = m ? m[1] : "";
    if (!summariesByBrainDir.has(brainDir)) {
      summariesByBrainDir.set(brainDir, readAntigravitySummariesByDir(brainDir));
    }
    return summariesByBrainDir.get(brainDir);
  };

  const [codebuddyRows, antigravityRows] = await Promise.all([
    Promise.all(
      candidateCodebuddyFiles.map((filePath) =>
        scanCodebuddySessionFile(filePath, {
          env,
          defaultModel: defaultCodebuddyModel,
          sessionMetaById,
        }).catch(() => null),
      ),
    ),
    Promise.all(
      antigravityFiles.map((filePath) =>
        scanAntigravitySessionFile(filePath, {
          summaryById: getSummaryMap(filePath),
        }).catch(() => null),
      ),
    ),
  ]);

  const byHash = new Map();
  for (const row of browserSessions) {
    if (!row || finite(row.total_tokens) <= 0) continue;
    byHash.set(row.session_hash, row);
  }
  for (const row of [...codebuddyRows, ...antigravityRows]) {
    if (!row || finite(row.total_tokens) <= 0) continue;
    byHash.set(row.session_hash, row);
  }

  const allSessions = [...byHash.values()];
  const projectsMap = new Map();
  const providerAggMap = new Map();
  const modelAggMap = new Map();

  for (const session of allSessions) {
    const activity = classifySessionActivity(session, {
      nowMs,
      activeWindowMs,
      recentWindowMs,
    });
    const sessionTokens = {
      input_tokens: finite(session.tokens?.input_tokens ?? session.input_tokens),
      cached_input_tokens: finite(session.tokens?.cached_input_tokens ?? session.cached_input_tokens),
      cache_creation_input_tokens: finite(
        session.tokens?.cache_creation_input_tokens ?? session.cache_creation_input_tokens,
      ),
      output_tokens: finite(session.tokens?.output_tokens ?? session.output_tokens),
      reasoning_output_tokens: finite(
        session.tokens?.reasoning_output_tokens ?? session.reasoning_output_tokens,
      ),
      total_tokens: finite(session.total_tokens ?? session.tokens?.total_tokens),
    };
    const windowRate = computeRecentWindowRate(session.usage_buckets, nowMs, activeWindowMs);
    const official = opencodeRates.get(session.session_hash);
    const samples = (session.rate_samples || [])
      .map((sample) => official?.samples.get(sample.request_id) || sample)
      .filter((sample) => Number.isFinite(sample.timestamp_ms) && sample.timestamp_ms >= cutoffMs && sample.timestamp_ms <= nowMs);
    const nativeRate = official?.nativeRate?.timestamp_ms >= (session.native_rate?.timestamp_ms || 0)
      ? official.nativeRate : session.native_rate;
    const rateSummary = summarizeRateSamples(samples, windowRate.recentTokens, activeWindowMs);

    const projectKey = session.project_key || deriveProjectKey(session.project_ref);
    const projectGroupKey = `${projectKey.toLowerCase()}::${String(session.project_ref || "").toLowerCase()}`;
    let project = projectsMap.get(projectGroupKey);
    if (!project) {
      project = {
        project_id: crypto.createHash("sha256").update(projectGroupKey).digest("hex").slice(0, 16),
        project_key: projectKey,
        project_ref: session.project_ref || null,
        status: "idle",
        active_session_count: 0,
        session_count: 0,
        sourcesSet: new Set(),
        modelsSet: new Set(),
        sourceTokens: new Map(),
        modelTokens: new Map(),
        latest_title: null,
        last_active_at: null,
        last_active_ms: 0,
        started_at: null,
        started_ms: null,
        duration_ms: 0,
        turns: 0,
        tool_calls: 0,
        cost_usd: 0,
        tokens: emptyTokenTotals(),
        recent_tokens: 0,
        samples: [],
        sessions: [],
      };
      projectsMap.set(projectGroupKey, project);
    }

    project.session_count += 1;
    if (activity.status === "running") {
      project.active_session_count += 1;
      project.status = "running";
    } else if (activity.status === "recent" && project.status === "idle") {
      project.status = "recent";
    }

    const src = String(session.source || "unknown").toLowerCase();
    project.sourcesSet.add(src);
    project.sourceTokens.set(src, (project.sourceTokens.get(src) || 0) + sessionTokens.total_tokens);

    for (const mRow of Array.isArray(session.model_usage) && session.model_usage.length > 0
      ? session.model_usage
      : [{ model: session.model || "unknown", total_tokens: sessionTokens.total_tokens, performance: session.performance }]) {
      const mName = mRow.model || "unknown";
      if (mName !== "unknown" && mName !== "mixed") {
        project.modelsSet.add(mName);
        project.modelTokens.set(mName, (project.modelTokens.get(mName) || 0) + finite(mRow.total_tokens));
      }
    }

    if (activity.lastActivityMs > project.last_active_ms) {
      project.last_active_ms = activity.lastActivityMs;
      project.last_active_at = new Date(activity.lastActivityMs).toISOString();
      if (session.title) project.latest_title = session.title;
    } else if (!project.latest_title && session.title) {
      project.latest_title = session.title;
    }

    const startMs = flexibleTimestampMs(session.started_at);
    if (startMs !== null && (project.started_ms === null || startMs < project.started_ms)) {
      project.started_ms = startMs;
      project.started_at = new Date(startMs).toISOString();
    }

    project.duration_ms += finite(session.duration_ms);
    project.turns += finite(session.turns);
    project.tool_calls += finite(session.tool_calls);
    project.cost_usd += finite(session.cost_usd);
    addTokenTotals(project.tokens, sessionTokens);
    project.recent_tokens += windowRate.recentTokens;
    for (const sample of samples) {
      project.samples.push({ ...sample, source: src });
    }

    project.sessions.push({
      session_hash: session.session_hash,
      session_id: session.session_id || null,
      title: session.title || projectKey,
      source: src,
      model: session.model || "unknown",
      status: activity.status,
      process_alive: Boolean(session.process_alive),
      pid: session.pid || null,
      run_status: session.run_status || null,
      last_active_at: activity.lastActivityMs > 0 ? new Date(activity.lastActivityMs).toISOString() : session.ended_at,
      started_at: session.started_at || null,
      ended_at: session.ended_at || null,
      duration_ms: finite(session.duration_ms),
      turns: finite(session.turns),
      tool_calls: finite(session.tool_calls),
      cost_usd: Number(finite(session.cost_usd).toFixed(6)),
      tokens: sessionTokens,
      rate: {
        ...rateSummary,
        tokens_per_minute: Number(windowRate.tokensPerMinute.toFixed(1)),
        requests_per_minute: Number(windowRate.requestsPerMinute.toFixed(2)),
        ...(nativeRate?.timestamp_ms >= cutoffMs && nativeRate.timestamp_ms <= nowMs ? {
          native_tokens_per_second: Number(nativeRate.tokens_per_second.toFixed(1)),
          native_source: nativeRate.source,
        } : {}),
      },
    });

    // Provider aggregation
    let providerAgg = providerAggMap.get(src);
    if (!providerAgg) {
      providerAgg = {
        source: src,
        active_sessions: 0,
        total_sessions: 0,
        projectsSet: new Set(),
        activeProjectsSet: new Set(),
        tokens: emptyTokenTotals(),
        cost_usd: 0,
        recent_tokens: 0,
        samples: [],
        last_active_ms: 0,
      };
      providerAggMap.set(src, providerAgg);
    }
    providerAgg.total_sessions += 1;
    providerAgg.projectsSet.add(projectKey);
    if (activity.status === "running") {
      providerAgg.active_sessions += 1;
      providerAgg.activeProjectsSet.add(projectKey);
    }
    addTokenTotals(providerAgg.tokens, sessionTokens);
    providerAgg.cost_usd += finite(session.cost_usd);
    providerAgg.recent_tokens += windowRate.recentTokens;
    providerAgg.samples.push(...samples);
    if (activity.lastActivityMs > providerAgg.last_active_ms) {
      providerAgg.last_active_ms = activity.lastActivityMs;
    }

    // Model aggregation
    const modelRows = Array.isArray(session.model_usage) && session.model_usage.length > 0
      ? session.model_usage
      : [{
          model: session.model || "unknown",
          ...sessionTokens,
          cost_usd: session.cost_usd,
          performance: session.performance,
        }];
    for (const mRow of modelRows) {
      const mName = mRow.model || "unknown";
      if (mName === "unknown" || mName === "mixed") continue;
      const mKey = `${src}::${mName}`;
      let modelAgg = modelAggMap.get(mKey);
      if (!modelAgg) {
        modelAgg = {
          source: src,
          model: mName,
          active_sessions: 0,
          total_sessions: 0,
          tokens: emptyTokenTotals(),
          cost_usd: 0,
          recent_tokens: 0,
          samples: [],
        };
        modelAggMap.set(mKey, modelAgg);
      }
      modelAgg.total_sessions += 1;
      if (activity.status === "running") modelAgg.active_sessions += 1;
      addTokenTotals(modelAgg.tokens, mRow);
      modelAgg.cost_usd += finite(mRow.cost_usd);
      modelAgg.recent_tokens += windowRate.byModel.get(mName) || 0;
      modelAgg.samples.push(...samples.filter((sample) => sample.model === mName));
    }
  }

  const STATUS_PRIORITY = { running: 0, recent: 1, idle: 2 };
  const projects = [...projectsMap.values()]
    .map((project) => {
      project.samples.sort((a, b) => (a.timestamp_ms || 0) - (b.timestamp_ms || 0));
      const trimmedSamples = project.samples.filter((sample) => streamRate(sample) !== null).slice(-MAX_SAMPLES_PER_PROJECT).map((s) => ({
        timestamp_ms: s.timestamp_ms,
        model: s.model,
        source: s.source,
        output_tokens: s.output_tokens,
        duration_ms: Math.round(s.duration_ms),
        tokens_per_second: Number(streamRate(s).toFixed(1)),
      }));
      const rateSummary = summarizeRateSamples(project.samples, project.recent_tokens, activeWindowMs);
      const sortedSources = [...project.sourceTokens.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([source]) => source);
      const sortedModels = [...project.modelTokens.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([model]) => model);
      const totalInputPool =
        project.tokens.input_tokens +
        project.tokens.cached_input_tokens +
        project.tokens.cache_creation_input_tokens;
      const cacheHitRate =
        totalInputPool > 0
          ? Number(((project.tokens.cached_input_tokens / totalInputPool) * 100).toFixed(1))
          : null;
      const tokensPerMinute = Number((project.recent_tokens * 60_000 / activeWindowMs).toFixed(1));

      project.sessions.sort(
        (a, b) =>
          (STATUS_PRIORITY[a.status] ?? 2) - (STATUS_PRIORITY[b.status] ?? 2) ||
          String(b.last_active_at || "").localeCompare(String(a.last_active_at || "")),
      );

      return {
        project_id: project.project_id,
        project_key: project.project_key,
        project_ref: project.project_ref,
        status: project.status,
        active_session_count: project.active_session_count,
        session_count: project.session_count,
        sources: sortedSources,
        models: sortedModels,
        primary_source: sortedSources[0] || "unknown",
        primary_model: sortedModels[0] || "unknown",
        latest_title: project.latest_title || project.project_key,
        last_active_at: project.last_active_at,
        started_at: project.started_at,
        duration_ms: project.duration_ms,
        turns: project.turns,
        tool_calls: project.tool_calls,
        cost_usd: Number(project.cost_usd.toFixed(6)),
        cache_hit_rate: cacheHitRate,
        tokens: project.tokens,
        rate: {
          ...rateSummary,
          tokens_per_minute: tokensPerMinute,
        },
        samples: trimmedSamples,
        sessions: project.sessions.slice(0, 10),
      };
    })
    .sort(
      (a, b) =>
        (STATUS_PRIORITY[a.status] ?? 2) - (STATUS_PRIORITY[b.status] ?? 2) ||
        b.active_session_count - a.active_session_count ||
        String(b.last_active_at || "").localeCompare(String(a.last_active_at || "")),
    );

  const byProvider = [...providerAggMap.values()]
    .map((agg) => {
      const rate = summarizeRateSamples(agg.samples, agg.recent_tokens, activeWindowMs);
      const totalInputPool =
        agg.tokens.input_tokens +
        agg.tokens.cached_input_tokens +
        agg.tokens.cache_creation_input_tokens;
      return {
        source: agg.source,
        active_sessions: agg.active_sessions,
        total_sessions: agg.total_sessions,
        active_projects: agg.activeProjectsSet.size,
        total_projects: agg.projectsSet.size,
        last_active_at: agg.last_active_ms > 0 ? new Date(agg.last_active_ms).toISOString() : null,
        cost_usd: Number(agg.cost_usd.toFixed(6)),
        cache_hit_rate:
          totalInputPool > 0
            ? Number(((agg.tokens.cached_input_tokens / totalInputPool) * 100).toFixed(1))
            : null,
        tokens: agg.tokens,
        rate,
      };
    })
    .sort(
      (a, b) =>
        b.active_sessions - a.active_sessions ||
        (b.rate.output_tokens_per_second || 0) - (a.rate.output_tokens_per_second || 0) ||
        b.tokens.total_tokens - a.tokens.total_tokens,
    );

  const byModel = [...modelAggMap.values()]
    .map((agg) => {
      const rate = summarizeRateSamples(agg.samples, agg.recent_tokens, activeWindowMs);
      return {
        source: agg.source,
        model: agg.model,
        active_sessions: agg.active_sessions,
        total_sessions: agg.total_sessions,
        cost_usd: Number(agg.cost_usd.toFixed(6)),
        tokens: agg.tokens,
        rate,
      };
    })
    .filter((row) => row.rate.output_tokens_per_second !== null || row.rate.end_to_end_tokens_per_second !== null ||
      row.rate.total_tokens_per_second !== null || row.rate.first_response_sample_count > 0 || row.active_sessions > 0)
    .sort(
      (a, b) =>
        b.active_sessions - a.active_sessions ||
        (b.rate.output_tokens_per_second || 0) - (a.rate.output_tokens_per_second || 0) ||
        b.tokens.total_tokens - a.tokens.total_tokens,
    );

  const runningProjects = projects.filter((p) => p.status === "running");
  const summaryRows = [...projectsMap.values()];
  const windowTokens = summaryRows.reduce((sum, row) => sum + row.recent_tokens, 0);
  const globalRate = summarizeRateSamples(summaryRows.flatMap((row) => row.samples), windowTokens, activeWindowMs);

  return {
    generated_at: new Date(nowMs).toISOString(),
    active_window_minutes: activeWindowMinutes,
    summary: {
      running_project_count: runningProjects.length,
      running_session_count: runningProjects.reduce((sum, p) => sum + p.active_session_count, 0),
      total_project_count: projects.length,
      output_tokens_per_second: globalRate.output_tokens_per_second,
      latest_tokens_per_second: globalRate.latest_tokens_per_second,
      peak_tokens_per_second: globalRate.peak_tokens_per_second,
      total_tokens_per_second: globalRate.total_tokens_per_second,
      tokens_per_minute: Number((windowTokens * 60_000 / activeWindowMs).toFixed(1)),
      first_response_ms: globalRate.first_response_ms,
      sample_count: globalRate.first_response_sample_count,
    },
    projects,
    by_provider: byProvider,
    by_model: byModel,
  };
}

module.exports = {
  scanCodebuddySessionFile,
  scanAntigravitySessionFile,
  discoverCodebuddyJsonlFiles,
  discoverAntigravityTranscriptFiles,
  readCodebuddyActiveSessions,
  readAntigravitySummariesByDir,
  computeProjectTokenRates,
  summarizeRateSamples,
  classifySessionActivity,
};
