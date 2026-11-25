# LawVerify 客户端稳定性改造与验收

日期：2026-10-28。范围：本地客户端与其内置材料服务；本轮不执行生产部署、版本升级或安装包发布。

## 结论

稳定性核心保护已实现并经过 Windows 本地运行验证，包括服务强制退出恢复、渲染进程真实崩溃后的草稿恢复、损坏文档隔离、任务资源边界和大列表交互。

这不是“永不卡顿、零崩溃”的承诺，也不是完整发行认证。8 小时耐久测试、真实 macOS 测试、最终签名安装包测试仍是发布前必需项。

8 小时 Windows 耐久测试已在后台启动，当前未完成；每 30 分钟记录一次渲染进程内存，预热后的增长超过 128MB 会使测试失败。启动不等于验收通过。

## 已落地

| 层级 | 保护 |
| --- | --- |
| 桌面主进程 | 内置 Express/SQLite 服务通过 Electron utilityProcess 独立运行，主进程不再加载业务服务。 |
| 服务恢复 | 5 分钟内最多自动重启 3 次，延迟分别为 0.5、1.5、4 秒；启动等待上限 30 秒。 |
| 无响应探测 | 每 30 秒发送一次轻量 IPC 探测，20 秒未回复则结束服务并按相同重启预算恢复。不是高频 HTTP 轮询。 |
| 固定地址 | 桌面服务固定 127.0.0.1:18787；端口被占用时明确失败，不递增端口导致草稿存储地址变化。 |
| 窗口故障 | 渲染进程退出时提供恢复选择；无响应持续 8 秒后才询问，默认允许继续等待，不直接刷新。 |
| 界面容错 | React 总体错误边界与文档预览模块错误边界；局部预览失败不直接白屏。 |
| 草稿 | 按账号、文书、段落隔离；输入期间约每 250ms 写入 IndexedDB，停顿 1.5 秒后保存正文，失焦立即尝试保存。 |
| 草稿恢复 | 恢复前显示草稿并要求用户选择，不自动覆盖当前文稿。保存失败保留草稿并提供重试。 |
| 保存竞态 | 草稿删除校验 revision，旧保存不能删除新编辑；正文请求携带基础内容，后端拒绝旧草稿覆盖新正文。 |
| 工作区 | 保留 SQLite WAL/FULL 事务及冲突校验。保存触发经过 quick_check 校验的独立 SQLite 快照，约每 5 分钟最多生成一次，保留最近 3 份。 |
| 文档解析 | PDF/Word 使用独立系统子进程，最多 2 个并发、16 个排队任务；排队/单次解析 60 秒上限，整个解析会话 15 分钟上限。 |
| 文档范围 | 原件上限 100MB，PDF 1000 页，解析正文 800 万字符；超限明确失败，不截断后宣称完整理解。 |
| PDF 预览 | PDF.js worker；仅当前页画布，渲染约 400 万像素上限，切换/卸载取消任务并销毁资源；字体、CMap、WASM 随应用提供。 |
| Word 导入 | 浏览器 Web Worker 处理；最大 20MB、30 秒超时，结束后销毁 Worker。 |
| 预览读取 | Word 20MB、文本/RTF 8MB读取边界，同时检查 Content-Length 与实际流入字节数。 |
| 上传 | 单批累计 128MB，即使没有 Content-Length 也检查实际字节；最多两个并发上传，单文件原有上限保留。 |
| 证据目录 | 可变高度虚拟列表；仅挂载可见范围和少量缓冲行，长文件名仍换行。 |
| 后台同步 | 工作区变化事件触发刷新，合并事件、禁止请求重叠、不可见时暂停；60 秒兜底。目录扫描降为 60 秒并暂停不可见窗口。 |
| 请求 | 普通请求 120 秒，流式请求 15 分钟，支持取消；不自动重试写操作，避免重复提交或计费。 |
| 可观测性 | 本地结构化日志记录故障类型、退出码、服务内存和界面长任务；限速、限队列，日志约 1MB 轮转并保留上一份。 |

