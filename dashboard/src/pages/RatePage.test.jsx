import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RatePage } from "./RatePage.jsx";
import { TokenFormatProvider } from "../ui/foundation/TokenFormatProvider.jsx";

const mockGetTokenRate = vi.fn();

vi.mock("../lib/rate-api", () => {
  return {
    getTokenRate: (...args) => {
      return mockGetTokenRate(...args);
    },
  };
});

vi.mock("../lib/mock-data", () => {
  return {
    isMockEnabled: () => {
      return false;
    },
  };
});

vi.mock("../lib/host-mode", () => {
  return {
    isLocalDashboardHost: () => {
      return true;
    },
  };
});

vi.mock("../components/LocalOnlyNotice.jsx", () => {
  return {
    LocalOnlyNotice: () => {
      return <div>{"LocalOnlyNotice"}</div>;
    },
  };
});

vi.mock("../hooks/useCurrency", () => {
  return {
    useCurrency: () => {
      return { currency: "USD", rate: 1 };
    },
  };
});

vi.mock("../ui/components/Toast.jsx", () => {
  return {
    showToast: vi.fn(),
  };
});

vi.mock("../hooks/useLocale.js", () => {
  return {
    useLocale: () => {
      return { resolvedLocale: "zh" };
    },
  };
});

vi.mock("../lib/copy", () => {
  return {
    copy: (key, vars = {}) => {
      if (key === "shared.unit.thousand_abbrev") return "K";
      if (key === "shared.unit.million_abbrev") return "M";
      if (key === "shared.unit.billion_abbrev") return "B";
      if (key === "shared.unit.trillion_abbrev") return "T";
      if (key === "rate.summary.output_speed_sub") {
        return `Avg ${vars.avg} · Peak ${vars.peak}`;
      }
      if (key === "rate.section.projects_count") {
        return `${vars.count} projects`;
      }
      if (key === "rate.session.native_rate") return `${vars.value} tok/s · OpenCode`;
      if (key === "rate.project.e2e_estimate") return `End-to-end estimate ${vars.value} ${vars.unit}`;
      if (key === "rate.unit.tps") return "tokens/sec";
      return key;
    },
  };
});

const SAMPLE_RESPONSE = {
  generated_at: "2026-11-18T12:00:00.000Z",
  active_window_minutes: 15,
  summary: {
    running_project_count: 2,
    running_session_count: 2,
    total_project_count: 2,
    output_tokens_per_second: 50.0,
    latest_tokens_per_second: 62.5,
    peak_tokens_per_second: 80.0,
    total_tokens_per_second: 1400.0,
    tokens_per_minute: 9500,
    first_response_ms: 950,
    sample_count: 10,
  },
  projects: [
    {
      project_id: "proj-cb",
      project_key: "iread-converter",
      project_ref: "E:\\Codex-bulid\\iread-converter",
      status: "running",
      active_session_count: 1,
      session_count: 1,
      sources: ["codebuddy"],
      models: ["glm-5.1"],
      primary_source: "codebuddy",
      primary_model: "glm-5.1",
      latest_title: "Convert exams",
      last_active_at: "2026-11-18T11:59:50.000Z",
      started_at: "2026-11-18T11:30:00.000Z",
      duration_ms: 1800000,
      turns: 8,
      tool_calls: 20,
      cost_usd: 0.45,
      cache_hit_rate: 88.2,
      tokens: {
        input_tokens: 10000,
        cached_input_tokens: 75000,
        cache_creation_input_tokens: 0,
        output_tokens: 3200,
        reasoning_output_tokens: 0,
        total_tokens: 88200,
      },
      rate: {
        output_tokens_per_second: 35.4,
        latest_tokens_per_second: 38.2,
        peak_tokens_per_second: 49.0,
        total_tokens_per_second: 980.0,
        tokens_per_minute: 4200,
        estimated_output_tokens: 3200,
        estimated_duration_ms: 90395,
        estimated_request_count: 6,
        first_response_ms: 1100,
        first_response_sample_count: 6,
      },
      samples: [
        {
          timestamp_ms: 1763467100000,
          model: "glm-5.1",
          source: "codebuddy",
          output_tokens: 500,
          total_tokens: 12000,
          duration_ms: 13000,
          tokens_per_second: 38.2,
          total_tokens_per_second: 923.0,
        },
      ],
      sessions: [
        {
          session_hash: "cb-hash-1",
          session_id: "cb-sid-1",
          title: "Convert exams",
          source: "codebuddy",
          model: "glm-5.1",
          status: "running",
          process_alive: true,
          pid: 46940,
          run_status: null,
          last_active_at: "2026-11-18T11:59:50.000Z",
          started_at: "2026-11-18T11:30:00.000Z",
          ended_at: "2026-11-18T11:59:50.000Z",
          duration_ms: 1800000,
          turns: 8,
          tool_calls: 20,
          cost_usd: 0.45,
          tokens: {
            input_tokens: 10000,
            cached_input_tokens: 75000,
            cache_creation_input_tokens: 0,
            output_tokens: 3200,
            reasoning_output_tokens: 0,
            total_tokens: 88200,
          },
          rate: {
            output_tokens_per_second: 35.4,
            latest_tokens_per_second: 38.2,
            peak_tokens_per_second: 49.0,
            total_tokens_per_second: 977.0,
            tokens_per_minute: 4200,
            estimated_output_tokens: 3200,
            estimated_duration_ms: 90395,
            estimated_request_count: 6,
            first_response_ms: 1100,
            first_response_sample_count: 6,
          },
        },
      ],
    },
    {
      project_id: "proj-ag",
      project_key: "token-monitor",
      project_ref: "E:\\token-monitor",
      status: "running",
      active_session_count: 1,
      session_count: 1,
      sources: ["antigravity"],
      models: ["claude-opus-4-6-thinking"],
      primary_source: "antigravity",
      primary_model: "claude-opus-4-6-thinking",
      latest_title: "Rate page adaptation",
      last_active_at: "2026-11-18T11:59:59.000Z",
      started_at: "2026-11-18T11:40:00.000Z",
      duration_ms: 1200000,
      turns: 5,
      tool_calls: 12,
      cost_usd: 0.92,
      cache_hit_rate: 91.5,
      tokens: {
        input_tokens: 8000,
        cached_input_tokens: 92000,
        cache_creation_input_tokens: 0,
        output_tokens: 4100,
        reasoning_output_tokens: 900,
        total_tokens: 105000,
      },
      rate: {
        output_tokens_per_second: 65.0,
        latest_tokens_per_second: 74.0,
        peak_tokens_per_second: 80.0,
        total_tokens_per_second: 1850.0,
        tokens_per_minute: 5300,
        estimated_output_tokens: 5000,
        estimated_duration_ms: 76923,
        estimated_request_count: 4,
        first_response_ms: 800,
        first_response_sample_count: 4,
      },
      samples: [],
      sessions: [],
    },
  ],
  by_provider: [
    {
      source: "codebuddy",
      active_sessions: 1,
      total_sessions: 1,
      active_projects: 1,
      total_projects: 1,
      last_active_at: "2026-11-18T11:59:50.000Z",
      cost_usd: 0.45,
      cache_hit_rate: 88.2,
      tokens: {
        input_tokens: 10000,
        cached_input_tokens: 75000,
        cache_creation_input_tokens: 0,
        output_tokens: 3200,
        reasoning_output_tokens: 0,
        total_tokens: 88200,
      },
      rate: {
        output_tokens_per_second: 35.4,
        latest_tokens_per_second: 38.2,
        peak_tokens_per_second: 49.0,
        total_tokens_per_second: 980.0,
        estimated_output_tokens: 3200,
        estimated_duration_ms: 90395,
        estimated_request_count: 6,
        first_response_ms: 1100,
        first_response_sample_count: 6,
      },
    },
    {
      source: "antigravity",
      active_sessions: 1,
      total_sessions: 1,
      active_projects: 1,
      total_projects: 1,
      last_active_at: "2026-11-18T11:59:59.000Z",
      cost_usd: 0.92,
      cache_hit_rate: 91.5,
      tokens: {
        input_tokens: 8000,
        cached_input_tokens: 92000,
        cache_creation_input_tokens: 0,
        output_tokens: 4100,
        reasoning_output_tokens: 900,
        total_tokens: 105000,
      },
      rate: {
        output_tokens_per_second: 65.0,
        latest_tokens_per_second: 74.0,
        peak_tokens_per_second: 80.0,
        total_tokens_per_second: 1850.0,
        estimated_output_tokens: 5000,
        estimated_duration_ms: 76923,
        estimated_request_count: 4,
        first_response_ms: 800,
        first_response_sample_count: 4,
      },
    },
  ],
  by_model: [],
};

