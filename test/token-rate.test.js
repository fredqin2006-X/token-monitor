"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startClaudeTelemetryReceiver } = require("../src/lib/claude-otel");
const {
  createAntigravityPerformanceCollector,
} = require("../src/lib/session-performance");
const {
  scanCodebuddySessionFile,
  scanAntigravitySessionFile,
  computeProjectTokenRates,
  classifySessionActivity,
  summarizeRateSamples,
} = require("../src/lib/token-rate");
const {
  scanCodebuddySession,
  scanAntigravitySession,
} = require("../src/lib/session-analytics");

test("Antigravity performance collector calculates rate from SQLite turn and transcript steps", () => {
  const collector = createAntigravityPerformanceCollector();
  collector.consume({
    step_index: 0,
    type: "USER_INPUT",
    created_at: "2026-11-18T10:00:00.000Z",
  });
  collector.consume(
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-18T10:00:06.000Z",
    },
    {
      model: "claude-opus-4-6-thinking",
      outputTokens: 300,
      reasoningTokens: 60,
      totalTokens: 12360,
      dbTurn: {
        durationMs: 4500,
        streamingDurationMs: 3600,
        timeToFirstTokenMs: 900,
      },
    },
  );

  const finished = collector.finish();
  assert.equal(finished.performance.estimated_request_count, 1);
  assert.equal(finished.performance.estimated_output_tokens, 360);
  assert.equal(finished.performance.estimated_duration_ms, 3600);
  assert.equal(finished.performance.estimated_tokens_per_second, 100);
  assert.equal(finished.performance.first_response_ms, 900);
});

