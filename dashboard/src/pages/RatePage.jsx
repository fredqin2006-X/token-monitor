import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  FolderGit2,
  Gauge,
  Pause,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Zap,
} from "lucide-react";
import { copy } from "../lib/copy";
import { formatCompactNumber, formatUsdCurrency } from "../lib/format";
import { formatProviderDisplayName } from "../lib/provider-display";
import { getTokenRate } from "../lib/rate-api";
import { isLocalDashboardHost } from "../lib/host-mode";
import { isMockEnabled } from "../lib/mock-data";
import { cn } from "../lib/cn";
import { TOKEN_FORMAT_MODES, TOKEN_UNIT_SYSTEMS } from "../lib/token-format.js";
import { useCurrency } from "../hooks/useCurrency";
import { useTokenFormat } from "../hooks/useTokenFormat.js";
import { HoverTooltip } from "../ui/components/HoverTooltip.jsx";
import { LocalOnlyNotice } from "../components/LocalOnlyNotice.jsx";
import { showToast } from "../ui/components/Toast.jsx";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";

const IS_LOCAL_HOST = isLocalDashboardHost();
const POLL_INTERVAL_SECONDS = 5;

const WINDOW_OPTIONS = [
  { minutes: 5, label: () => { return copy("rate.window.5m"); } },
  { minutes: 15, label: () => { return copy("rate.window.15m"); } },
  { minutes: 60, label: () => { return copy("rate.window.60m"); } },
];

const STATUS_OPTIONS = [
  { id: "all", label: () => { return copy("rate.filter.status_all"); } },
  { id: "running", label: () => { return copy("rate.filter.status_running"); } },
  { id: "recent", label: () => { return copy("rate.filter.status_recent"); } },
];

const SOURCE_OPTIONS = [
  { id: "all", label: () => { return copy("usage.filter.source_all"); } },
  { id: "codebuddy", label: () => { return formatProviderDisplayName("codebuddy"); } },
  { id: "antigravity", label: () => { return formatProviderDisplayName("antigravity"); } },
  { id: "claude", label: () => { return "Claude Code"; } },
  { id: "codex", label: () => { return "Codex"; } },
  { id: "opencode", label: () => { return "OpenCode"; } },
  { id: "zcode", label: () => { return "ZCode"; } },
  { id: "grok", label: () => { return "Grok"; } },
  { id: "kimi", label: () => { return copy("leaderboard.column.kimi"); } },
];

async function copyTextToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  return ok;
}

function formatRateNumber(value, digits = 1, formatCount = formatCompactNumber) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return copy("rate.unit.none");
  if (1000 <= num) return formatCount(Math.round(num), { mode: TOKEN_FORMAT_MODES.COMPACT });
  return num.toFixed(digits);
}

function formatLatencyMs(ms) {
  const num = Number(ms);
  if (!Number.isFinite(num) || num <= 0) return copy("rate.unit.none");
  if (1000 <= num) {
    return copy("rate.unit.seconds", { value: (num / 1000).toFixed(2) });
  }
  return copy("rate.unit.ms", { value: Math.round(num) });
}

