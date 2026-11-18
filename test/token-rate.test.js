"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createCodebuddyPerformanceCollector,
  createAntigravityPerformanceCollector,
} = require("../src/lib/session-performance");
const {
  scanCodebuddySessionFile,
  scanAntigravitySessionFile,
  computeProjectTokenRates,
  classifySessionActivity,
} = require("../src/lib/token-rate");
const {
  scanCodebuddySession,
  scanAntigravitySession,
} = require("../src/lib/session-analytics");

test("CodeBuddy performance collector excludes tool execution via parentId chain", () => {
  const collector = createCodebuddyPerformanceCollector();
  const rows = [
    { id: "u1", parentId: null, type: "message", role: "user", timestamp: 1_700_000_000_000 },
    { id: "r1", parentId: "u1", type: "reasoning", timestamp: 1_700_000_001_000 },
    {
      id: "fc1",
      parentId: "r1",
      type: "function_call",
      name: "read_file",
      timestamp: 1_700_000_004_000,
      providerData: {
        messageId: "msg-1",
        model: "glm-5.1",
        rawUsage: { prompt_tokens: 1000, completion_tokens: 120, total_tokens: 1120 },
      },
    },
    // Tool executes for 20 seconds (4000ms -> 24000ms)
    { id: "fcr1", parentId: "fc1", type: "function_call_result", timestamp: 1_700_000_024_000 },
    {
      id: "m2",
      parentId: "fcr1",
      type: "message",
      role: "assistant",
      timestamp: 1_700_000_029_000,
      providerData: {
        messageId: "msg-2",
        model: "glm-5.1",
        rawUsage: { prompt_tokens: 1200, completion_tokens: 200, total_tokens: 1400 },
      },
    },
  ];

  for (const row of rows) {
    const rawUsage = row.providerData?.rawUsage;
    const usage = rawUsage
      ? {
          input_tokens: rawUsage.prompt_tokens,
          output_tokens: rawUsage.completion_tokens,
          total_tokens: rawUsage.total_tokens,
        }
      : null;
    collector.consume(row, row.providerData?.messageId, usage, "glm-5.1");
  }

  const finished = collector.finish();
  // Round 1: 4000ms (120 tok -> 30 tok/s). Round 2: 5000ms (200 tok -> 40 tok/s).
  // Total: 320 output tokens over 9000ms (~35.56 tok/s), tool execution (20s) excluded.
  assert.equal(finished.performance.estimated_request_count, 2);
  assert.equal(finished.performance.estimated_output_tokens, 320);
  assert.equal(finished.performance.estimated_duration_ms, 9000);
  assert.ok(Math.abs(finished.performance.estimated_tokens_per_second - 320 / 9) < 0.01);
  assert.equal(finished.samples.length, 2);
});

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
        timeToFirstTokenMs: 900,
      },
    },
  );

  const finished = collector.finish();
  assert.equal(finished.performance.estimated_request_count, 1);
  assert.equal(finished.performance.estimated_output_tokens, 360);
  assert.equal(finished.performance.estimated_duration_ms, 4500);
  assert.equal(finished.performance.estimated_tokens_per_second, 80);
  assert.equal(finished.performance.first_response_ms, 900);
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
  assert.equal(cbScanned.performance.estimated_tokens_per_second, 50);

  const agScanned = await scanAntigravitySession(agTranscript);
  assert.equal(agScanned.source, "antigravity");
  assert.equal(agScanned.performance.estimated_tokens_per_second, 50);

  const report = await computeProjectTokenRates({
    home,
    env: { HOME: home },
    now: nowMs,
    activeWindowMinutes: 15,
    recentWindowMinutes: 1440,
  });

  assert.equal(report.summary.running_project_count, 2);
  assert.equal(report.projects.length, 2);
  const sources = report.by_provider.map((p) => p.source).sort();
  assert.deepEqual(sources, ["antigravity", "codebuddy"]);
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