## 验证结果

- 客户端和服务端 TypeScript/生产构建通过。
- 服务监督器 6 项：并发启动、固定端口、启动失败恢复、超时终止、重启上限、存活但无响应的服务。
- 真实 Electron 服务集成：强杀后窗口可操作、重启后案件保留、utilityProcess 可启动原生解析子进程、耗尽重启预算后窗口仍可操作。
- 真实 Electron 界面 13 项：输入草稿、恢复确认、撤销、保存中再次编辑、revision 删除校验、Worker 导入、超限预览、PDF 翻页与卸载、局部错误边界、万条证据列表、真实渲染进程崩溃恢复等。
- 万条证据列表保持少于 40 个挂载行；100 次滚动采样的 P95 约 21ms，Windows 本机 Electron 软件渲染。该指标不是全功能响应 SLA。
- 一分钟耐久运行完成 29 次编辑/PDF挂载卸载循环，未发现异常；这是短时测试，不能推断 8 小时内存曲线。
- 文档/上传 8 项、正文冲突 4 项、快照 2 项通过。
- 既有工作区 19 项、句级联动 29 项、案件代理/目录 4 项和布局 63 项回归通过。
- Electron 44.4.2 / Node 24.21.0 的最终内置 SQLite 读写验证通过；真实内置服务自动快照生成通过。
- lint 无错误，但工作区仍有 React hooks 等警告；生产构建仍提示主 bundle 较大，未宣称全部性能风险消除。

测试用数据仅位于独立临时目录和测试页面，不写入真实案件或正式用户界面。

## 复验命令

上文为 2026-10-28 的历史验收记录。当前桌面版已移除旧页面；`test:layout` 检查新版登录、工作台、助手切换和 Word 导出，`test:stability` 保留服务监督器、草稿存储、解析和预览等回归，不再运行旧编辑器或旧证据列表用例。

在 `server` 目录：

```powershell
npm run build
npm run test:stability
npm run test:workspace
npm run test:agent
npm run test:linkage
```

在 `app` 目录：

```powershell
npm run build
npm run prepare:desktop
npm run test:stability
npm run test:desktop-service
npm run test:layout
npm run lint
```

执行 8 小时耐久测试：

```powershell
$env:LAWVERIFY_SOAK_MINUTES = '480'
npm run test:stability
Remove-Item Env:LAWVERIFY_SOAK_MINUTES
```

测试程序临时使用 8787/18787，需要先停止占用对应端口的开发或桌面服务；测试结束关闭临时服务，不启动额外 5173 预览。

## Windows 完整 Electron 套件启动失败

Codex 受限进程中，Electron 44.4.2 主进程可启动，但 GPU 子进程返回 `-1073741515`（`0xC0000135`），渲染进程同时报告 `launch-failed`，页面加载报 `ERR_FAILED (-2)`。用同一个二进制加载内联 HTML 也能复现，排除了 LawVerify 页面和 Express 服务；关闭 GPU、禁用软件光栅化或切换 SwiftShader 仍复现。仅允许在 Windows 桌面环境启动探针后，内联 HTML 渲染通过。对照验证定位到受限进程环境，具体受影响的 DLL 或启动资源尚未定位。

**完整套件使用登录态 Windows 桌面 PowerShell 执行。** Codex 中遇到上述组合错误，可在受限环境完成单测、类型检查和编译，再将仅本地的 Electron 测试命令交给桌面执行环境。套件已有 `app.disableHardwareAcceleration()`。若桌面环境下的最小窗口也失败，先用 Windows 应用程序事件日志或 Process Monitor 检查失败的 Electron 子进程及其 DLL 加载，再按查到的组件修复 Electron 安装或对应运行库。

在项目根目录执行以下命令。服务端和前端构建使用独立目录。需要解析材料的套件使用回环测试服务，并通过环境变量提供 `PARSER_SERVICE_TOKEN`。[旧版解析服务的接口与评估](deployment-parser.md)

