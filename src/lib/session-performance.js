"use strict";

const { canonicalUsage } = require("./codex-token-usage");

const SUM_FIELDS = [
  "estimated_output_tokens", "estimated_duration_ms", "estimated_request_count",
  "first_response_total_ms", "first_response_sample_count",
];
const MIN_OUTPUT = 200;
const MIN_DURATION_MS = 1000;
const MIN_ADAPTED_OUTPUT = 5;
const MIN_ADAPTED_DURATION_MS = 100;
const MAX_DURATION_MS = 60 * 60 * 1000;
const SAME_FLUSH_MS = 100;

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizePerformance(value) {
  const out = Object.fromEntries(SUM_FIELDS.map((field) => [field, nonNegative(value?.[field])]));
  out.estimated_tokens_per_second = out.estimated_request_count > 0 && out.estimated_output_tokens > 0 && out.estimated_duration_ms > 0
    ? out.estimated_output_tokens / (out.estimated_duration_ms / 1000) : null;
  out.first_response_ms = out.first_response_sample_count > 0
    ? out.first_response_total_ms / out.first_response_sample_count : null;
  return out;
}

function mergePerformance(...values) {
  const out = normalizePerformance();
  for (const value of values) {
    for (const field of SUM_FIELDS) out[field] += nonNegative(value?.[field]);
  }
  return normalizePerformance(out);
}

