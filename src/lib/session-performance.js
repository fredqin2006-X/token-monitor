"use strict";

const { canonicalUsage } = require("./codex-token-usage");

const SUM_FIELDS = [
  "estimated_output_tokens", "estimated_duration_ms", "estimated_request_count", "sampled_total_tokens",
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
    add(model, {
      estimated_output_tokens: outputTokens,
      estimated_duration_ms: duration,
      estimated_request_count: 1,
      sampled_total_tokens: nonNegative(meta?.totalTokens),
    });
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

function createStreamingPerformanceCollector() {
  const totals = accumulator({ minOutput: MIN_ADAPTED_OUTPUT, minDurationMs: MIN_ADAPTED_DURATION_MS });
  function consumeUsage({ model, outputTokens, reasoningTokens, totalTokens, durationMs, firstResponseMs, timestampMs }) {
    const firstMs = Number.isFinite(firstResponseMs) && firstResponseMs >= 0 && firstResponseMs <= MAX_DURATION_MS
      ? firstResponseMs : null;
    if (firstMs !== null) {
      totals.add(model, { first_response_total_ms: firstMs, first_response_sample_count: 1 });
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    const output = nonNegative(outputTokens) + nonNegative(reasoningTokens);
    totals.requestDuration(model, output, durationMs, {
      timestampMs,
      totalTokens: nonNegative(totalTokens) || output,
      firstResponseMs: firstMs,
    });
  }
  return { consumeUsage, finish: totals.finish };
}

function createAntigravityPerformanceCollector() {
  const collector = createStreamingPerformanceCollector();
  function consume(obj, { model, outputTokens, reasoningTokens, totalTokens, dbTurn } = {}) {
    if (obj?.type !== "PLANNER_RESPONSE") return;
    const status = String(obj.status || "").toUpperCase();
    if (status === "ERROR" || status === "CANCELED" || status === "CANCELLED" || obj.error || !dbTurn) return;
    const startMs = flexibleTimestampMs(obj.created_at ?? obj.timestamp);
    const durationMs = dbTurn.streamingDurationMs;
    const firstResponseMs = dbTurn.timeToFirstTokenMs;
    const timestampMs = startMs === null ? null : startMs + nonNegative(firstResponseMs) + nonNegative(durationMs);
    collector.consumeUsage({ model, outputTokens, reasoningTokens, totalTokens, durationMs, firstResponseMs, timestampMs });
  }
  return { consume, finish: collector.finish };
}

module.exports = {
  normalizePerformance,
  mergePerformance,
  createClaudePerformanceCollector,
  createCodexPerformanceCollector,
  createZcodePerformanceCollector,
  createDshPerformanceCollector,
  createStreamingPerformanceCollector,
  createAntigravityPerformanceCollector,
};