```powershell
node --version
$env:APP_RUNTIME_ROOT = (Resolve-Path server).Path
$env:PARSER_SERVICE_URL = 'http://127.0.0.1:8790'
$env:LAWVERIFY_REDESIGN_SERVER_DIST = Join-Path $env:APP_RUNTIME_ROOT 'tmp/v12-verification-loopback-dist'
$env:LAWVERIFY_REDESIGN_FRONTEND_DIST = Join-Path (Resolve-Path app).Path 'tmp/v12-verification-current-dist'
if ((Test-Path 'server/tmp/.env') -or (Test-Path 'server/tmp/.env.local')) {
  throw '隔离构建目录存在环境配置'
}
Remove-Item Env:DATABASE_URL, Env:CLOUD_API_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:LAWVERIFY_REDESIGN_LAYOUT_ONLY, Env:LAWVERIFY_REDESIGN_EDITOR_ONLY, Env:LAWVERIFY_REDESIGN_EXPORT_ONLY, Env:LAWVERIFY_REDESIGN_ASSISTANT_ONLY -ErrorAction SilentlyContinue
node ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json --outDir $env:LAWVERIFY_REDESIGN_SERVER_DIST
if ($LASTEXITCODE -ne 0) { throw '服务端编译失败' }
Push-Location app
try {
  node ./node_modules/vite/bin/vite.js build --outDir $env:LAWVERIFY_REDESIGN_FRONTEND_DIST
  if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
} finally {
  Pop-Location
}
npm.cmd --prefix app run test:redesign
```

验收以退出码 0、前置单测全部通过和 `PASS redesign UI` 为准。页面能打开但后续失败时，按第一条套件断言排查。材料解析超时时，检查 `PARSER_SERVICE_URL`、调试凭据和解析服务的 `/health`。

2026-11-20 使用独立构建和本机回环解析服务在 Windows 桌面复跑，前置 50 项及完整 Electron 均通过，退出码 0。[完整日志](../tmp/lawverify-v12-redesign-native-current.log) · [验收结果](../app/tmp/redesign-qa-1795146699476/result.json)

## 数据与恢复边界

- 未完成本地写入的最后约 250ms 编辑、断电、磁盘故障、用户手动删除数据仍可能造成损失。不得承诺零丢失。
- 快照是数据库版本保护，不是异地备份。恢复时还需保留对应的 `workspace-assets`、原件存储和案件目录，不能只拷贝 SQLite 就宣称证据原件完整。
- 数据库损坏时不自动回退、不自动重置。恢复前停止应用并备份整个用户数据目录，人工检查快照及原件后恢复。
- 结构化日志不收集证据正文、账号、token 或路径，也不上传云端。Electron crashReporter 仅本地保存；原生 dump 可能包含内存片段，未经用户同意不得上传。
- 进程内存参数限制 V8 堆，不是操作系统级 RSS 上限；原生 PDF 库仍可能消耗额外内存，依靠独立进程、并发/输入边界和超时降低影响。
- 重启不会自动重放提交、支付或计费请求。连接中断时先检查已有结果；后台持久化任务沿用现有 bootstrap 恢复机制。

## 发布前门槛

- [ ] Windows 主流笔记本、系统缩放和真实大案件测试。
- [ ] 至少 8 小时耐久运行，检查内存趋势而非只看结束时单个数值。
- [ ] 复杂长 Word 的版式预览专项测试；当前 docx-preview 仍需要在渲染进程完成 DOM 版式构建，已有大小限制但不等于完全消除长任务。
- [ ] 超长文稿专项测试，覆盖 SuperDoc 首次加载、输入、滚动和保存。
- [ ] 磁盘满、断网、睡眠唤醒、升级中断和备份恢复测试。
- [ ] Apple 芯片/Intel macOS 真实安装及 Electron 子进程、公证兼容验证。
- [ ] 最终签名安装包安装、启动、升级回归及 SHA256 校验。
- [ ] 真实用户崩溃率和交互延迟持续统计；当前仅本地日志，没有跨用户云端监测或自动回滚发布系统。