function timestampMs(value) {
  if (typeof value !== "string") return null;
  const number = Date.parse(value);
  return Number.isFinite(number) ? number : null;
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

function accumulator({ minOutput = MIN_OUTPUT, minDurationMs = MIN_DURATION_MS } = {}) {
  let total = normalizePerformance();
  const byModel = new Map();
  const samples = [];
  function add(model, delta) {
    total = mergePerformance(total, delta);
    if (model) byModel.set(model, mergePerformance(byModel.get(model), delta));
  }
  function request(model, outputTokens, start, end, meta) {
    const duration = start !== null && end !== null ? end - start : 0;
    record(model, outputTokens, duration, meta);
  }
  function requestDuration(model, outputTokens, durationMs, meta) {
    record(model, outputTokens, durationMs, meta);
  }
  function record(model, outputTokens, duration, meta) {
    if (outputTokens < minOutput || duration < minDurationMs || duration > MAX_DURATION_MS) return;
    add(model, { estimated_output_tokens: outputTokens, estimated_duration_ms: duration, estimated_request_count: 1 });
    samples.push({
      model: model || "unknown",
      output_tokens: outputTokens,
      total_tokens: nonNegative(meta?.totalTokens) || outputTokens,
      duration_ms: duration,
      tokens_per_second: outputTokens / (duration / 1000),
      total_tokens_per_second: (nonNegative(meta?.totalTokens) || outputTokens) / (duration / 1000),
      timestamp_ms: Number.isFinite(meta?.timestampMs) ? meta.timestampMs : null,
      first_response_ms: Number.isFinite(meta?.firstResponseMs) ? meta.firstResponseMs : null,
    });
  }
  return { add, request, requestDuration, finish: () => ({ performance: total, byModel, samples }) };
}

function createClaudePerformanceCollector() {
  const nodes = new Map();
  const messages = new Map();
  const totals = accumulator();

  function consume(obj, key, countedUsage, model) {
    const timestamp = timestampMs(obj?.timestamp || obj?.message?.timestamp);
    if (typeof obj?.uuid === "string" && !nodes.has(obj.uuid)) {
      nodes.set(obj.uuid, {
        parent: obj.parentUuid, timestamp, type: obj.type,
        invalid: Boolean(obj.isApiErrorMessage || obj.isMeta),
      });
    }
    if (obj?.type !== "assistant" || !key) return;
    let timing = messages.get(key);
    if (!timing) {
      // Tokens come from scanClaudeSession's canonical, once-counted delta.
      // Later content blocks extend only the timing, never the numerator.
      timing = {
        parent: obj.parentUuid, startsAtFirstBlock: obj.apiBlockIndex == null || obj.apiBlockIndex === 0,
        end: null, complete: false, invalid: false, model,
        output: nonNegative(countedUsage?.output_tokens) + nonNegative(countedUsage?.reasoning_output_tokens),
      };
      messages.set(key, timing);
    }
    if (timestamp !== null) timing.end = timing.end === null ? timestamp : Math.max(timing.end, timestamp);
    timing.complete ||= ["end_turn", "tool_use", "max_tokens", "stop_sequence"].includes(obj.message?.stop_reason);
    timing.invalid ||= Boolean(obj.isApiErrorMessage || obj.message?.error);
  }

  function finish() {
    for (const timing of messages.values()) {
      if (!timing.complete || timing.invalid || !timing.startsAtFirstBlock) continue;
      let parent = timing.parent;
      for (let hop = 0; hop < 32 && parent; hop += 1) {
        const node = nodes.get(parent);
        if (!node) break;
        if (node.type === "attachment") { parent = node.parent; continue; }
        // A user row includes tool results. Their completion timestamp keeps
        // time spent executing the tool outside the next inference window.
        if (node.type === "user" && !node.invalid) totals.request(timing.model, timing.output, node.timestamp, timing.end);
        break;
      }
    }
    return totals.finish();
  }
  return { consume, finish };
}

function createCodexPerformanceCollector() {
  const totals = accumulator();
  let boundary = null;
  let lastTokenCount = null;
  let start = null;
  let lastOutput = null;
  let toolAfterOutput = null;
  let usageRecord = null;
  let invalid = false;
  let turnKey = null;
  let turnModels = new Set();
  const seenFirstResponses = new Set();

  function reset() {
    start = null;
    lastOutput = null;
    toolAfterOutput = null;
    usageRecord = null;
    invalid = false;
  }
  function noteBoundary(ms) {
    if (ms !== null) boundary = boundary === null ? ms : Math.max(boundary, ms);
  }
  function consume(obj, model) {
    const ms = timestampMs(obj?.timestamp);
    const payload = obj?.payload || {};
    if (obj?.type === "compacted") {
      reset();
      noteBoundary(ms);
      return;
    }
    if (obj?.type === "event_msg" && ["task_started", "turn_aborted"].includes(payload.type)) {
      reset();
      noteBoundary(ms);
      turnModels = new Set();
      turnKey = payload.turn_id || null;
      if (payload.type === "turn_aborted") invalid = true;
    }
    if (obj?.type === "turn_context") {
      const nextKey = payload.turn_id || null;
      if (turnKey && nextKey && turnKey !== nextKey) { reset(); turnModels = new Set(); }
      turnKey = nextKey || turnKey;
      noteBoundary(ms);
    }
    const responseType = String(payload.type || "");
    const isModelOutput = obj?.type === "response_item" && (responseType === "reasoning"
      || responseType === "agent_message" || responseType.endsWith("_call")
      || (responseType === "message" && payload.role === "assistant"));
    if (model && (obj?.type === "turn_context" || isModelOutput
      || payload.type === "model_rerouted")) turnModels.add(model);
    if (obj?.type === "event_msg" && ["error", "api_error"].includes(payload.type)) invalid = true;
    if (obj?.type === "event_msg" && payload.type === "task_complete") {
      const raw = payload.time_to_first_token_ms;
      const key = payload.turn_id || turnKey || obj.timestamp;
      if (!invalid && typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && !seenFirstResponses.has(key)) {
        seenFirstResponses.add(key);
        totals.add(turnModels.size === 1 ? [...turnModels][0] : null, { first_response_total_ms: raw, first_response_sample_count: 1 });
      }
      reset();
      return;
    }
    if (obj?.type === "token_usage_record") {
      usageRecord = { end: ms, usage: canonicalUsage(payload.usage) };
      return;
    }
    if (obj?.type !== "response_item") return;
    const type = String(payload.type || "");
    if (type.endsWith("_output")) {
      noteBoundary(ms);
      if (lastOutput !== null) toolAfterOutput = ms;
    } else if ((type === "message" && payload.role !== "assistant") || type === "user_message") {
      noteBoundary(ms);
    } else if (type === "reasoning" || type === "agent_message" || type.endsWith("_call") || (type === "message" && payload.role === "assistant")) {
      // Old rollouts flush an output item just after its token_count.
      if (ms === null || (start === null && lastTokenCount !== null && ms >= lastTokenCount && ms - lastTokenCount <= SAME_FLUSH_MS)) return;
      if (start === null) start = boundary;
      lastOutput = ms;
      toolAfterOutput = null;
    }
  }
  function consumeUsage({ timestamp, delta, rawUsage, model }) {
    // A repeated cumulative snapshot can be written while the next response
    // is still generating. It is not a completion boundary for that response.
    if (!delta || delta.total_tokens <= 0) return;
    const ms = timestampMs(timestamp);
    const raw = canonicalUsage(rawUsage);
    const matches = raw && usageRecord?.usage && ["input_tokens", "cached_input_tokens", "output_tokens"]
      .every((field) => raw[field] === usageRecord.usage[field]);
    const waitedForTools = toolAfterOutput !== null && ms !== null && ms >= toolAfterOutput;
    // Once a tool result follows the final output marker, the token_count's
    // timestamp contains execution time. The output marker is the available
    // response boundary even if the count was flushed much later.
    const end = matches ? usageRecord.end : waitedForTools ? lastOutput : ms;
    // Missing output markers cannot distinguish response timing from a
    // snapshot or inherited context, so even a positive token delta is skipped.
    if (!invalid && lastOutput !== null) totals.request(model, nonNegative(delta.output_tokens), start, end);
    noteBoundary(ms);
    lastTokenCount = ms;
    reset();
  }
  return { consume, consumeUsage, finish: totals.finish };
}

// ZCode's CLI DB stores per-request wall-clock counters directly in its
// model_usage table (duration_ms, time_to_first_token_ms) instead of an event
// stream, so this collector is a thin adapter: each completed request becomes
// one duration-bounded sample, never a token total (those come from the
// shared usage reader so the browser cannot drift from the usage card).
function createZcodePerformanceCollector() {
  const totals = accumulator();
  function consumeUsage({ model, outputTokens, durationMs, timeToFirstTokenMs } = {}) {
    totals.requestDuration(model, nonNegative(outputTokens), nonNegative(durationMs));
    if (typeof timeToFirstTokenMs === "number" && Number.isFinite(timeToFirstTokenMs) && timeToFirstTokenMs >= 0) {
      totals.add(null, { first_response_total_ms: timeToFirstTokenMs, first_response_sample_count: 1 });
    }
  }
  return { consumeUsage, finish: totals.finish };
}

function createDshPerformanceCollector() {
  const totals = accumulator();
  function consumeUsage({ model, outputTokens, start, end, firstToken } = {}) {
    // Step boundaries surround model work, before tool execution. Retry and
    // interrupted steps are filtered by the transcript reader.
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > MAX_DURATION_MS) return;
    totals.request(model, outputTokens, start, end);
    if (Number.isFinite(firstToken) && firstToken >= start && firstToken <= end) {
      totals.add(model, { first_response_total_ms: firstToken - start, first_response_sample_count: 1 });
    }
  }
  return { consumeUsage, finish: totals.finish };
}