test("Antigravity does not infer output time from request or transcript boundaries", () => {
  const collector = createAntigravityPerformanceCollector();
  const output = { type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-18T10:00:06.000Z" };
  collector.consume({ type: "USER_INPUT", created_at: "2026-11-18T10:00:00.000Z" });
  collector.consume(output, { outputTokens: 300 });
  collector.consume({ type: "RUN_COMMAND", created_at: "2026-11-18T10:00:30.000Z" });
  collector.consume(output, { outputTokens: 300, dbTurn: { durationMs: 900, timeToFirstTokenMs: 900 } });
  collector.consume({ ...output, status: "CANCELLED" }, { outputTokens: 300, dbTurn: { streamingDurationMs: 5000, timeToFirstTokenMs: 300 } });
  const { performance, samples } = collector.finish();
  assert.deepEqual(samples.map((sample) => sample.timing), ["first_token"]);
  assert.equal(performance.estimated_tokens_per_second, null);
  assert.equal(performance.first_response_ms, 900);
});

test("scanCodebuddySession and scanAntigravitySession compute rates and aggregate into computeProjectTokenRates", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-rate-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const nowMs = 1_763_430_000_000;
  const cbProjectDir = path.join(home, ".codebuddy", "projects", "e-my-cb-project");
  const cbSessionsDir = path.join(home, ".codebuddy", "sessions");
  fs.mkdirSync(cbProjectDir, { recursive: true });
  fs.mkdirSync(cbSessionsDir, { recursive: true });

  const cbSessionId = "01a1ec69-13f0-78b1-86d0-db232459021b";
  const cbJsonl = path.join(cbProjectDir, `${cbSessionId}.jsonl`);
  const localDate = new Date(nowMs);
  const logDir = path.join(home, ".codebuddy", "logs", [
    localDate.getFullYear(), localDate.getMonth() + 1, localDate.getDate(),
  ].map((part) => String(part).padStart(2, "0")).join("-"));
  fs.mkdirSync(logDir, { recursive: true });
  const prefix = "[2026/11/18 10:00:00.000] [Info] [pid=123] [ModelProvider]";
  fs.writeFileSync(path.join(logDir, "project.log"), [
    `${prefix} [ModelProvider] First meaningful token received: agent=cli, requestId=cb-msg-1, ttft=3000ms, rawChunks=1`,
    `${prefix} [ModelProvider] finish_reason="tool_calls" received, starting grace period: agent=cli, requestId=cb-msg-1, chunks=32, elapsed=5000ms`,
    `${prefix} [ModelProvider] Stream completed: agent=cli, requestId=cb-msg-1, chunks=33, elapsed=7500ms`,
    `${prefix} [ModelProvider] First meaningful token received: agent=cli, requestId=cb-msg-2, ttft=3000ms, rawChunks=1`,
    `${prefix} [ModelProvider] Stream completed: agent=cli, requestId=cb-msg-2, chunks=33, elapsed=7500ms`,
  ].join("\n") + "\n");
  fs.writeFileSync(
    path.join(cbSessionsDir, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: cbSessionId,
      cwd: "/workspace/my-cb-project",
      lastHeartbeat: nowMs - 2000,
      updatedAt: nowMs - 2000,
    }),
  );
  fs.writeFileSync(
    cbJsonl,
    [
      JSON.stringify({
        type: "session-meta",
        sessionId: cbSessionId,
        cwd: "/workspace/my-cb-project",
        timestamp: nowMs - 10_000,
      }),
      JSON.stringify({
        id: "u1",
        parentId: null,
        type: "message",
        role: "user",
        sessionId: cbSessionId,
        cwd: "/workspace/my-cb-project",
        timestamp: nowMs - 8_000,
      }),
      JSON.stringify({
        id: "a1",
        parentId: "u1",
        type: "message",
        role: "assistant",
        sessionId: cbSessionId,
        cwd: "/workspace/my-cb-project",
        timestamp: nowMs - 3_000,
        providerData: {
          messageId: "cb-msg-1",
          model: "glm-5.1",
          rawUsage: {
            prompt_tokens: 2000,
            prompt_tokens_details: { cached_tokens: 1500 },
            completion_tokens: 250,
            total_tokens: 2250,
          },
        },
      }),
      JSON.stringify({
        type: "function_call_result",
        id: "tool-result",
        parentId: "a1",
        sessionId: cbSessionId,
        timestamp: nowMs + 15_000,
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        id: "a2",
        parentId: "tool-result",
        sessionId: cbSessionId,
        timestamp: nowMs + 20_000,
        providerData: {
          messageId: "cb-msg-2",
          model: "glm-5.1",
          rawUsage: { prompt_tokens: 1200, completion_tokens: 200, total_tokens: 1400 },
        },
      }),
    ].join("\n") + "\n",
  );

  const agConvId = "8a1125a2-8d1b-48ca-88ad-5d8d7a8e02a8";
  const agLogsDir = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "brain",
    agConvId,
    ".system_generated",
    "logs",
  );
  fs.mkdirSync(agLogsDir, { recursive: true });
  const agTranscript = path.join(agLogsDir, "transcript.jsonl");
  fs.writeFileSync(
    agTranscript,
    [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        status: "DONE",
        created_at: new Date(nowMs - 12_000).toISOString(),
        content: "Active Workspaces:\n- /workspace/my-ag-project",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: new Date(nowMs - 4_000).toISOString(),
        model: "claude-opus-4-6-thinking",
        input_tokens: 1000,
        cache_read_tokens: 5000,
        output_tokens: 400,
        thinking: "reasoning",
        tool_calls: [],
      }),
    ].join("\n") + "\n",
  );

  const cbScanned = await scanCodebuddySession(cbJsonl);
  assert.equal(cbScanned.source, "codebuddy");
  assert.equal(cbScanned.performance.estimated_tokens_per_second, 125);
  assert.equal(cbScanned.performance.estimated_duration_ms, 2000);
  assert.equal(cbScanned.performance.first_response_ms, 3000);
  assert.equal(cbScanned.performance.estimated_request_count, 1);

  const agScanned = await scanAntigravitySession(agTranscript);
  assert.equal(agScanned.source, "antigravity");
  assert.equal(agScanned.performance.estimated_tokens_per_second, null);

  const report = await computeProjectTokenRates({
    home,
    env: { HOME: home },
    now: nowMs + 30_000,
    activeWindowMinutes: 15,
    recentWindowMinutes: 1440,
  });

  assert.equal(report.summary.running_project_count, 2);
  assert.equal(report.projects.length, 2);
  const sources = report.by_provider.map((p) => p.source).sort();
  assert.deepEqual(sources, ["antigravity", "codebuddy"]);
  const codebuddy = report.by_provider.find((p) => p.source === "codebuddy");
  assert.equal(codebuddy.tokens.total_tokens, 3650);
  assert.equal(codebuddy.rate.total_tokens_per_second, 4.1);
  assert.equal(report.summary.output_tokens_per_second, 124.5);
  assert.equal(report.summary.total_tokens_per_second, 11.2);
  assert.equal(report.summary.sample_count, 1);
  assert.equal(report.by_model.find((row) => row.source === "codebuddy").rate.output_tokens_per_second, 124.5);
});

test("window aggregation keeps estimated requests out of decode rate and uses wall time for throughput", () => {
  const rate = summarizeRateSamples([
    { timestamp_ms: 100, duration_ms: 1_000, output_tokens: 101, first_response_ms: 900 },
    { timestamp_ms: 200, duration_ms: 3_000, output_tokens: 151, first_response_ms: 1_100 },
    { timestamp_ms: 300, duration_ms: 5_000, output_tokens: 200, timing: "estimated" },
  ], 60_000, 300_000);
  assert.equal(rate.output_tokens_per_second, 62.5);
  assert.equal(rate.peak_tokens_per_second, 100);
  assert.equal(rate.total_tokens_per_second, 200);
  assert.equal(rate.end_to_end_tokens_per_second, 40);
  assert.equal(rate.end_to_end_estimated, true);
  assert.equal(rate.first_response_ms, 1_000);
  assert.equal(rate.first_response_sample_count, 2);
});

