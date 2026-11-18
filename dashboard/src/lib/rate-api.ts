import { copy } from "./copy";
import { isMockEnabled } from "./mock-data";

const SLUG = "tokentracker-token-rate";

export interface TokenTotals {
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export interface RateMetrics {
  output_tokens_per_second: number | null;
  latest_tokens_per_second: number | null;
  peak_tokens_per_second: number | null;
  total_tokens_per_second: number | null;
  tokens_per_minute?: number;
  requests_per_minute?: number;
  estimated_output_tokens: number;
  estimated_duration_ms: number;
  estimated_request_count: number;
  first_response_ms: number | null;
  first_response_sample_count: number;
}

export interface RateSample {
  timestamp_ms: number | null;
  model: string;
  source: string;
  output_tokens: number;
  total_tokens: number;
  duration_ms: number;
  tokens_per_second: number;
  total_tokens_per_second: number;
}

export interface ProjectRateSession {
  session_hash: string;
  session_id: string | null;
  title: string;
  source: string;
  model: string;
  status: "running" | "recent" | "idle";
  process_alive: boolean;
  pid: number | null;
  run_status: string | null;
  last_active_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  tokens: TokenTotals;
  rate: RateMetrics;
}

export interface ProjectRateRow {
  project_id: string;
  project_key: string;
  project_ref: string | null;
  status: "running" | "recent" | "idle";
  active_session_count: number;
  session_count: number;
  sources: string[];
  models: string[];
  primary_source: string;
  primary_model: string;
  latest_title: string;
  last_active_at: string | null;
  started_at: string | null;
  duration_ms: number;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  cache_hit_rate: number | null;
  tokens: TokenTotals;
  rate: RateMetrics;
  samples: RateSample[];
  sessions: ProjectRateSession[];
}

export interface ProviderRateRow {
  source: string;
  active_sessions: number;
  total_sessions: number;
  active_projects: number;
  total_projects: number;
  last_active_at: string | null;
  cost_usd: number;
  cache_hit_rate: number | null;
  tokens: TokenTotals;
  rate: RateMetrics;
}

export interface ModelRateRow {
  source: string;
  model: string;
  active_sessions: number;
  total_sessions: number;
  cost_usd: number;
  tokens: TokenTotals;
  rate: RateMetrics;
}

export interface TokenRateResponse {
  generated_at: string;
  active_window_minutes: number;
  summary: {
    running_project_count: number;
    running_session_count: number;
    total_project_count: number;
    output_tokens_per_second: number | null;
    latest_tokens_per_second: number | null;
    peak_tokens_per_second: number | null;
    total_tokens_per_second: number | null;
    tokens_per_minute: number;
    first_response_ms: number | null;
    sample_count: number;
  };
  projects: ProjectRateRow[];
  by_provider: ProviderRateRow[];
  by_model: ModelRateRow[];
}

export interface GetTokenRateOptions {
  activeMinutes?: number;
  recentMinutes?: number;
  refresh?: boolean;
}

function buildMockTokenRate(activeMinutes = 15): TokenRateResponse {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  return {
    generated_at: nowIso,
    active_window_minutes: activeMinutes,
    summary: {
      running_project_count: 2,
      running_session_count: 2,
      total_project_count: 3,
      output_tokens_per_second: 52.4,
      latest_tokens_per_second: 58.6,
      peak_tokens_per_second: 84.2,
      total_tokens_per_second: 1420.5,
      tokens_per_minute: 18450,
      first_response_ms: 1240,
      sample_count: 42,
    },
    projects: [
      {
        project_id: "mock-token-monitor",
        project_key: "token-monitor",
        project_ref: "/workspace/token-monitor",
        status: "running",
        active_session_count: 1,
        session_count: 3,
        sources: ["antigravity", "claude"],
        models: ["claude-opus-4-6-thinking", "claude-sonnet-4-6"],
        primary_source: "antigravity",
        primary_model: "claude-opus-4-6-thinking",
        latest_title: "Adapt token rate calculator for CodeBuddy and Antigravity",
        last_active_at: nowIso,
        started_at: new Date(nowMs - 25 * 60_000).toISOString(),
        duration_ms: 18 * 60_000,
        turns: 14,
        tool_calls: 36,
        cost_usd: 2.48,
        cache_hit_rate: 92.4,
        tokens: {
          input_tokens: 95000,
          cached_input_tokens: 1150000,
          cache_creation_input_tokens: 0,
          output_tokens: 28400,
          reasoning_output_tokens: 4200,
          total_tokens: 1277600,
        },
        rate: {
          output_tokens_per_second: 64.2,
          latest_tokens_per_second: 71.5,
          peak_tokens_per_second: 84.2,
          total_tokens_per_second: 2540.0,
          tokens_per_minute: 12400,
          estimated_output_tokens: 32600,
          estimated_duration_ms: 507800,
          estimated_request_count: 24,
          first_response_ms: 1120,
          first_response_sample_count: 24,
        },
        samples: [
          { timestamp_ms: nowMs - 180000, model: "claude-opus-4-6-thinking", source: "antigravity", output_tokens: 820, total_tokens: 48000, duration_ms: 13200, tokens_per_second: 62.1, total_tokens_per_second: 3636.4 },
          { timestamp_ms: nowMs - 120000, model: "claude-opus-4-6-thinking", source: "antigravity", output_tokens: 1240, total_tokens: 52000, duration_ms: 16800, tokens_per_second: 73.8, total_tokens_per_second: 3095.2 },
          { timestamp_ms: nowMs - 60000, model: "claude-opus-4-6-thinking", source: "antigravity", output_tokens: 960, total_tokens: 55000, duration_ms: 11400, tokens_per_second: 84.2, total_tokens_per_second: 4824.6 },
          { timestamp_ms: nowMs - 15000, model: "claude-opus-4-6-thinking", source: "antigravity", output_tokens: 715, total_tokens: 58000, duration_ms: 10000, tokens_per_second: 71.5, total_tokens_per_second: 5800.0 },
        ],
        sessions: [
          {
            session_hash: "mock-ag-1",
            session_id: "8a1125a2-8d1b-48ca-88ad-5d8d7a8e02a8",
            title: "Adapt token rate calculator for CodeBuddy and Antigravity",
            source: "antigravity",
            model: "claude-opus-4-6-thinking",
            status: "running",
            process_alive: true,
            pid: null,
            run_status: "CASCADE_RUN_STATUS_RUNNING",
            last_active_at: nowIso,
            started_at: new Date(nowMs - 25 * 60_000).toISOString(),
            ended_at: nowIso,
            duration_ms: 18 * 60_000,
            turns: 14,
            tool_calls: 36,
            cost_usd: 2.48,
            tokens: {
              input_tokens: 95000,
              cached_input_tokens: 1150000,
              cache_creation_input_tokens: 0,
              output_tokens: 28400,
              reasoning_output_tokens: 4200,
              total_tokens: 1277600,
            },
            rate: {
              output_tokens_per_second: 64.2,
              latest_tokens_per_second: 71.5,
              peak_tokens_per_second: 84.2,
              total_tokens_per_second: 2540.0,
              tokens_per_minute: 12400,
              estimated_output_tokens: 32600,
              estimated_duration_ms: 507800,
              estimated_request_count: 24,
              first_response_ms: 1120,
              first_response_sample_count: 24,
            },
          },
        ],
      },
      {
        project_id: "mock-codebuddy-proj",
        project_key: "iRead 试卷转换",
        project_ref: "/workspace/iRead 试卷转换",
        status: "running",
        active_session_count: 1,
        session_count: 2,
        sources: ["codebuddy"],
        models: ["glm-5.1"],
        primary_source: "codebuddy",
        primary_model: "glm-5.1",
        latest_title: "批量试卷解析与 Word 排版转换",
        last_active_at: new Date(nowMs - 45_000).toISOString(),
        started_at: new Date(nowMs - 90 * 60_000).toISOString(),
        duration_ms: 42 * 60_000,
        turns: 28,
        tool_calls: 85,
        cost_usd: 1.92,
        cache_hit_rate: 88.7,
        tokens: {
          input_tokens: 180000,
          cached_input_tokens: 1420000,
          cache_creation_input_tokens: 0,
          output_tokens: 21500,
          reasoning_output_tokens: 0,
          total_tokens: 1621500,
        },
        rate: {
          output_tokens_per_second: 38.4,
          latest_tokens_per_second: 42.1,
          peak_tokens_per_second: 56.0,
          total_tokens_per_second: 1180.2,
          tokens_per_minute: 6050,
          estimated_output_tokens: 21500,
          estimated_duration_ms: 559895,
          estimated_request_count: 18,
          first_response_ms: 1400,
          first_response_sample_count: 18,
        },
        samples: [
          { timestamp_ms: nowMs - 240000, model: "glm-5.1", source: "codebuddy", output_tokens: 640, total_tokens: 38000, duration_ms: 18200, tokens_per_second: 35.2, total_tokens_per_second: 2087.9 },
          { timestamp_ms: nowMs - 150000, model: "glm-5.1", source: "codebuddy", output_tokens: 890, total_tokens: 42000, duration_ms: 21500, tokens_per_second: 41.4, total_tokens_per_second: 1953.5 },
          { timestamp_ms: nowMs - 45000, model: "glm-5.1", source: "codebuddy", output_tokens: 720, total_tokens: 46000, duration_ms: 17100, tokens_per_second: 42.1, total_tokens_per_second: 2690.1 },
        ],
        sessions: [
          {
            session_hash: "mock-cb-1",
            session_id: "01a1ec69-13f0-78b1-86d0-db232459021b",
            title: "批量试卷解析与 Word 排版转换",
            source: "codebuddy",
            model: "glm-5.1",
            status: "running",
            process_alive: true,
            pid: 46940,
            run_status: null,
            last_active_at: new Date(nowMs - 45_000).toISOString(),
            started_at: new Date(nowMs - 90 * 60_000).toISOString(),
            ended_at: new Date(nowMs - 45_000).toISOString(),
            duration_ms: 42 * 60_000,
            turns: 28,
            tool_calls: 85,
            cost_usd: 1.92,
            tokens: {
              input_tokens: 180000,
              cached_input_tokens: 1420000,
              cache_creation_input_tokens: 0,
              output_tokens: 21500,
              reasoning_output_tokens: 0,
              total_tokens: 1621500,
            },
            rate: {
              output_tokens_per_second: 38.4,
              latest_tokens_per_second: 42.1,
              peak_tokens_per_second: 56.0,
              total_tokens_per_second: 1180.2,
              tokens_per_minute: 6050,
              estimated_output_tokens: 21500,
              estimated_duration_ms: 559895,
              estimated_request_count: 18,
              first_response_ms: 1400,
              first_response_sample_count: 18,
            },
          },
        ],
      },
    ],
    by_provider: [
      {
        source: "antigravity",
        active_sessions: 1,
        total_sessions: 3,
        active_projects: 1,
        total_projects: 1,
        last_active_at: nowIso,
        cost_usd: 2.48,
        cache_hit_rate: 92.4,
        tokens: {
          input_tokens: 95000,
          cached_input_tokens: 1150000,
          cache_creation_input_tokens: 0,
          output_tokens: 28400,
          reasoning_output_tokens: 4200,
          total_tokens: 1277600,
        },
        rate: {
          output_tokens_per_second: 64.2,
          latest_tokens_per_second: 71.5,
          peak_tokens_per_second: 84.2,
          total_tokens_per_second: 2540.0,
          estimated_output_tokens: 32600,
          estimated_duration_ms: 507800,
          estimated_request_count: 24,
          first_response_ms: 1120,
          first_response_sample_count: 24,
        },
      },
      {
        source: "codebuddy",
        active_sessions: 1,
        total_sessions: 2,
        active_projects: 1,
        total_projects: 1,
        last_active_at: new Date(nowMs - 45_000).toISOString(),
        cost_usd: 1.92,
        cache_hit_rate: 88.7,
        tokens: {
          input_tokens: 180000,
          cached_input_tokens: 1420000,
          cache_creation_input_tokens: 0,
          output_tokens: 21500,
          reasoning_output_tokens: 0,
          total_tokens: 1621500,
        },
        rate: {
          output_tokens_per_second: 38.4,
          latest_tokens_per_second: 42.1,
          peak_tokens_per_second: 56.0,
          total_tokens_per_second: 1180.2,
          estimated_output_tokens: 21500,
          estimated_duration_ms: 559895,
          estimated_request_count: 18,
          first_response_ms: 1400,
          first_response_sample_count: 18,
        },
      },
    ],
    by_model: [
      {
        source: "antigravity",
        model: "claude-opus-4-6-thinking",
        active_sessions: 1,
        total_sessions: 3,
        cost_usd: 2.48,
        tokens: {
          input_tokens: 95000,
          cached_input_tokens: 1150000,
          cache_creation_input_tokens: 0,
          output_tokens: 28400,
          reasoning_output_tokens: 4200,
          total_tokens: 1277600,
        },
        rate: {
          output_tokens_per_second: 64.2,
          latest_tokens_per_second: 71.5,
          peak_tokens_per_second: 84.2,
          total_tokens_per_second: 2540.0,
          estimated_output_tokens: 32600,
          estimated_duration_ms: 507800,
          estimated_request_count: 24,
          first_response_ms: 1120,
          first_response_sample_count: 24,
        },
      },
      {
        source: "codebuddy",
        model: "glm-5.1",
        active_sessions: 1,
        total_sessions: 2,
        cost_usd: 1.92,
        tokens: {
          input_tokens: 180000,
          cached_input_tokens: 1420000,
          cache_creation_input_tokens: 0,
          output_tokens: 21500,
          reasoning_output_tokens: 0,
          total_tokens: 1621500,
        },
        rate: {
          output_tokens_per_second: 38.4,
          latest_tokens_per_second: 42.1,
          peak_tokens_per_second: 56.0,
          total_tokens_per_second: 1180.2,
          estimated_output_tokens: 21500,
          estimated_duration_ms: 559895,
          estimated_request_count: 18,
          first_response_ms: 1400,
          first_response_sample_count: 18,
        },
      },
    ],
  };
}

export async function getTokenRate(options: GetTokenRateOptions = {}): Promise<TokenRateResponse> {
  if (isMockEnabled()) {
    return buildMockTokenRate(options.activeMinutes);
  }
  const url = new URL(`/functions/${SLUG}`, window.location.origin);
  if (options.activeMinutes) {
    url.searchParams.set("active_minutes", String(options.activeMinutes));
  }
  if (options.recentMinutes) {
    url.searchParams.set("recent_minutes", String(options.recentMinutes));
  }
  if (options.refresh) {
    url.searchParams.set("refresh", "1");
  }
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const fallback =
      response.status === 404
        ? copy("sessions.error.outdated_app")
        : copy("rate.error.load_failed");
    const err = new Error(payload?.error || fallback) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
  return payload as TokenRateResponse;
}
