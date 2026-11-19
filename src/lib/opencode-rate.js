"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { coerceEpochMs, normalizeOpencodeModelFields, normalizeOpencodeTokens } = require("./rollout");

// The TUI uses the sum of all assistant steps since the turn started.
// See OpenCode v2.3.2 packages/util/src/session-turn.ts.
function collectOpencodeRates(messages, { timingSource = "opencode_db" } = {}) {
  const samples = [];
  const modern = messages.some((message) => message.type === "idle");
  let inTurn = false;
  let steps = [];
  let nativeRate = null;
  for (const message of messages) {
    if (message.type === "idle") {
      inTurn = false;
      steps = [];
      continue;
    }
    if (message.type === "user" || message.type === "synthetic") {
      if (!modern || !inTurn) steps = [];
      inTurn = true;
      continue;
    }
    if (message.type !== "assistant") continue;
    const created = coerceEpochMs(message.time?.created);
    const first = coerceEpochMs(message.time?.firstToken);
    const streamed = coerceEpochMs(message.time?.streamed);
    const completed = coerceEpochMs(message.time?.completed);
    const tokens = normalizeOpencodeTokens(message.tokens);
    const output = (tokens?.output_tokens || 0) + (tokens?.reasoning_output_tokens || 0);
    const firstResponse = created > 0 && first >= created && (!streamed || first <= streamed) ? first - created : null;
    const valid = !message.error && firstResponse !== null;
    const validStream = !message.error && created > 0 && streamed >= created && (!first || valid);
    const decodeMs = validStream && first ? streamed - first : 0;
    const requestMs = validStream ? streamed - created : 0;
    // Keep the ID of a completed usage record even if the local schema lacks
    // timing so the official API can supply it without recounting fork history.
    if ((!message.error && output > 0 && (requestMs > 0 || completed > 0)) || valid) {
      samples.push({
        request_id: message.id,
        model: normalizeOpencodeModelFields(message).modelId || "unknown",
        timestamp_ms: streamed || completed || first,
        output_tokens: output,
        duration_ms: decodeMs,
        end_to_end_ms: requestMs,
        first_response_ms: valid ? firstResponse : null,
      });
    }
    steps.push({
      id: message.id,
      output,
      duration: first ? decodeMs : requestMs,
      valid: validStream,
    });
    // Only the last visible assistant footer in a turn needs a native value.
    // A later, incomplete step cannot erase the last completed footer.
    if (!completed || ["tool-calls", "unknown"].includes(message.finish)) continue;
    if (!steps.every((step) => step.valid)) continue;
    const generated = steps.reduce((sum, step) => sum + step.output, 0);
    const duration = steps.reduce((sum, step) => sum + step.duration, 0);
    if (generated > 0 && duration > 0) {
      nativeRate = {
        tokens_per_second: generated * 1000 / duration,
        timestamp_ms: streamed,
        request_ids: steps.map((step) => step.id),
        source: timingSource,
      };
    }
  }
  return { samples, nativeRate };
}

async function readOpencodeService(home, env) {
  const state = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  try {
    const { url, password } = JSON.parse(await fs.readFile(path.join(state, "opencode", "service.json"), "utf8"));
    const origin = new URL(url);
    if (!["http:", "https:"].includes(origin.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
        origin.username || origin.password || typeof password !== "string" || !password) return null;
    return { origin: origin.origin, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  } catch {
    return null;
  }
}

async function readOpencodeApiRates(sessions, { home, env, cutoffMs, fetchImpl = fetch }) {
  if (!sessions.length) return new Map();
  const service = await readOpencodeService(home, env);
  if (!service) return new Map();

  const found = new Map();
  const signal = AbortSignal.timeout(1800);
  let nextSession = 0;
  await Promise.all(Array.from({ length: Math.min(6, sessions.length) }, async () => {
    while (!signal.aborted && nextSession < sessions.length) {
      const session = sessions[nextSession++];
      const localIds = new Set(session.rate_samples.map((sample) => sample.request_id));
      const messages = [];
      const url = new URL(`/api/session/${encodeURIComponent(session.session_id)}/message`, service.origin);
      url.searchParams.set("order", "desc");
      url.searchParams.set("limit", "50");
      try {
        for (let page = 0; page < 8; page++) {
          const response = await fetchImpl(url, {
            headers: { Authorization: service.authorization },
            redirect: "error",
            signal,
          });
          if (!response.ok) break;
          const body = await response.json();
          if (!Array.isArray(body?.data) || !body.data.length) break;
          // Retain metadata only, even when the API includes message content.
          messages.push(...body.data.map(({ id, type, time, tokens, model, error, finish }) => ({
            id, type, time, tokens, model, error: Boolean(error), finish,
          })));
          const cursor = body.cursor?.next;
          const outsideWindow = body.data.some((message) =>
            (message.type === "idle" || message.type === "user") && coerceEpochMs(message.time?.created) < cutoffMs,
          );
          if (typeof cursor !== "string" || !cursor || outsideWindow) break;
          url.searchParams.set("cursor", cursor);
        }
      } catch {
        // An unavailable service leaves the local timing samples usable.
      }
      const { samples, nativeRate } = collectOpencodeRates(messages.reverse(), { timingSource: "opencode_api" });
      const matching = new Map(samples.filter((sample) => localIds.has(sample.request_id)).map((sample) => [sample.request_id, sample]));
      if (!matching.size) continue;
      const native = nativeRate?.request_ids.every((id) => localIds.has(id)) ? nativeRate : null;
      found.set(session.session_hash, { samples: matching, nativeRate: native });
    }
  }));
  return found;
}

module.exports = { collectOpencodeRates, readOpencodeApiRates };