test("Claude Code OTLP request spans override transcript estimates and discard duplicates, failures and content", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-claude-otel-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "claude-otel-receiver.json"), '{"port":0}');
  const receiver = await startClaudeTelemetryReceiver(trackerDir);
  t.after(() => new Promise((resolve) => {
    receiver.closeAllConnections();
    receiver.close(resolve);
  }));

  const sessionId = "00000000-0000-4000-8000-000000000001";
  const model = "claude-sonnet-5";
  const now = Date.now();
  const user = { type: "user", uuid: "u1", sessionId, cwd: "/repo/otel", timestamp: new Date(now - 12_000).toISOString() };
  const assistant = { type: "assistant", parentUuid: "u1", uuid: "a1", sessionId, cwd: user.cwd, timestamp: new Date(now - 3_000).toISOString(),
    message: { id: "msg_1", model, usage: { input_tokens: 1000, output_tokens: 250 }, stop_reason: "end_turn" } };
  const projectDir = path.join(home, ".claude", "projects", "otel");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`);
  const options = { home, now, activeWindowMinutes: 5 };
  const fallback = (await computeProjectTokenRates(options)).projects[0].sessions[0].rate;
  assert.equal(fallback.output_tokens_per_second, null);
  assert.equal(fallback.end_to_end_estimated, true);

  const attribute = (key, value) => ({ key, value });
  const span = {
    name: "claude_code.llm_request", traceId: "1".repeat(32), spanId: "2".repeat(16),
    startTimeUnixNano: String(BigInt(now - 9_000) * 1_000_000n),
    endTimeUnixNano: String(BigInt(now - 3_000) * 1_000_000n),
    attributes: [
      attribute("session.id", { stringValue: sessionId }),
      attribute("model", { stringValue: model }),
      attribute("success", { boolValue: true }),
      attribute("duration_ms", { intValue: "6000" }),
      attribute("ttft_ms", { intValue: "2000" }),
      attribute("first_content_ms", { intValue: "2100" }),
      attribute("output_tokens", { intValue: "250" }),
      attribute("prompt", { stringValue: "raw-content-must-not-be-retained" }),
    ],
  };
  const failed = { ...span, spanId: "3".repeat(16), status: { code: 2 } };
  const tool = { ...span, spanId: "4".repeat(16), name: "claude_code.tool" };
  const payload = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span, failed, tool] }] }] });
  const url = `http://127.0.0.1:${receiver.address().port}/v1/traces`;
  const request = { method: "POST", headers: { "Content-Type": "application/json" }, body: payload };
  assert.equal((await fetch(url, { ...request, headers: { ...request.headers, Origin: "https://example.com" } })).status, 403);
  await Promise.all([1, 2].map(async () => {
    assert.equal((await fetch(url, request)).status, 200);
  }));

  const report = await computeProjectTokenRates(options);
  const rate = report.projects[0].sessions[0].rate;
  assert.equal(rate.timing_source, "claude_otel");
  assert.equal(rate.output_tokens_per_second, 63.8);
  assert.equal(rate.end_to_end_tokens_per_second, 41.7);
  assert.equal(rate.estimated_request_count, 1);
  assert.equal(report.summary.first_response_ms, 2000);
  assert.equal(report.summary.sample_count, 1);
  assert.equal(report.projects[0].tokens.total_tokens, 1250);
  const saved = fs.readFileSync(path.join(trackerDir, "claude-otel-requests.json"), "utf8");
  assert.doesNotMatch(saved, /raw-content-must-not-be-retained/);
  assert.equal(JSON.parse(saved).length, 1);
});

test("classifySessionActivity treats IDLE Antigravity and exited CodeBuddy as not running even when recently touched", () => {
  const nowMs = 1_763_430_000_000;
  const idleAg = classifySessionActivity(
    {
      source: "antigravity",
      run_status: "CASCADE_RUN_STATUS_IDLE",
      not_fully_idle: false,
      killed: false,
      file_mtime_ms: nowMs - 10_000,
      ended_at: new Date(nowMs - 10_000).toISOString(),
    },
    { nowMs },
  );
  assert.equal(idleAg.status, "recent");

  const runningAg = classifySessionActivity(
    {
      source: "antigravity",
      run_status: "CASCADE_RUN_STATUS_RUNNING",
      not_fully_idle: true,
      killed: false,
      file_mtime_ms: nowMs - 10_000,
      ended_at: new Date(nowMs - 10_000).toISOString(),
    },
    { nowMs },
  );
  assert.equal(runningAg.status, "running");

  const exitedCb = classifySessionActivity(
    {
      source: "codebuddy",
      process_alive: false,
      file_mtime_ms: nowMs - 60_000,
      ended_at: new Date(nowMs - 60_000).toISOString(),
    },
    { nowMs },
  );
  assert.equal(exitedCb.status, "recent");
});
