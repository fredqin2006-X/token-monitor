"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const LOG_PREFIX = /^\[[\d/ :.]+\] \[\w+\] \[pid=(\d+)\] \[ModelProvider\]/;
const FIRST_TOKEN = /First meaningful token received: .*?\brequestId=([\w-]+), ttft=(\d+)ms\b/;
const STREAM_FINISH = /finish_reason="[\w-]+" received, starting grace period: .*?\brequestId=([\w-]+), .*?\belapsed=(\d+)ms\b/;
const MAX_CACHED_LOGS = 128;
const logCache = new Map();

async function parseLog(file) {
  const started = new Map();
  const timings = new Map();
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    const prefix = LOG_PREFIX.exec(line);
    if (!prefix) continue;
    const first = FIRST_TOKEN.exec(line);
    if (first) {
      started.set(`${prefix[1]}:${first[1]}`, Number(first[2]));
      continue;
    }
    const finish = STREAM_FINISH.exec(line);
    if (!finish) continue;
    const key = `${prefix[1]}:${finish[1]}`;
    const firstResponseMs = started.get(key);
    started.delete(key);
    const durationMs = Number(finish[2]) - firstResponseMs;
    // This marker precedes the stream's grace period and tool dispatch.
    if (durationMs > 0 && !timings.has(finish[1])) {
      timings.set(finish[1], { durationMs, firstResponseMs });
    }
  }
  return timings;
}

async function readLog(file) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) return new Map();
  const signature = `${stat.mtimeMs}:${stat.size}`;
  const cached = logCache.get(file);
  if (cached?.signature === signature) return cached.timings;
  const timings = parseLog(file).catch(() => {
    if (logCache.get(file)?.timings === timings) logCache.delete(file);
    return new Map();
  });
  if (logCache.size >= MAX_CACHED_LOGS) logCache.delete(logCache.keys().next().value);
  logCache.set(file, { signature, timings });
  return timings;
}

function logDay(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, "0")).join("-");
}

async function readCodebuddyStreamTimings(sessionPath, usageTimes) {
  let dir = path.dirname(sessionPath);
  while (path.basename(dir) !== "projects") {
    const parent = path.dirname(dir);
    if (parent === dir) return new Map();
    dir = parent;
  }

  const days = new Set();
  for (const timestamp of usageTimes) {
    if (!Number.isFinite(timestamp)) continue;
    const date = new Date(timestamp);
    days.add(logDay(date));
    date.setDate(date.getDate() - 1);
    days.add(logDay(date));
  }
  const logs = path.join(path.dirname(dir), "logs");
  const groups = await Promise.all([...days].sort().map(async (day) => {
    const folder = path.join(logs, day);
    const entries = await fsp.readdir(folder, { withFileTypes: true }).catch(() => []);
    return Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map((entry) => readLog(path.join(folder, entry.name))));
  }));
  const timings = new Map();
  for (const group of groups) {
    for (const rows of group) {
      for (const [id, timing] of rows) timings.set(id, timing);
    }
  }
  return timings;
}

module.exports = { readCodebuddyStreamTimings };
