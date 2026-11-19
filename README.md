<div align="center">

# Token Monitor

**fredqin2006-X/token-monitor**

基于 [xiufengsun/TokenTracker](https://github.com/xiufengsun/TokenTracker) 维护的自用增强分支 —— 在本地优先的多工具 AI Token 与成本监控基础上，新增实时**速率（Rate）**监控、**CodeBuddy / Antigravity** 会话与流式计时扩展、同源隧道访问支持及 Windows 后台运维脚本。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node >= 20](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Upstream](https://img.shields.io/badge/Upstream-xiufengsun%2FTokenTracker-blue?logo=github)](https://github.com/xiufengsun/TokenTracker)

</div>

---

## 与上游的关系

本仓库是从上游 [`xiufengsun/TokenTracker`](https://github.com/xiufengsun/TokenTracker) Fork 并持续合并上游更新的维护分支（`origin` 为 `fredqin2006-X/token-monitor`，`upstream` 为 `xiufengsun/TokenTracker`）。

- **保留能力**：继承上游本地日志解析、47 AI coding tools 采集、模型定价与成本计算、使用限额监控、服务状态页、成就系统及桌面/Web Dashboard。
- **核心增强**：聚焦于**实时 Token 生成速率监控**、**CodeBuddy / Antigravity 深度会话与流式计时**、**Cloudflare Tunnel / 反向代理同源访问**以及 **Windows 本地无人值守启动**。
- **使用方式**：本 Fork 的新增功能通过当前仓库源码构建与运行；上游的 npm 全局包、Homebrew、DMG/EXE/AppImage 发行版不包含本分支定制改动。

---

## 相对上游的改动清单

### 1. 新增「速率（Rate）」实时监控页面与本地 API

- **前端页面与导航**：
  - 新增 [`dashboard/src/pages/RatePage.jsx`](dashboard/src/pages/RatePage.jsx) 与请求封装 [`dashboard/src/lib/rate-api.ts`](dashboard/src/lib/rate-api.ts)，在 [`dashboard/src/App.jsx`](dashboard/src/App.jsx) 注册 `/rate` 路由，并在 [`dashboard/src/ui/components/Sidebar.jsx`](dashboard/src/ui/components/Sidebar.jsx) 加入「速率（Rate）」导航入口。
  - 补充完整多语言文案与单位同步：更新 [`dashboard/src/content/copy.csv`](dashboard/src/content/copy.csv) 及 `zh` / `zh-TW` 语言包（`core.json`、`dashboard.json`）。
- **监控维度与交互能力**：
  - 按**项目（Projects）**、**会话（Sessions）**、**工具（By Provider）**、**模型（By Model）** 四层聚合展示实时状态（`running` / `recent` / `idle`）。
  - 展示**流式输出速率**（当前 / 平均 / 峰值 `tok/s`）、**上下文吞吐速率**（`total_tokens_per_second`）、**窗口消耗速率**（`tokens/min`）、**首 Token 延迟（TTFT）**、**缓存命中率**与**估算费用**。
  - 支持 **5 秒自动轮询与暂停**、手动刷新、活跃时间窗口切换（`5m` / `15m` / `60m`）、状态筛选、工具筛选与关键字搜索。
  - 会话列表遵循「设置」中的 Token 显示单位；缺少流式计时的请求显示 `—`，但仍计入 Token 用量、窗口消耗与费用。
- **后端引擎与接口**：
  - 新增 [`src/lib/token-rate.js`](src/lib/token-rate.js)（导出 `computeProjectTokenRates` 等聚合函数）。
  - 在 [`src/lib/local-api.js`](src/lib/local-api.js) 新增 `GET /functions/tokentracker-token-rate` 本地端点，支持 `active_minutes`（默认 `15`，上限 `1440`）、`recent_minutes`（默认 `1440`，上限 `10080`）与 `refresh=1|true` 参数。

### 2. 扩展 CodeBuddy 与 Antigravity 会话统计及流式计时

- **CodeBuddy 精确流式计时与会话分析**：
  - 新增 [`src/lib/codebuddy-stream-timing.js`](src/lib/codebuddy-stream-timing.js)（`readCodebuddyStreamTimings`），扫描 CodeBuddy 运行日志中的 `First meaningful token received`（`ttft`）与 `finish_reason="..." received, starting grace period`（`elapsed`），按 `pid:requestId` 配对计算流式输出时长，排除工具调度与请求间空闲等待。
  - 在 [`src/lib/token-rate.js`](src/lib/token-rate.js) 与 [`src/lib/session-analytics.js`](src/lib/session-analytics.js) 中接入 `scanCodebuddySession`、活跃进程（PID）存活判定、工具调用与编辑工具统计，以及 `codebuddy --resume <id>` 会话恢复命令。
- **Antigravity Protobuf 流式计时与会话分析**：
  - 扩展 [`src/lib/rollout.js`](src/lib/rollout.js) 中的 `extractAntigravityGenInfo`，解析对话数据库 protobuf 字段 `11`（`timeToFirstTokenMs`）与字段 `12`（`streamingDurationMs`）。
  - 在 [`src/lib/session-performance.js`](src/lib/session-performance.js) 新增 `createStreamingPerformanceCollector` 与 `createAntigravityPerformanceCollector`。
  - 在 [`src/lib/session-analytics.js`](src/lib/session-analytics.js) 接入 `scanAntigravitySession` 及对应 `.db` / `-wal` 缓存键检测。
- **会话浏览页与图标适配**：
  - 在 [`dashboard/src/pages/SessionsPage.jsx`](dashboard/src/pages/SessionsPage.jsx)、[`dashboard/src/lib/sessions-api.ts`](dashboard/src/lib/sessions-api.ts)、[`dashboard/src/lib/sessions-insights.js`](dashboard/src/lib/sessions-insights.js) 与 [`dashboard/src/lib/provider-display.js`](dashboard/src/lib/provider-display.js) 中加入 `codebuddy` 与 `antigravity` 来源支持与筛选。
  - 优化 [`dashboard/src/ui/dashboard/components/ProviderIcon.jsx`](dashboard/src/ui/dashboard/components/ProviderIcon.jsx) 中 CodeBuddy SVG `viewBox` 与图标 `shrink-0` 对齐。

### 3. 同源隧道 / 反向代理自托管访问支持

- **后端 Origin 白名单与运行时下发**：
  - 在 [`src/lib/local-api.js`](src/lib/local-api.js) 中扩展 `hasAllowedLoopbackOrigin`，读取环境变量 `TOKENTRACKER_ALLOWED_ORIGINS`（逗号分隔的 Origin 列表）放行指定远程域名请求。
  - `/api/runtime-config.js` 自动提取允许域名并注入 `window.__TOKENTRACKER_RUNTIME_CONFIG__.localHosts`。
- **前端统一本地模式判定**：
  - 在 [`dashboard/src/lib/host-mode.ts`](dashboard/src/lib/host-mode.ts) 扩展 `isLocalDashboardHost()`，除 `localhost` / `127.0.0.1` / `::1` / `[::1]` 外，同时识别运行时配置的 `localHosts`。
  - 将原先硬编码判断 `localhost` / `127.0.0.1` 的模块统一收敛到 `isLocalDashboardHost()`（涵盖 `App.jsx`、`api.ts`、`config.ts`、`auth-token.js`、`insforge-config.ts`、`cloud-sync-prefs.ts`、各数据 Hooks、`DashboardPage.jsx`、`LimitsPage.jsx`、`SkillsPage.jsx`、`IpCheckPage.jsx`、`CommandPalette.jsx`、`MarketingLanding.jsx`），使通过 Cloudflare Tunnel 或内网反代域名访问时可直接走同源本地 API。

### 4. Windows 远程访问与后台启动脚本

- [`start-remote.ps1`](start-remote.ps1)：前台联动启动 Cloudflare Tunnel 与本地 `7681` 端口 Dashboard（自动注入 `TOKENTRACKER_APP_SHELL=windows` 与 `TOKENTRACKER_ALLOWED_ORIGINS`），退出时自动回收隧道进程。
- [`start-dashboard-bg.ps1`](start-dashboard-bg.ps1)、[`start-cloudflared-bg.ps1`](start-cloudflared-bg.ps1) 与 [`launch-autostart.vbs`](launch-autostart.vbs)：用于 Windows 隐藏窗口后台启动 Dashboard 服务及 Cloudflare Tunnel，日志写入 `~/.tokentracker/logs/`。

### 5. 构建配置、测试补充与 Fork 维护规范

- **TypeScript 构建兼容**：[`dashboard/tsconfig.json`](dashboard/tsconfig.json) 启用 `allowImportingTsExtensions: true`。
- **新增与修复测试**：
  - 新增 [`test/token-rate.test.js`](test/token-rate.test.js) 与 [`dashboard/src/pages/RatePage.test.jsx`](dashboard/src/pages/RatePage.test.jsx)，覆盖速率计算、CodeBuddy/Antigravity 流式计时与速率页面渲染交互。
  - 修复 [`test/antigravity-discovery.test.js`](test/antigravity-discovery.test.js) 在 Windows 下使用 `junction` 创建目录链接，以及 [`test/session-analytics-dsh.test.js`](test/session-analytics-dsh.test.js) 动态校验 sidecar 版本号。
- **维护文档**：新增 [`docs/fork-maintenance.md`](docs/fork-maintenance.md) 并在 [`CLAUDE.md`](CLAUDE.md) 补充 Fork 提交同步与上游合并规范。

---

## 本地运行与部署

> **环境要求**：Node.js **20+**（Windows / macOS / Linux 均可运行 CLI 与 Web Dashboard；如需使用远程隧道脚本需额外安装 `cloudflared`）。

### 1. 从源码构建并启动

```bash
git clone https://github.com/fredqin2006-X/token-monitor.git
cd token-monitor

# 安装根依赖与前端依赖
npm install
cd dashboard && npm install && npm run build && cd ..

# 同步数据并启动本地 Dashboard（默认 :7680，可按需指定端口）
node bin/tracker.js serve
```

仅调试本地接口或跳过首次自动打开浏览器/同步时：

```bash
node bin/tracker.js serve --port 7681 --no-open --no-sync
```

### 2. 通过同源域名 / Cloudflare Tunnel 远程访问

当通过反向代理或 Cloudflare Tunnel（例如 `https://your-domain.example`）访问本机 Dashboard 时，在启动服务前设置 `TOKENTRACKER_ALLOWED_ORIGINS`（多个域名用英文逗号分隔）：

```powershell
$env:TOKENTRACKER_ALLOWED_ORIGINS = "https://your-domain.example"
node bin/tracker.js serve --port 7681 --no-open
```

Windows 下也可直接使用仓库内的脚本：

- 前台联动启动（Dashboard + Cloudflare Tunnel）：`.\start-remote.ps1`（需先将 Tunnel Token 保存至 `$env:USERPROFILE\.cloudflared_tokenmonitor_token`）。
- 后台无窗口启动：`wscript.exe launch-autostart.vbs`（调用 `start-dashboard-bg.ps1` 与 `start-cloudflared-bg.ps1`；使用前请按本机路径和域名核对脚本中的变量）。

---

## 开发与验证

常用测试与检查命令：

```bash
# 速率计算与性能统计单元测试
node --test test/token-rate.test.js test/session-performance.test.js

# 速率页前端组件测试
npm --prefix dashboard test -- src/pages/RatePage.test.jsx

# 完整本地测试、文案/国际化校验与前端构建
npm run ci:local
```

关于从 `upstream/main` 同步上游更新、解决冲突及提交推送规范，请参考 [维护文档（docs/fork-maintenance.md）](./docs/fork-maintenance.md) 与 [CLAUDE.md](./CLAUDE.md)。

---

## 继承自上游的基础能力（TokenTracker）

除上述 Fork 新增改动外，本项目完整保留了上游 [`xiufengsun/TokenTracker`](https://github.com/xiufengsun/TokenTracker) 的本地优先采集与分析体系：

| 能力维度 | 本 Fork（token-monitor） |
|---|---|
| **AI tools supported** | **47**（涵盖主流 AI 编程 CLI、IDE 与桌面 Agent） |
| **Rate-limit tracking** | ✅ 18 providers（本地凭据直连查询与缓存回退） |
| **本地优先与隐私** | 仅读取 Token 计数、时间戳、模型名与计时指标，不上传 Prompt 与代码内容 |
| **多维度分析** | 用量趋势、模型/项目成本归因、GitHub 风格热力图、会话浏览器、服务状态、可选云端同步与排行榜 |

<details>
<summary><b>支持的工具清单与常用路径覆盖环境变量（上游基础能力参考）</b></summary>

<br/>

- **主要支持工具**：Claude Code、Codex CLI、AStudio、Cursor、Gemini CLI、Antigravity、Kiro、OpenCode、OpenSquilla、OpenClaw、Every Code、Hermes Agent、GitHub Copilot、Kimi Code、CodeBuddy、WorkBuddy、WorkBuddy AI、Grok Build、oh-my-pi、OmO、pi、Dots、Prime Agent、Craft Agents、Reasonix、Muse Code、Kilo CLI、Kilo Code、Roo Code、Zed Agent、Goose、Droid、Mimo Code、DuMate、ZCode、Qoder、AnythingLLM Desktop、Claude Science、DeepSeek Harness、TRAE、TRAE Work CN、LM Studio、Unsloth Studio、Devin CLI、Cline、MiniMax Code、Command Code。
- **常用环境变量**：
  - `TOKENTRACKER_ALLOWED_ORIGINS`：本 Fork 新增，允许同源访问本地 Dashboard 的远程 Origin（逗号分隔）
  - `TOKENTRACKER_NO_TELEMETRY=1` / `DO_NOT_TRACK=1`：关闭匿名遥测
  - `TOKENTRACKER_WSL_MODE`：Windows 下 WSL 扫描模式（`wsl-first` / `native-first` / `wsl-only` / `native-only` / `both`）
  - `TOKENTRACKER_ACODE_HOME`（AStudio 目录覆盖）、`TOKENTRACKER_DUMATE_HOME`（DuMate 目录覆盖）、`TOKENTRACKER_LMSTUDIO_HOME`（LM Studio 目录覆盖）、`TOKENTRACKER_UNSLOTH_DB`（Unsloth Studio 数据库覆盖）、`TOKENTRACKER_DEVIN_DB`（Devin CLI 数据库覆盖）

</details>

---

## 致谢与协议

- 上游原项目：[xiufengsun/TokenTracker](https://github.com/xiufengsun/TokenTracker)
- 开源协议：[MIT](LICENSE)