function formatDurationShort(ms) {
  const num = Number(ms);
  if (!Number.isFinite(num) || num <= 0) return copy("rate.unit.none");
  const totalSeconds = Math.max(1, Math.round(num / 1000));
  if (totalSeconds < 60) {
    return copy("rate.unit.seconds", { value: totalSeconds });
  }
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  if (0 < hours) {
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m`;
  }
  const remSeconds = totalSeconds % 60;
  return 0 < remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
}

function formatRelativeOrClock(iso) {
  if (!iso) return copy("rate.unit.none");
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return copy("rate.unit.none");
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return copy("rate.unit.seconds", { value: diffSec });
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return new Date(ms).toLocaleDateString();
}

function StatusBadge({ status }) {
  const isRunning = status === "running";
  const isRecent = status === "recent";
  const label = isRunning
    ? copy("rate.status.running")
    : isRecent
      ? copy("rate.status.recent")
      : copy("rate.status.idle");
  return (
    <span
      role="status"
      title={label}
      aria-label={label}
      className="relative inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center"
    >
      {isRunning ? (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      ) : null}
      <span
        className={cn(
          "relative inline-flex h-2 w-2 rounded-full",
          isRunning
            ? "bg-emerald-500"
            : isRecent
              ? "bg-sky-500"
              : "bg-oai-gray-400 dark:bg-oai-gray-500",
        )}
      />
    </span>
  );
}

function SampleSparkBars({ samples, formatTokens }) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const maxTps = Math.max(...samples.map((s) => { return Number(s.tokens_per_second) || 0; }), 1);
  return (
    <div className="mt-3 rounded-lg border border-oai-gray-100 bg-oai-gray-50/70 p-3 dark:border-oai-gray-800/80 dark:bg-oai-gray-950/50">
      <div className="mb-2 flex items-center justify-between text-xs text-oai-gray-500 dark:text-oai-gray-400">
        <span className="font-medium">{copy("rate.project.recent_samples")}</span>
        <span className="tabular-nums">
          {`${formatRateNumber(samples[samples.length - 1]?.tokens_per_second, 1, formatTokens)} ${copy("rate.unit.tps")}`}
        </span>
      </div>
      <div className="flex h-10 items-end gap-1 sm:h-12">
        {samples.map((sample, idx) => {
          const tps = Number(sample.tokens_per_second) || 0;
          const pct = Math.max(12, Math.min(100, Math.round((tps / maxTps) * 100)));
          const isLatest = idx === samples.length - 1;
          const tooltipText = copy("rate.project.sample_tooltip", {
            model: sample.model || copy("sessions.model.unknown"),
            tps: formatRateNumber(tps, 1, formatTokens),
            output: formatTokens(sample.output_tokens || 0),
            duration: formatDurationShort(sample.duration_ms),
          });
          return (
            <div
              key={`${sample.timestamp_ms || idx}-${idx}`}
              title={tooltipText}
              className="group relative flex h-full flex-1 items-end"
            >
              <div
                style={{ height: `${pct}%` }}
                className={cn(
                  "w-full rounded-t transition-all",
                  isLatest
                    ? "bg-emerald-500 dark:bg-emerald-400"
                    : "bg-oai-brand-500/60 group-hover:bg-oai-brand-500 dark:bg-oai-brand-400/50 dark:group-hover:bg-oai-brand-400",
                )}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProjectRateCard({ project, currency, exchangeRate, formatTokens, formatTokensTooltip }) {
  const [expanded, setExpanded] = useState(project.status === "running");
  const isRunning = project.status === "running";
  const rate = project.rate || {};
  const tokens = project.tokens || {};
  const hasOutputRate = 0 < Number(rate.output_tokens_per_second);
  const hasPeakRate = 0 < Number(rate.peak_tokens_per_second);
  const hasThroughput = 0 < Number(rate.total_tokens_per_second);
  const hasBurnRate = 0 < Number(rate.tokens_per_minute);
  const hasReasoning = 0 < Number(tokens.reasoning_output_tokens);
  const hasActiveSessions = 0 < Number(project.active_session_count);
  const hasSessions = Array.isArray(project.sessions) && 0 < project.sessions.length;
  const latestRate = rate.latest_tokens_per_second ?? rate.output_tokens_per_second;
  const activePid = useMemo(() => {
    const found = (project.sessions || []).find((s) => { return Boolean(s.process_alive && s.pid); });
    return found ? found.pid : null;
  }, [project.sessions]);

  const handleCopyPath = async () => {
    if (!project.project_ref) return;
    try {
      const ok = await copyTextToClipboard(project.project_ref);
      if (ok) showToast({ title: copy("sessions.project.copied") });
      else showToast({ title: copy("sessions.project.copy_failed") });
    } catch {
      showToast({ title: copy("sessions.project.copy_failed") });
    }
  };

  const totalTokens = Number(tokens.total_tokens || 0);
  const hasTotalTokens = 0 < totalTokens;
  const inputPct = hasTotalTokens ? Math.round(((tokens.input_tokens || 0) / totalTokens) * 100) : 0;
  const cachedPct = hasTotalTokens ? Math.round(((tokens.cached_input_tokens || 0) / totalTokens) * 100) : 0;
  const outputPct = hasTotalTokens ? Math.max(1, 100 - inputPct - cachedPct) : 0;

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border bg-white p-3.5 transition-shadow sm:p-5 dark:bg-oai-gray-900",
        isRunning
          ? "border-emerald-500/40 shadow-sm dark:border-emerald-500/40"
          : "border-oai-gray-200 dark:border-oai-gray-800",
      )}
    >
      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <StatusBadge status={project.status} />
            <h3 className="min-w-0 truncate text-sm font-semibold text-oai-black sm:text-base dark:text-white">
              {project.project_key}
            </h3>
            {activePid ? (
              <span className="inline-flex shrink-0 whitespace-nowrap items-center rounded-md bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                {copy("rate.badge.pid", { pid: activePid })}
              </span>
            ) : null}
            <span className="inline-flex shrink-0 whitespace-nowrap items-center rounded-md bg-oai-gray-100 px-2 py-0.5 text-[11px] text-oai-gray-600 sm:text-xs dark:bg-oai-gray-800 dark:text-oai-gray-300">
              {hasActiveSessions
                ? copy("rate.badge.sessions_count", {
                    active: project.active_session_count,
                    total: project.session_count,
                  })
                : copy("rate.badge.sessions_total", { total: project.session_count })}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-oai-gray-500 sm:gap-x-3 sm:text-xs dark:text-oai-gray-400">
            {project.project_ref ? (
              <span className="group relative inline-flex min-w-0 max-w-full items-center gap-1">
                <FolderGit2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <HoverTooltip
                  text={`${project.project_ref}\n${copy("sessions.project.copy_hint")}`}
                  placement="bottom"
                />
                <button
                  type="button"
                  onClick={handleCopyPath}
                  className="min-w-0 max-w-full truncate underline decoration-dotted decoration-oai-gray-300 underline-offset-4 hover:text-oai-black sm:max-w-[320px] dark:decoration-oai-gray-600 dark:hover:text-white"
                >
                  {project.project_ref}
                </button>
              </span>
            ) : null}
            {project.latest_title && project.latest_title !== project.project_key ? (
              <span className="min-w-0 max-w-full truncate font-medium text-oai-gray-700 dark:text-oai-gray-300">
                {project.latest_title}
              </span>
            ) : null}
            <span className="shrink-0 tabular-nums">
              {formatRelativeOrClock(project.last_active_at)}
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:justify-end">
          {(project.sources || []).map((source) => {
            return (
              <span
                key={source}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-oai-gray-200 bg-oai-gray-50 px-2 py-0.5 text-[11px] font-medium text-oai-gray-700 sm:px-2.5 sm:py-1 sm:text-xs dark:border-oai-gray-700 dark:bg-oai-gray-800 dark:text-oai-gray-200"
              >
                <ProviderIcon provider={String(source).toUpperCase()} size={15} className="shrink-0" />
                <span className="whitespace-nowrap">{formatProviderDisplayName(source)}</span>
              </span>
            );
          })}
          {(project.models || []).slice(0, 2).map((model) => {
            return (
              <span
                key={model}
                title={model}
                className="inline-flex max-w-full min-w-0 items-center truncate rounded-lg border border-oai-gray-200 bg-white px-2 py-0.5 font-mono text-[11px] text-oai-gray-600 sm:py-1 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-gray-300"
              >
                {model}
              </span>
            );
          })}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:mt-4 sm:grid-cols-4 sm:gap-3">
        <div className="min-w-0 rounded-lg border border-oai-gray-100 bg-oai-gray-50/60 p-2.5 sm:p-3 dark:border-oai-gray-800 dark:bg-oai-gray-950/40">
          <div className="truncate text-[11px] text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
            {copy("rate.project.latest_speed")}
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-lg font-semibold tabular-nums text-oai-black sm:text-xl dark:text-white">
              {hasOutputRate ? formatRateNumber(latestRate, 1, formatTokens) : copy("rate.unit.none")}
            </span>
            {hasOutputRate ? (
              <span className="text-[11px] text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
                {copy("rate.unit.tps")}
              </span>
            ) : null}
          </div>
        </div>

        <div className="min-w-0 rounded-lg border border-oai-gray-100 bg-oai-gray-50/60 p-2.5 sm:p-3 dark:border-oai-gray-800 dark:bg-oai-gray-950/40">
          <div className="truncate text-[11px] text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
            {copy("rate.project.avg_speed")}
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-lg font-semibold tabular-nums text-oai-black sm:text-xl dark:text-white">
              {hasOutputRate
                ? formatRateNumber(rate.output_tokens_per_second, 1, formatTokens)
                : copy("rate.unit.none")}
            </span>
            {hasOutputRate ? (
              <span className="text-[11px] text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
                {copy("rate.unit.tps")}
              </span>
            ) : null}
          </div>
        </div>

        <div className="min-w-0 rounded-lg border border-oai-gray-100 bg-oai-gray-50/60 p-2.5 sm:p-3 dark:border-oai-gray-800 dark:bg-oai-gray-950/40">
          <div className="truncate text-[11px] text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
            {copy("rate.project.peak_speed")}
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-lg font-semibold tabular-nums text-emerald-600 sm:text-xl dark:text-emerald-400">
              {hasPeakRate
                ? formatRateNumber(rate.peak_tokens_per_second, 1, formatTokens)
                : copy("rate.unit.none")}
            </span>
            {hasPeakRate ? (
              <span className="text-[11px] text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
                {copy("rate.unit.tps")}
              </span>
            ) : null}
          </div>
        </div>

        <div className="min-w-0 rounded-lg border border-oai-gray-100 bg-oai-gray-50/60 p-2.5 sm:p-3 dark:border-oai-gray-800 dark:bg-oai-gray-950/40">
          <div className="truncate text-[11px] text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
            {copy("rate.project.total_throughput")}
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-lg font-semibold tabular-nums text-oai-black sm:text-xl dark:text-white">
              {hasThroughput
                ? formatRateNumber(rate.total_tokens_per_second, 1, formatTokens)
                : copy("rate.unit.none")}
            </span>
            {hasThroughput ? (
              <span className="text-[11px] text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
                {copy("rate.unit.tps")}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <SampleSparkBars samples={project.samples} formatTokens={formatTokens} />

      <div className="mt-3 space-y-2">
        {hasTotalTokens ? (
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-oai-gray-100 dark:bg-oai-gray-800">
            <div
              style={{ width: `${inputPct}%` }}
              className="bg-sky-500 transition-all"
            />
            <div
              style={{ width: `${cachedPct}%` }}
              className="bg-violet-500 transition-all"
            />
            <div
              style={{ width: `${outputPct}%` }}
              className="bg-emerald-500 transition-all"
            />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 tabular-nums sm:gap-x-3">
            <span title={formatTokensTooltip(totalTokens)}>
              {`${copy("rate.project.total_tokens")}: ${formatTokens(totalTokens)}`}
            </span>
            <span title={formatTokensTooltip(tokens.input_tokens || 0)}>
              {`${copy("rate.project.input_tokens")}: ${formatTokens(tokens.input_tokens || 0)}`}
            </span>
            <span title={formatTokensTooltip(tokens.cached_input_tokens || 0)}>
              {`${copy("rate.project.cached_tokens")}: ${formatTokens(tokens.cached_input_tokens || 0)}`}
            </span>
            <span title={formatTokensTooltip(tokens.output_tokens || 0)}>
              {`${copy("rate.project.output_tokens")}: ${formatTokens(tokens.output_tokens || 0)}`}
            </span>
            {hasReasoning ? (
              <span title={formatTokensTooltip(tokens.reasoning_output_tokens)}>
                {`${copy("rate.project.reasoning_tokens")}: ${formatTokens(tokens.reasoning_output_tokens)}`}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
            {project.cache_hit_rate !== null ? (
              <span>
                {`${copy("rate.project.cache_hit")}: ${copy("rate.unit.percent", { value: project.cache_hit_rate })}`}
              </span>
            ) : null}
            {rate.first_response_ms !== null ? (
              <span>
                {`${copy("rate.project.first_token")}: ${formatLatencyMs(rate.first_response_ms)}`}
              </span>
            ) : null}
            {hasBurnRate ? (
              <span title={formatTokensTooltip(Math.round(rate.tokens_per_minute))}>
                {`${copy("rate.project.burn_rate")}: ${formatRateNumber(rate.tokens_per_minute, 0, formatTokens)} ${copy("rate.unit.tpm")}`}
              </span>
            ) : null}
            <span>
              {`${copy("rate.project.cost")}: ${formatUsdCurrency(project.cost_usd || 0, { currency, rate: exchangeRate })}`}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-oai-gray-100 pt-3 text-xs text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400">
        <span>
          {copy("rate.project.turns_tools", {
            turns: project.turns || 0,
            tools: project.tool_calls || 0,
            requests: rate.estimated_request_count || 0,
          })}
        </span>
        {hasSessions ? (
          <button
            type="button"
            onClick={() => { setExpanded((prev) => { return !prev; }); }}
            className="inline-flex items-center gap-1 font-medium text-oai-gray-700 hover:text-oai-black dark:text-oai-gray-300 dark:hover:text-white"
          >
            <span>
              {expanded
                ? copy("rate.project.sessions_toggle_hide")
                : copy("rate.project.sessions_toggle_show", {
                    count: project.sessions.length,
                  })}
            </span>
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>

      {expanded && hasSessions ? (
        <div className="mt-3 divide-y divide-oai-gray-100 rounded-lg border border-oai-gray-100 bg-oai-gray-50/40 dark:divide-oai-gray-800 dark:border-oai-gray-800 dark:bg-oai-gray-950/30">
          {project.sessions.map((session) => {
            const sRate = session.rate || {};
            const sHasOutput = 0 < Number(sRate.output_tokens_per_second);
            const sHasThroughput = 0 < Number(sRate.total_tokens_per_second);
            return (
              <div
                key={session.session_hash}
                className="flex flex-col gap-1.5 px-3 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:py-2"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                    <ProviderIcon provider={String(session.source).toUpperCase()} size={15} className="shrink-0" />
                  </span>
                  <StatusBadge status={session.status} />
                  <span className="min-w-0 flex-1 truncate font-medium text-oai-black dark:text-white">
                    {session.title || project.project_key}
                  </span>
                  <span
                    title={session.model}
                    className="max-w-[110px] shrink-0 truncate whitespace-nowrap rounded bg-oai-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-oai-gray-600 sm:max-w-[180px] sm:text-[11px] dark:bg-oai-gray-800 dark:text-oai-gray-300"
                  >
                    {session.model}
                  </span>
                  {session.process_alive && session.pid ? (
                    <span className="shrink-0 whitespace-nowrap rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                      {copy("rate.badge.pid", { pid: session.pid })}
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 pl-6 tabular-nums text-oai-gray-600 sm:justify-end sm:pl-0 dark:text-oai-gray-300">
                  <span className="font-semibold text-oai-black dark:text-white">
                    {sHasOutput
                      ? `${formatRateNumber(sRate.latest_tokens_per_second ?? sRate.output_tokens_per_second, 1, formatTokens)} ${copy("rate.unit.tps")}`
                      : copy("rate.unit.none")}
                  </span>
                  {sHasThroughput ? (
                    <span className="text-oai-gray-500 dark:text-oai-gray-400">
                      {`${formatRateNumber(sRate.total_tokens_per_second, 1, formatTokens)} ${copy("rate.unit.tps")}`}
                    </span>
                  ) : null}
                  <span title={formatTokensTooltip(session.tokens?.total_tokens || 0)}>
                    {formatTokens(session.tokens?.total_tokens || 0)}
                  </span>
                  <span className="text-oai-gray-400">
                    {formatRelativeOrClock(session.last_active_at)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function RatePage() {
  const localAvailable = IS_LOCAL_HOST || isMockEnabled();
  const { currency, rate: exchangeRate } = useCurrency();
  const { formatTokens, formatTokensTooltip, unitSystem, setUnitSystem } = useTokenFormat();
  const [activeMinutes, setActiveMinutes] = useState(15);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [livePolling, setLivePolling] = useState(true);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(localAvailable);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const loadRateData = useCallback(
    async ({ refresh = false, silent = false } = {}) => {
      if (!localAvailable) return;
      if (refresh) setRefreshing(true);
      else if (!silent) setLoading(true);
      try {
        const res = await getTokenRate({
          activeMinutes,
          recentMinutes: 1440,
          refresh,
        });
        setData(res);
        setError(null);
      } catch (err) {
        if (!silent) {
          setError(err?.message || copy("rate.error.load_failed"));
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeMinutes, localAvailable],
  );

  useEffect(() => {
    loadRateData();
  }, [loadRateData]);

  useEffect(() => {
    if (!localAvailable || !livePolling) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        loadRateData({ silent: true });
      }
    }, POLL_INTERVAL_SECONDS * 1000);
    return () => { clearInterval(timer); };
  }, [livePolling, loadRateData, localAvailable]);

  const filteredProjects = useMemo(() => {
    const list = data?.projects || [];
    const q = searchQuery.trim().toLowerCase();
    return list.filter((project) => {
      if (statusFilter === "running" && project.status !== "running") return false;
      if (statusFilter === "recent" && project.status === "idle") return false;
      if (
        sourceFilter !== "all" &&
        !(project.sources || []).includes(sourceFilter)
      ) {
        return false;
      }
      if (q) {
        const hay = [
          project.project_key,
          project.project_ref,
          project.latest_title,
          ...(project.models || []),
          ...(project.sources || []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data?.projects, searchQuery, sourceFilter, statusFilter]);

  const summary = data?.summary || {
    running_project_count: 0,
    running_session_count: 0,
    total_project_count: 0,
    output_tokens_per_second: null,
    latest_tokens_per_second: null,
    peak_tokens_per_second: null,
    total_tokens_per_second: null,
    tokens_per_minute: 0,
    first_response_ms: null,
    sample_count: 0,
  };

  const hasProviders = Array.isArray(data?.by_provider) && 0 < data.by_provider.length;

  if (!localAvailable) {
    return (
      <div className="flex flex-1 flex-col font-oai text-oai-black antialiased dark:text-oai-white">
        <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-6 px-4 py-6 sm:px-6 md:px-10">
          <LocalOnlyNotice />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col font-oai text-oai-black antialiased dark:text-oai-white">
      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 px-3.5 py-4 sm:gap-6 sm:px-6 sm:py-6 md:px-10">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight text-oai-black sm:text-2xl dark:text-white">
                {copy("nav.rate")}
              </h1>
              <button
                type="button"
                onClick={() => { setLivePolling((prev) => { return !prev; }); }}
                aria-label={copy("rate.live.toggle_aria")}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                  livePolling
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/20 dark:text-emerald-300"
                    : "border-oai-gray-200 bg-oai-gray-100 text-oai-gray-600 dark:border-oai-gray-700 dark:bg-oai-gray-800 dark:text-oai-gray-400",
                )}
              >
                {livePolling ? (
                  <Pause className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <Play className="h-3 w-3" aria-hidden="true" />
                )}
                <span>
                  {livePolling
                    ? copy("rate.live.polling", { seconds: POLL_INTERVAL_SECONDS })
                    : copy("rate.live.paused")}
                </span>
              </button>
            </div>
            <p className="mt-1 text-xs text-oai-gray-500 sm:text-sm dark:text-oai-gray-400">
              {copy("rate.page.subtitle")}
            </p>
          </div>

          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <div className="inline-flex items-center rounded-lg border border-oai-gray-200 bg-oai-gray-50 p-0.5 dark:border-oai-gray-800 dark:bg-oai-gray-900">
              {[
                {
                  id: TOKEN_UNIT_SYSTEMS.ENGLISH,
                  label: copy("settings.appearance.token_unit.english"),
                },
                {
                  id: TOKEN_UNIT_SYSTEMS.CHINESE,
                  label: copy("settings.appearance.token_unit.chinese"),
                },
              ].map((opt) => {
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => { setUnitSystem(opt.id); }}
                    className={cn(
                      "whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium transition-colors sm:px-2.5 sm:text-xs",
                      unitSystem === opt.id
                        ? "bg-white text-oai-black shadow-sm dark:bg-oai-gray-800 dark:text-white"
                        : "text-oai-gray-500 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-white",
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <div className="inline-flex items-center rounded-lg border border-oai-gray-200 bg-oai-gray-50 p-0.5 dark:border-oai-gray-800 dark:bg-oai-gray-900">
              {WINDOW_OPTIONS.map((opt) => {
                return (
                  <button
                    key={opt.minutes}
                    type="button"
                    onClick={() => { setActiveMinutes(opt.minutes); }}
                    className={cn(
                      "whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium transition-colors sm:px-2.5 sm:text-xs",
                      activeMinutes === opt.minutes
                        ? "bg-white text-oai-black shadow-sm dark:bg-oai-gray-800 dark:text-white"
                        : "text-oai-gray-500 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-white",
                    )}
                  >
                    {opt.label()}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => { loadRateData({ refresh: true }); }}
              disabled={refreshing}
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg border border-oai-gray-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-50 disabled:opacity-50 sm:px-3 sm:text-xs dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-200 dark:hover:bg-oai-gray-800"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
                aria-hidden="true"
              />
              <span>
                {refreshing ? copy("rate.refresh.loading") : copy("rate.refresh.button")}
              </span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-4">
          <div className="min-w-0 rounded-xl border border-oai-gray-200 bg-white p-3 sm:p-4 dark:border-oai-gray-800 dark:bg-oai-gray-900">
            <div className="flex items-center justify-between gap-1 text-[11px] font-medium text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
              <span className="truncate">{copy("rate.summary.running_projects")}</span>
              <Activity className="h-3.5 w-3.5 shrink-0 text-emerald-500 sm:h-4 sm:w-4" aria-hidden="true" />
            </div>
            <div className="mt-1.5 text-xl font-semibold tabular-nums text-oai-black sm:mt-2 sm:text-2xl dark:text-white">
              {summary.running_project_count}
            </div>
            <div className="mt-1 text-[11px] leading-snug text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
              {copy("rate.summary.running_projects_sub", {
                sessions: summary.running_session_count,
                total: summary.total_project_count,
              })}
            </div>
          </div>

          <div className="min-w-0 rounded-xl border border-oai-gray-200 bg-white p-3 sm:p-4 dark:border-oai-gray-800 dark:bg-oai-gray-900">
            <div className="flex items-center justify-between gap-1 text-[11px] font-medium text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
              <span className="truncate">{copy("rate.summary.output_speed")}</span>
              <Zap className="h-3.5 w-3.5 shrink-0 text-amber-500 sm:h-4 sm:w-4" aria-hidden="true" />
            </div>
            <div className="mt-1.5 flex items-baseline gap-1 sm:mt-2 sm:gap-1.5">
              <span className="text-xl font-semibold tabular-nums text-oai-black sm:text-2xl dark:text-white">
                {formatRateNumber(
                  summary.latest_tokens_per_second ?? summary.output_tokens_per_second,
                  1,
                  formatTokens,
                )}
              </span>
              <span className="text-[11px] text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
                {copy("rate.unit.tps")}
              </span>
            </div>
            <div className="mt-1 text-[11px] leading-snug text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
              {copy("rate.summary.output_speed_sub", {
                avg: formatRateNumber(summary.output_tokens_per_second, 1, formatTokens),
                peak: formatRateNumber(summary.peak_tokens_per_second, 1, formatTokens),
              })}
            </div>
          </div>

          <div className="min-w-0 rounded-xl border border-oai-gray-200 bg-white p-3 sm:p-4 dark:border-oai-gray-800 dark:bg-oai-gray-900">
            <div className="flex items-center justify-between gap-1 text-[11px] font-medium text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
              <span className="truncate">{copy("rate.summary.total_throughput")}</span>
              <Gauge className="h-3.5 w-3.5 shrink-0 text-sky-500 sm:h-4 sm:w-4" aria-hidden="true" />
            </div>
            <div className="mt-1.5 flex items-baseline gap-1 sm:mt-2 sm:gap-1.5">
              <span className="text-xl font-semibold tabular-nums text-oai-black sm:text-2xl dark:text-white">
                {formatRateNumber(summary.total_tokens_per_second, 1, formatTokens)}
              </span>
              <span className="text-[11px] text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
                {copy("rate.unit.tps")}
              </span>
            </div>
            <div className="mt-1 text-[11px] leading-snug text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
              {copy("rate.summary.total_throughput_sub", {
                tpm: formatRateNumber(summary.tokens_per_minute, 0, formatTokens),
              })}
            </div>
          </div>

          <div className="min-w-0 rounded-xl border border-oai-gray-200 bg-white p-3 sm:p-4 dark:border-oai-gray-800 dark:bg-oai-gray-900">
            <div className="flex items-center justify-between gap-1 text-[11px] font-medium text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
              <span className="truncate">{copy("rate.summary.first_response")}</span>
              <Clock className="h-3.5 w-3.5 shrink-0 text-violet-500 sm:h-4 sm:w-4" aria-hidden="true" />
            </div>
            <div className="mt-1.5 text-xl font-semibold tabular-nums text-oai-black sm:mt-2 sm:text-2xl dark:text-white">
              {formatLatencyMs(summary.first_response_ms)}
            </div>
            <div className="mt-1 text-[11px] leading-snug text-oai-gray-500 sm:text-xs dark:text-oai-gray-400">
              {copy("rate.summary.first_response_sub", {
                samples: summary.sample_count || 0,
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="inline-flex w-fit items-center rounded-lg border border-oai-gray-200 bg-oai-gray-50 p-0.5 dark:border-oai-gray-800 dark:bg-oai-gray-900">
              {STATUS_OPTIONS.map((opt) => {
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => { setStatusFilter(opt.id); }}
                    className={cn(
                      "whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      statusFilter === opt.id
                        ? "bg-white text-oai-black shadow-sm dark:bg-oai-gray-800 dark:text-white"
                        : "text-oai-gray-500 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-white",
                    )}
                  >
                    {opt.label()}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:gap-1 sm:overflow-visible sm:pb-0">
              {SOURCE_OPTIONS.map((src) => {
                return (
                  <button
                    key={src.id}
                    type="button"
                    onClick={() => { setSourceFilter(src.id); }}
                    className={cn(
                      "inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
                      sourceFilter === src.id
                        ? "border-oai-black bg-oai-black text-white dark:border-white dark:bg-white dark:text-oai-black"
                        : "border-oai-gray-200 bg-white text-oai-gray-600 hover:border-oai-gray-300 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-300",
                    )}
                  >
                    {src.id !== "all" ? (
                      <ProviderIcon provider={src.id.toUpperCase()} size={15} className="shrink-0" />
                    ) : null}
                    <span>{src.label()}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="relative w-full min-w-0 sm:w-64 sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-oai-gray-400"
              aria-hidden="true"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); }}
              placeholder={copy("rate.filter.search_placeholder")}
              className="w-full rounded-lg border border-oai-gray-200 bg-white py-1.5 pl-8 pr-3 text-xs text-oai-black placeholder:text-oai-gray-400 focus:border-oai-brand-500 focus:outline-none dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white"
            />
          </div>
        </div>

        {error ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        ) : null}

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-oai-black dark:text-white">
              {copy("rate.section.projects_title")}
            </h2>
            <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {copy("rate.section.projects_count", { count: filteredProjects.length })}
            </span>
          </div>

          {loading && !data ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {[0, 1, 2, 3].map((item) => {
                return (
                  <div
                    key={item}
                    className="h-56 animate-pulse rounded-xl border border-oai-gray-200 bg-oai-gray-50 dark:border-oai-gray-800 dark:bg-oai-gray-900"
                  />
                );
              })}
            </div>
          ) : null}

          {(!loading || data) && filteredProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-oai-gray-200 bg-white px-6 py-12 text-center dark:border-oai-gray-800 dark:bg-oai-gray-900">
              <Sparkles className="h-8 w-8 text-oai-gray-400" aria-hidden="true" />
              <h3 className="mt-3 text-sm font-semibold text-oai-black dark:text-white">
                {copy("rate.empty.title")}
              </h3>
              <p className="mt-1 max-w-md text-xs text-oai-gray-500 dark:text-oai-gray-400">
                {copy("rate.empty.body")}
              </p>
            </div>
          ) : null}

          {(!loading || data) && 0 < filteredProjects.length ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {filteredProjects.map((project) => {
                return (
                  <ProjectRateCard
                    key={project.project_id}
                    project={project}
                    currency={currency}
                    exchangeRate={exchangeRate}
                    formatTokens={formatTokens}
                    formatTokensTooltip={formatTokensTooltip}
                  />
                );
              })}
            </div>
          ) : null}
        </div>

        {hasProviders ? (
          <div className="rounded-xl border border-oai-gray-200 bg-white p-3.5 sm:p-5 dark:border-oai-gray-800 dark:bg-oai-gray-900">
            <div className="mb-3 sm:mb-4">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 shrink-0 text-oai-brand-500" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-oai-black dark:text-white">
                  {copy("rate.section.providers_title")}
                </h2>
              </div>
              <p className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">
                {copy("rate.section.providers_subtitle")}
              </p>
            </div>

            <div className="divide-y divide-oai-gray-100 sm:hidden dark:divide-oai-gray-800">
              {data.by_provider.map((row) => {
                const r = row.rate || {};
                const hasOut = 0 < Number(r.output_tokens_per_second);
                const hasPeak = 0 < Number(r.peak_tokens_per_second);
                const hasTotalTps = 0 < Number(r.total_tokens_per_second);
                return (
                  <div key={row.source} className="space-y-2 py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="inline-flex items-center gap-2 font-medium text-xs text-oai-black dark:text-white">
                        <ProviderIcon provider={String(row.source).toUpperCase()} size={15} className="shrink-0" />
                        <span>{formatProviderDisplayName(row.source)}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
                        <span>{`${row.active_sessions} / ${row.total_sessions}`}</span>
                        <span
                          title={formatTokensTooltip(row.tokens?.total_tokens || 0)}
                          className="font-medium text-oai-black dark:text-white"
                        >
                          {formatTokens(row.tokens?.total_tokens || 0)}
                        </span>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[11px] tabular-nums">
                      <div>
                        <div className="text-oai-gray-400">{copy("rate.table.avg_output_rate")}</div>
                        <div className="font-semibold text-oai-black dark:text-white">
                          {hasOut
                            ? `${formatRateNumber(r.output_tokens_per_second, 1, formatTokens)} ${copy("rate.unit.tps")}`
                            : copy("rate.unit.none")}
                        </div>
                      </div>
                      <div>
                        <div className="text-oai-gray-400">{copy("rate.table.peak_output_rate")}</div>
                        <div className="font-semibold text-emerald-600 dark:text-emerald-400">
                          {hasPeak
                            ? `${formatRateNumber(r.peak_tokens_per_second, 1, formatTokens)} ${copy("rate.unit.tps")}`
                            : copy("rate.unit.none")}
                        </div>
                      </div>
                      <div>
                        <div className="text-oai-gray-400">{copy("rate.table.total_throughput")}</div>
                        <div className="text-oai-gray-700 dark:text-oai-gray-300">
                          {hasTotalTps
                            ? `${formatRateNumber(r.total_tokens_per_second, 1, formatTokens)} ${copy("rate.unit.tps")}`
                            : copy("rate.unit.none")}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-oai-gray-100 text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400">
                    <th className="pb-2.5 pr-4 font-medium">{copy("rate.table.provider")}</th>
                    <th className="pb-2.5 pr-4 font-medium">{copy("rate.table.active_sessions")}</th>
                    <th className="pb-2.5 pr-4 font-medium">{copy("rate.table.avg_output_rate")}</th>
                    <th className="pb-2.5 pr-4 font-medium">{copy("rate.table.peak_output_rate")}</th>
                    <th className="pb-2.5 pr-4 font-medium">{copy("rate.table.total_throughput")}</th>
                    <th className="pb-2.5 pr-4 font-medium">{copy("rate.table.first_token")}</th>
                    <th className="pb-2.5 pr-4 font-medium">{copy("rate.table.cache_hit")}</th>
                    <th className="pb-2.5 text-right font-medium">{copy("rate.table.total_tokens")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800">
                  {data.by_provider.map((row) => {
                    const r = row.rate || {};
                    const hasOut = 0 < Number(r.output_tokens_per_second);
                    const hasPeak = 0 < Number(r.peak_tokens_per_second);
                    const hasTotalTps = 0 < Number(r.total_tokens_per_second);
                    return (
                      <tr key={row.source} className="tabular-nums">
                        <td className="py-2.5 pr-4 font-medium text-oai-black dark:text-white">
                          <div className="inline-flex items-center gap-2">
                            <ProviderIcon provider={String(row.source).toUpperCase()} size={15} />
                            <span>{formatProviderDisplayName(row.source)}</span>
                          </div>
                        </td>
                        <td className="py-2.5 pr-4 text-oai-gray-600 dark:text-oai-gray-300">
                          {`${row.active_sessions} / ${row.total_sessions}`}
                        </td>
                        <td className="py-2.5 pr-4 font-semibold text-oai-black dark:text-white">
                          {hasOut
                            ? `${formatRateNumber(r.output_tokens_per_second, 1, formatTokens)} ${copy("rate.unit.tps")}`
                            : copy("rate.unit.none")}
                        </td>
                        <td className="py-2.5 pr-4 text-emerald-600 dark:text-emerald-400">
                          {hasPeak
                            ? `${formatRateNumber(r.peak_tokens_per_second, 1, formatTokens)} ${copy("rate.unit.tps")}`
                            : copy("rate.unit.none")}
                        </td>
                        <td className="py-2.5 pr-4 text-oai-gray-700 dark:text-oai-gray-300">
                          {hasTotalTps
                            ? `${formatRateNumber(r.total_tokens_per_second, 1, formatTokens)} ${copy("rate.unit.tps")}`
                            : copy("rate.unit.none")}
                        </td>
                        <td className="py-2.5 pr-4 text-oai-gray-600 dark:text-oai-gray-300">
                          {formatLatencyMs(r.first_response_ms)}
                        </td>
                        <td className="py-2.5 pr-4 text-oai-gray-600 dark:text-oai-gray-300">
                          {row.cache_hit_rate !== null
                            ? copy("rate.unit.percent", { value: row.cache_hit_rate })
                            : copy("rate.unit.none")}
                        </td>
                        <td
                          title={formatTokensTooltip(row.tokens?.total_tokens || 0)}
                          className="py-2.5 text-right font-medium text-oai-black dark:text-white"
                        >
                          {formatTokens(row.tokens?.total_tokens || 0)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