function createCodebuddyPerformanceCollector() {
  const nodes = new Map();
  const messages = new Map();
  const totals = accumulator({ minOutput: MIN_ADAPTED_OUTPUT, minDurationMs: MIN_ADAPTED_DURATION_MS });
  let lastBoundaryMs = null;

  function consume(obj, timingKey, countedUsage, model) {
    const ts = flexibleTimestampMs(obj?.timestamp ?? obj?.message?.timestamp);
    const nodeId = typeof obj?.id === "string" && obj.id
      ? obj.id
      : typeof obj?.uuid === "string" && obj.uuid
        ? obj.uuid
        : null;
    const parentId = typeof obj?.parentId === "string" && obj.parentId
      ? obj.parentId
      : typeof obj?.parentUuid === "string" && obj.parentUuid
        ? obj.parentUuid
        : null;
    const isUser = obj?.type === "user" || (obj?.type === "message" && obj?.role === "user") || obj?.role === "user";
    const isToolResult = obj?.type === "function_call_result" || obj?.type === "tool_result";
    const isBoundary = isUser || isToolResult;
    const isMetaBoundary = obj?.type === "session-meta" && lastBoundaryMs === null;
    const invalidNode = Boolean(obj?.isApiErrorMessage || obj?.message?.error || obj?.error);

    if (nodeId && !nodes.has(nodeId)) {
      nodes.set(nodeId, {
        parent: parentId,
        timestamp: ts,
        type: obj?.type,
        role: obj?.role,
        isBoundary,
        invalid: invalidNode,
      });
    }
    if ((isBoundary || isMetaBoundary) && !invalidNode && ts !== null) {
      lastBoundaryMs = lastBoundaryMs === null ? ts : Math.max(lastBoundaryMs, ts);
    }

    const isModelRecord =
      obj?.type === "reasoning" ||
      obj?.type === "function_call" ||
      obj?.type === "assistant" ||
      (obj?.type === "message" && obj?.role === "assistant") ||
      Boolean(obj?.providerData?.rawUsage);
    if (!isModelRecord || isBoundary) return;

    const key =
      timingKey ||
      (typeof obj?.providerData?.messageId === "string" && obj.providerData.messageId) ||
      nodeId ||
      (ts !== null ? `codebuddy:${ts}` : null);
    if (!key) return;

    let timing = messages.get(key);
    if (!timing) {
      timing = {
        parent: parentId,
        fallbackStart: lastBoundaryMs,
        firstTokenMs: obj?.type === "reasoning" && ts !== null ? ts : null,
        end: ts,
        model: model || null,
        output: 0,
        total: 0,
        hasUsage: false,
        invalid: false,
      };
      messages.set(key, timing);
    }
    if (!timing.parent && parentId) timing.parent = parentId;
    if (timing.fallbackStart === null && lastBoundaryMs !== null) timing.fallbackStart = lastBoundaryMs;
    if (ts !== null) {
      timing.end = timing.end === null ? ts : Math.max(timing.end, ts);
      if (obj?.type === "reasoning" && timing.firstTokenMs === null) timing.firstTokenMs = ts;
    }
    if (model && !timing.model) timing.model = model;
    if (countedUsage && !timing.hasUsage) {
      const output = nonNegative(countedUsage.output_tokens) + nonNegative(countedUsage.reasoning_output_tokens);
      const total = nonNegative(countedUsage.total_tokens) || output;
      if (output > 0 || total > 0) {
        timing.output = output;
        timing.total = total;
        timing.hasUsage = true;
      }
    }
    timing.invalid ||= invalidNode;
  }

  function consumeLog({ model, outputTokens, totalTokens, startMs, endMs, durationMs } = {}) {
    const out = nonNegative(outputTokens);
    const tot = nonNegative(totalTokens) || out;
    if (Number.isFinite(durationMs) && durationMs > 0) {
      totals.requestDuration(model, out, durationMs, { timestampMs: endMs ?? null, totalTokens: tot });
      return;
    }
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      totals.request(model, out, startMs, endMs, { timestampMs: endMs, totalTokens: tot });
    }
  }

  function finish() {
    for (const timing of messages.values()) {
      if (!timing.hasUsage || timing.invalid || timing.output <= 0) continue;
      let start = null;
      let parent = timing.parent;
      for (let hop = 0; hop < 32 && parent; hop += 1) {
        const node = nodes.get(parent);
        if (!node) break;
        if (node.isBoundary && !node.invalid && node.timestamp !== null) {
          start = node.timestamp;
          break;
        }
        parent = node.parent;
      }
      if (start === null) start = timing.fallbackStart;
      if (start !== null && timing.end !== null && timing.end > start) {
        const firstTokenDelta =
          timing.firstTokenMs !== null && timing.firstTokenMs > start && timing.firstTokenMs <= timing.end
            ? timing.firstTokenMs - start
            : null;
        totals.request(timing.model, timing.output, start, timing.end, {
          timestampMs: timing.end,
          totalTokens: timing.total,
          firstResponseMs: firstTokenDelta,
        });
        if (firstTokenDelta !== null) {
          totals.add(timing.model, {
            first_response_total_ms: firstTokenDelta,
            first_response_sample_count: 1,
          });
        }
      }
    }
    return totals.finish();
  }

  return { consume, consumeLog, finish };
}

