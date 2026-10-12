# Debug Session: backend-file-load
- **Status**: [OPEN]
- **Issue**: 后端在本地开发态不稳定，`/api/workspace` 与证据原件加载链路间歇失败，导致文件预览区无法加载原件。
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-backend-file-load.ndjson

## Reproduction Steps
1. 启动本地前端与后端。
2. 进入案件工作区。
3. 打开右侧“证据原件”预览或切换已绑定证据。
4. 观察是否出现工作区加载失败、原件预览失败或后端拒绝连接。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 开发态后端进程因 `tsx watch` 内存问题退出，导致接口间歇拒绝连接 | High | Low | Confirmed |
| B | 原件接口响应头导致浏览器阻止嵌入式预览，接口本身并未完全失败 | High | Low | Confirmed |
| C | 原件接口读取 `sourceDataUrl/previewDataUrl` 时对特定证据抛错，导致预览失败 | Medium | Low | Rejected |
| D | 前端切换证据时请求目标和当前选中状态错位，触发无效加载 | Medium | Medium | Rejected |

## Log Evidence
- 已启动本地调试收集器，环境文件为 `.dbg/backend-file-load.env`
- 首轮埋点文件：
  - `server/src/index.ts`
  - `server/src/routes/legacy.ts`
  - `server/src/service.ts`
  - `app/src/App.tsx`
- 旧开发态后端日志 `server.log` 显示：
  - `server.log:3` 使用旧命令 `tsx watch src/index.ts`
  - `server.log:34` 出现 `Fatal process out of memory: Zone`
- 修复后开发态后端日志 `server-dev-memory.log` 显示：
  - `server-dev-memory.log:3` 使用新命令 `node --max-old-space-size=4096 ./node_modules/tsx/dist/cli.mjs watch src/index.ts`
  - `server-dev-memory.log:13` 成功监听 `http://localhost:8787`
- 调试日志 `.dbg/trae-debug-log-backend-file-load.ndjson` 显示：
  - `17-23`：前端预览请求的 `evidenceId` 与后端收到的一致，且后端成功取出并返回 11.6MB PDF
  - `26-30`：修复后 iframe 目标再次命中 `/api/evidences/:id/source`，后端继续稳定返回 PDF
- 头部探测显示原件接口修复前带 `X-Frame-Options: SAMEORIGIN`，修复后该头已移除
- 浏览器端最小 iframe 复验返回 `load`

## Verification Conclusion
- 根因 1：开发态后端使用 `tsx watch` 时发生内存溢出，导致 `8787` 间歇拒绝连接。
- 根因 2：原件 PDF 通过 `5173` 页面内的 iframe 加载 `8787` 资源时，被 `X-Frame-Options: SAMEORIGIN` 拦截；对浏览器来说端口不同即跨源，因此即使后端成功返回 PDF，也会显示加载失败。
- 已实施修复：
  - `server/package.json`：为开发态后端加入 `--max-old-space-size=4096`
  - `server/src/routes/legacy.ts`：在原件接口响应前移除 `X-Frame-Options`
- 当前状态：调试会话保持 `[OPEN]`，等待用户现场确认文件预览和本地开发态稳定性。
