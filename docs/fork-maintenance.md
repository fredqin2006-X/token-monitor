# Token Monitor 维护文档

项目约定以 [CLAUDE.md](../CLAUDE.md) 为准。`origin` 是维护仓库 [fredqin2006-X/token-monitor](https://github.com/fredqin2006-X/token-monitor)，`upstream` 是 [xiufengsun/TokenTracker](https://github.com/xiufengsun/TokenTracker)。日常同步目标为 `origin/main`。

## 每次修改都提交并同步

1. 开始前运行 `git status --short --branch` 和 `git remote -v`，确认分支、远端和已有本地改动。
2. 完成修改后运行与改动相关的测试和构建。用 `git diff --check` 检查补丁，再逐个暂存本次涉及的文件。运行 `git diff --cached` 确认提交范围。凭据、私有日志和本地上传文件应留在工作区外或 Git 忽略范围内。
3. 用英文约定式提交信息执行本地 `git commit`。在 `main` 上执行 `git push origin HEAD:main`。维护工作需要使用单独分支时，先推送该分支到 `origin`，按项目流程合入 `main`。
4. 用 `git rev-parse HEAD` 与 `git ls-remote origin refs/heads/main` 核对提交 SHA。若推送被拒绝，先获取远端最新历史并合并、复测，再正常推送。禁止强推 `main`。日常源码同步使用分支推送，发布按 `CLAUDE.md` 的发行流程执行。

## 同步上游

在 `main` 获取两个远端的更新。合并前看左右分支各自独有的提交，工作区有重叠改动时先保护这些文件，再整合上游。使用合并提交保留本仓库的功能历史。

```bash
git fetch origin main
git fetch upstream main
git log --oneline --left-right HEAD...upstream/main
git merge upstream/main
git diff --stat upstream/main HEAD
```

合并后复查速率页入口、`tokentracker-token-rate` 本地接口、CodeBuddy 和 Antigravity 会话统计，以及同源访问。跑完相关验证，再按上面的流程提交后续改动并推送。

## 速率口径与验证

跨客户端比较采用 [vLLM 的 TPOT 定义](https://docs.vllm.ai/en/stable/benchmarking/cli/)。每个有效流式请求贡献 `生成 Token 数 − 1` 和首末 Token 间隔。平均值用两项各自求和后相除，近期值取最近三个完成样本，峰值取单请求最大值。速率页每 5 秒刷新完成样本。首 Token 延迟单独统计，并显示有该数据的样本数。

窗口吞吐用所选 5／15／60 分钟内记录的输入、缓存和生成用量除以窗口长度，包含缺少请求计时的数据。用量按已有分钟桶统计。只有请求起止时间时，卡片展示端到端输出速率，会话行显示数值。缺少相应计时时显示 `—`。 [NVIDIA AIPerf 指标口径](https://docs.nvidia.com/aiperf/v0.12.0/reference/ai-perf-metrics-reference)

| 本机客户端 | 采集来源 |
| --- | --- |
| OpenCode 2.3.2 | 优先读取官方本机 API 的消息计时与用量，服务不可用时使用 SQLite 同名字段。会话行按对应轮次复算 TUI 原生速率，跨客户端比较用 TPOT。 [OpenCode API](https://opencode.ai/docs/api) · [原生公式](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/util/src/session-turn.ts#L31-L50) |
| Codex 0.166.0 | App Server 提供线程用量和流事件。已在运行的独立会话从本机 rollout 读取可用的官方首 Token 字段，并用日志边界估算端到端输出速率。 [App Server 文档](https://developers.openai.com/codex/app-server/) |
| Claude Code 2.1.327 | 优先使用官方 OpenTelemetry 请求 span。所选时间窗内没有官方样本的会话使用 transcript 边界估算端到端输出速率。 [Claude Code 监控文档](https://code.claude.com/docs/en/monitoring-usage) |
| CodeBuddy 2.185.0 | 官方流输出适用于调用方启动的 print 模式。已有交互会话通过消息 ID 关联用量与本机日志，从首个有效 Token 计到输出结束标记。 [CodeBuddy CLI 文档](https://www.codebuddy.ai/docs/cli/cli-reference) |
| Antigravity CLI 1.5.12 | 官方 CLI 和 SDK 提供自己的交互与程序化入口。已有会话使用本机数据库记录的首 Token 和流式时长。 [Antigravity CLI 文档](https://antigravity.google/docs/cli/reference/) |

### 启用本机 Claude Code 计时导出

在 `~/.tokentracker/tracker/claude-otel-receiver.json` 写入 `{"port":14318}` 并重启 Token Monitor。将以下字段合并到 Claude Code 用户设置 `~/.claude/settings.json` 的 `env` 对象。使用自定义 `CLAUDE_CONFIG_DIR` 时，修改该目录下的 `settings.json`。新启动的 Claude Code 进程会加载这些设置。

```json
{
  "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
  "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
  "OTEL_TRACES_EXPORTER": "otlp",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/json",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://127.0.0.1:14318/v1/traces",
  "OTEL_METRICS_EXPORTER": "none",
  "OTEL_LOGS_EXPORTER": "none"
}
```

接收器仅监听 `127.0.0.1`。它只保存成功模型请求的会话标识、模型、输出 Token 数和计时。用 `session.id` 关联合适的本机会话，用 span ID 排除重发。每批写入保留最近 24 小时内最多 10,000 条样本。官方端到端计时用 `duration_ms`，首 Token 延迟用 `ttft_ms`。流式请求用 `duration_ms − first_content_ms` 作为客户端测得的输出时长，结束边界是请求完成时间。用量与成本继续由会话用量记录提供。 [Anthropic trace 字段](https://code.claude.com/docs/en/monitoring-usage#span-attributes)

```bash
node --test test/token-rate.test.js test/session-performance.test.js
npm --prefix dashboard test -- src/pages/RatePage.test.jsx
npm run ci:local
```