function parseAntigravityCompletedAtMs(content) {
  if (typeof content !== "string" || !content) return null;
  const match = content.match(/Completed At:\s*([^\r\n]+)/);
  if (!match) return null;
  return flexibleTimestampMs(match[1]);
}

function createAntigravityPerformanceCollector() {
  const totals = accumulator({ minOutput: MIN_ADAPTED_OUTPUT, minDurationMs: MIN_ADAPTED_DURATION_MS });
  let lastBoundaryMs = null;
  let pendingPlanner = null;

  function flushPending(nextObj, nextTs) {
    if (!pendingPlanner) return;
    const pending = pendingPlanner;
    pendingPlanner = null;
    const nextType = String(nextObj?.type || "");
    const plannerMs = pending.plannerMs;
    const startBoundaryMs = pending.startBoundaryMs;

    if (
      nextObj &&
      nextType !== "USER_INPUT" &&
      nextTs !== null &&
      plannerMs !== null &&
      nextTs > plannerMs &&
      nextTs - plannerMs >= MIN_ADAPTED_DURATION_MS &&
      nextTs - plannerMs <= MAX_DURATION_MS &&
      (startBoundaryMs === null || plannerMs - startBoundaryMs < 2000)
    ) {
      totals.request(pending.model, pending.output, plannerMs, nextTs, {
        timestampMs: nextTs,
        totalTokens: pending.total,
      });
      return;
    }

    if (startBoundaryMs !== null && plannerMs !== null && plannerMs > startBoundaryMs) {
      totals.request(pending.model, pending.output, startBoundaryMs, plannerMs, {
        timestampMs: plannerMs,
        totalTokens: pending.total,
      });
    }
  }

  function consume(obj, { model, outputTokens, reasoningTokens, totalTokens, dbTurn } = {}) {
    const ts = flexibleTimestampMs(obj?.created_at ?? obj?.timestamp);
    if (pendingPlanner) {
      flushPending(obj, ts);
    }

    const type = String(obj?.type || "");
    if (type !== "PLANNER_RESPONSE") {
      const completedMs = parseAntigravityCompletedAtMs(obj?.content);
      const boundaryMs = completedMs !== null ? completedMs : ts;
      if (boundaryMs !== null) {
        lastBoundaryMs = lastBoundaryMs === null ? boundaryMs : Math.max(lastBoundaryMs, boundaryMs);
      }
      return;
    }

    const status = String(obj?.status || "").toUpperCase();
    const invalid = status === "ERROR" || status === "CANCELED" || status === "CANCELLED" || Boolean(obj?.error);
    const out = nonNegative(outputTokens) + nonNegative(reasoningTokens);
    const tot = nonNegative(totalTokens) || out;

    if (!invalid && out > 0) {
      const dbDurationMs = nonNegative(dbTurn?.durationMs);
      const dbFirstTokenMs = Number.isFinite(dbTurn?.timeToFirstTokenMs) && dbTurn.timeToFirstTokenMs >= 0
        ? dbTurn.timeToFirstTokenMs
        : null;
      if (dbDurationMs >= MIN_ADAPTED_DURATION_MS && dbDurationMs <= MAX_DURATION_MS) {
        totals.requestDuration(model, out, dbDurationMs, {
          timestampMs: ts !== null ? ts + Math.round(dbDurationMs) : null,
          totalTokens: tot,
          firstResponseMs: dbFirstTokenMs,
        });
        if (dbFirstTokenMs !== null && dbFirstTokenMs <= dbDurationMs) {
          totals.add(model, {
            first_response_total_ms: dbFirstTokenMs,
            first_response_sample_count: 1,
          });
        }
      } else {
        pendingPlanner = {
          model,
          output: out,
          total: tot,
          plannerMs: ts,
          startBoundaryMs: lastBoundaryMs,
        };
      }
    }

    if (ts !== null) {
      lastBoundaryMs = lastBoundaryMs === null ? ts : Math.max(lastBoundaryMs, ts);
    }
  }

  function consumeUsage({ model, outputTokens, reasoningTokens, totalTokens, durationMs, timeToFirstTokenMs, start, end, timestampMs: sampleTs } = {}) {
    const out = nonNegative(outputTokens) + nonNegative(reasoningTokens);
    const tot = nonNegative(totalTokens) || out;
    const firstMs = Number.isFinite(timeToFirstTokenMs) && timeToFirstTokenMs >= 0 ? timeToFirstTokenMs : null;
    if (Number.isFinite(durationMs) && durationMs > 0) {
      totals.requestDuration(model, out, durationMs, {
        timestampMs: sampleTs ?? null,
        totalTokens: tot,
        firstResponseMs: firstMs,
      });
      if (firstMs !== null && firstMs <= durationMs) {
        totals.add(model, { first_response_total_ms: firstMs, first_response_sample_count: 1 });
      }
      return;
    }
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      totals.request(model, out, start, end, {
        timestampMs: sampleTs ?? end,
        totalTokens: tot,
        firstResponseMs: firstMs,
      });
      if (firstMs !== null && firstMs <= end - start) {
        totals.add(model, { first_response_total_ms: firstMs, first_response_sample_count: 1 });
      }
    }
  }

  function finish() {
    if (pendingPlanner) {
      flushPending(null, null);
    }
    return totals.finish();
  }

  return { consume, consumeUsage, finish };
}

module.exports = {
  normalizePerformance,
  mergePerformance,
  createClaudePerformanceCollector,
  createCodexPerformanceCollector,
  createZcodePerformanceCollector,
  createDshPerformanceCollector,
  createCodebuddyPerformanceCollector,
  createAntigravityPerformanceCollector,
};
