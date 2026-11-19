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

输出速率为可计时请求的生成 Token 总数除以对应的流式时长。CodeBuddy 通过消息 ID 将会话用量与运行日志配对，从首个有效 Token 计到工具调度前的输出结束标记。Antigravity 使用数据库记录的流式时长。首 Token 等待单独显示。工具执行与请求之间的空闲时间排除在分母之外。源日志只能提供整段流式时间时，精确到每两个输出块之间的等待无法单独扣除。

速率页用 `—` 表示缺少可用计时。此类请求仍计入用量、费用及窗口消耗。上下文吞吐只使用有流式计时的请求的总 Token。

```bash
node --test test/token-rate.test.js test/session-performance.test.js
npm --prefix dashboard test -- src/pages/RatePage.test.jsx
npm run ci:local
```