describe("RatePage", () => {
  beforeEach(() => {
    mockGetTokenRate.mockReset();
    mockGetTokenRate.mockResolvedValue(SAMPLE_RESPONSE);
  });

  it("shows OpenCode's native rate in the session and keeps fallback estimates labeled", async () => {
    const project = structuredClone(SAMPLE_RESPONSE.projects[0]);
    project.rate.end_to_end_tokens_per_second = 10.9;
    project.rate.end_to_end_estimated = true;
    Object.assign(project.sessions[0].rate, {
      native_tokens_per_second: 113.4,
      native_source: "opencode_api",
      output_tokens_per_second: 111.3,
    });
    mockGetTokenRate.mockResolvedValue({ ...SAMPLE_RESPONSE, projects: [project] });
    render(<RatePage />);

    const native = await screen.findByText("113.4 tok/s · OpenCode");
    expect(native).toHaveAttribute("title", "rate.session.native_api");
    expect(screen.getByText("End-to-end estimate 10.9 tokens/sec")).toBeInTheDocument();
  });

  it("renders running CodeBuddy and Antigravity projects without PID, filters by provider, and follows settings Wan/Yi units", async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    const { unmount } = render(
      <TokenFormatProvider>
        <RatePage />
      </TokenFormatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("iread-converter")).toBeInTheDocument();
      expect(screen.getByText("token-monitor")).toBeInTheDocument();
    });

    expect(screen.getByText("2 projects")).toBeInTheDocument();
    expect(screen.queryByText(/46940/)).not.toBeInTheDocument();
    expect(screen.queryByText(/977/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "settings.appearance.token_unit.chinese" })).not.toBeInTheDocument();
    // Compact English units by default (88,200 to 88.2K, 105,000 to 105K)
    expect(screen.getAllByText(/88\.2K/).length).toBeGreaterThan(0);

    unmount();

    // Follows Settings: Token unit system = chinese (Wan/Yi)
    window.localStorage.setItem("tt.tokenUnitSystem", "chinese");
    render(
      <TokenFormatProvider>
        <RatePage />
      </TokenFormatProvider>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/8\.8万/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/10\.5万/).length).toBeGreaterThan(0);
    });

    const antigravityFilterBtn = screen.getAllByRole("button", { name: "Antigravity" })[0];
    await user.click(antigravityFilterBtn);

    expect(screen.queryByText("iread-converter")).not.toBeInTheDocument();
    expect(screen.getByText("token-monitor")).toBeInTheDocument();
    expect(screen.getByText("1 projects")).toBeInTheDocument();
  });
});
