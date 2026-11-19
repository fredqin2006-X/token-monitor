"use strict";

const http = require("node:http");
const path = require("node:path");
const { readJson, writeFileAtomic } = require("./fs");

const CONFIG_NAME = "claude-otel-receiver.json";
const SAMPLE_NAME = "claude-otel-requests.json";
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_REQUEST_MS = 60 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_SAMPLES = 10_000;
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,159}$/i;
const TRACE_ID = /^[0-9a-f]{32}$/i;
const SPAN_ID = /^[0-9a-f]{16}$/i;

function array(value) {
  return Array.isArray(value) ? value : [];
}

function attributeValue(value) {
  if (value?.intValue != null) return Number(value.intValue);
  return value?.doubleValue ?? value?.boolValue ?? value?.stringValue;
}

function epochMs(nano) {
  return typeof nano === "string" && /^\d{1,20}$/.test(nano) ? Number(nano) / 1e6 : Number.NaN;
}

function extractClaudeRequest(span, nowMs) {
  if (span?.name !== "claude_code.llm_request" || Number(span.status?.code) === 2) return null;
  const attributes = new Map(array(span.attributes).map((attr) => [attr?.key, attributeValue(attr?.value)]));
  const success = attributes.get("success");
  if ((success !== true && success !== "true") || attributes.get("stop_reason") === "refusal") return null;
  const sessionId = attributes.get("session.id");
  const model = attributes.get("model");
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) ||
      typeof model !== "string" || !MODEL_ID.test(model) ||
      typeof span.traceId !== "string" || !TRACE_ID.test(span.traceId) ||
      typeof span.spanId !== "string" || !SPAN_ID.test(span.spanId)) return null;

  const start = epochMs(span.startTimeUnixNano);
  const end = epochMs(span.endTimeUnixNano);
  const duration = attributes.get("duration_ms");
  if (!(end >= nowMs - RETENTION_MS && end <= nowMs + 60_000 && start > 0 && end > start &&
        Number.isFinite(duration) && duration > 0 && duration <= MAX_REQUEST_MS)) return null;
  const output = attributes.get("output_tokens");
  if (!Number.isSafeInteger(output) || output < 0) return null;

  const ttft = attributes.get("ttft_ms");
  const firstContent = attributes.get("first_content_ms");
  return {
    id: `${span.traceId}:${span.spanId}`,
    session_id: sessionId.toLowerCase(),
    model,
    timestamp_ms: Math.round(end),
    output_tokens: output,
    // The official span ends at request completion. first_content_ms exists
    // only for a streamed response, and excludes queueing and initial retries.
    duration_ms: Number.isFinite(firstContent) && firstContent >= 0 && firstContent < duration
      ? duration - firstContent : 0,
    end_to_end_ms: duration,
    first_response_ms: Number.isFinite(ttft) && ttft >= 0 && ttft <= duration ? ttft : null,
  };
}

function parseClaudeTraces(body, nowMs = Date.now()) {
  const rows = [];
  for (const resource of array(body?.resourceSpans)) {
    for (const scope of array(resource?.scopeSpans)) {
      for (const span of array(scope?.spans)) {
        const request = extractClaudeRequest(span, nowMs);
        if (request) rows.push(request);
      }
    }
  }
  return rows;
}

async function readClaudeTimingSamples(trackerDir, cutoffMs, nowMs) {
  const stored = await readJson(path.join(trackerDir, SAMPLE_NAME));
  const bySession = new Map();
  for (const row of array(stored)) {
    if (!row) continue;
    const { session_id: id, model, timestamp_ms, output_tokens, duration_ms, end_to_end_ms, first_response_ms } = row;
    if (typeof id !== "string" || !SESSION_ID.test(id) ||
        !(timestamp_ms >= cutoffMs && timestamp_ms <= nowMs)) continue;
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push({ model, timestamp_ms, output_tokens, duration_ms, end_to_end_ms, first_response_ms });
  }
  return bySession;
}

async function startClaudeTelemetryReceiver(trackerDir) {
  const config = await readJson(path.join(trackerDir, CONFIG_NAME));
  const port = config?.port;
  if (port == null) return null;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Invalid Claude OTLP port");

  const samplePath = path.join(trackerDir, SAMPLE_NAME);
  let pendingWrite = Promise.resolve();
  function save(rows, nowMs) {
    if (!rows.length) return pendingWrite;
    const nextWrite = pendingWrite.then(async () => {
      const entries = new Map(array(await readJson(samplePath))
        .filter((item) => item?.timestamp_ms >= nowMs - RETENTION_MS)
        .map((item) => [item.id, item]));
      for (const row of rows) entries.set(row.id, row);
      const latest = [...entries.values()].sort((a, b) => a.timestamp_ms - b.timestamp_ms).slice(-MAX_SAMPLES);
      await writeFileAtomic(samplePath, JSON.stringify(latest) + "\n", { mode: 0o600 });
    });
    pendingWrite = nextWrite.catch(() => {});
    return nextWrite;
  }

  const receiver = http.createServer({ requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/traces") return res.writeHead(404).end();
    if (req.headers.host !== `127.0.0.1:${receiver.address().port}` || req.headers.origin) return res.writeHead(403).end();
    if (req.headers["content-type"]?.split(";")[0] !== "application/json" ||
        (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")) {
      return res.writeHead(415).end();
    }

    const chunks = [];
    let bytes = 0;
    let payload;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_PAYLOAD_BYTES) return res.writeHead(413, { Connection: "close" }).end();
        chunks.push(chunk);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(payload?.resourceSpans)) return res.writeHead(400).end();
    } catch {
      return res.writeHead(400).end();
    }
    try {
      const nowMs = Date.now();
      await save(parseClaudeTraces(payload, nowMs), nowMs);
      return res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    } catch {
      return res.writeHead(503).end();
    }
  });
  await new Promise((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(port, "127.0.0.1", () => {
      receiver.off("error", reject);
      resolve();
    });
  });
  return receiver;
}

module.exports = { readClaudeTimingSamples, startClaudeTelemetryReceiver };
