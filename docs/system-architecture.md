# LawVerify 系统架构、数据流向与运行时

本文基于当前仓库源码（`app/`、`server/`、`cloud-server/`、`web/`）梳理，描述到模块与文件粒度。
凡源码中无法确证的内容，均标注「未验证」。

---

## 1. 系统边界

LawVerify 由四块可独立运行的代码组成，外加若干外部依赖：

| 目录 | 角色 | 运行时 |
| --- | --- | --- |
| `app/` | 桌面客户端（Electron 主进程 + React 工作台） | Electron 44 / Node 内置 |
| `server/` | 业务后端（案件、证据、文书、联动、本地工作区） | Node 22+ / Express 5 / TS ESM |
| `cloud-server/` | 云端账户平台（身份、积分、订单、发票、发行、AI 网关） | Node / Express 5 / PostgreSQL |
| `web/` | 官网 + 账户中心前端与其静态服务 | React / Node http |

设计上是「模块化单体 + 独立云端平台」：桌面端自带完整业务能力，云端只承担账号、计费与模型网关，
不依赖云端也能进行本地案件工作（`AI_GATEWAY_MODE=direct` 直连模型供应商时）。

---

## 2. 总体架构图

```mermaid
flowchart TB
  subgraph Client["客户端层"]
    subgraph Electron["Electron 桌面端 app/"]
      Main["main.cjs<br/>窗口 / 端口探测 / 单实例锁<br/>更新 / 目录链接 / 账户代理"]
      Preload["preload.cjs<br/>contextBridge 暴露 lawVerifyDesktop"]
      Renderer["Renderer<br/>React 19 + Tiptap 工作台<br/>App.tsx / api.ts / 导出 Word"]
    end
    subgraph WebUI["官网与账户中心 web/"]
      Site["site.ts / site-demos.tsx<br/>下载页 / 账户中心"]
      Preview["preview-server.mjs<br/>静态托管 + /api 代理"]
    end
  end

  subgraph Local["本地业务后端 server/"]
    HTTP["Express app.ts<br/>helmet / cors / compression<br/>/api 与 /api/v1 双前缀"]
    Routes["routes/legacy.ts + routes/v1.ts"]
    Service["service.ts 业务总线<br/>材料 / 案件记忆 / 文书 / 联动 / 支付"]
    Intel["intelligence/<br/>evidence-matching / evidence-retrieval<br/>evidence-risk-scan / linkage-policy<br/>legal-verification / case-agent"]
    Infra["infrastructure/<br/>workspace-sqlite / workspace-lock<br/>workspace-backups / document-jobs<br/>llm-call-cache / object-storage"]
    Integrations["integrations/<br/>llm-service / cloud-ai / embedding-service<br/>qdrant-service / MCP 案例源 / collabora"]
    Commercial["commercial/<br/>auth-service(JWT) / rbac<br/>knowledge-file-service / organization"]
  end

  subgraph Cloud["云端平台 cloud-server/"]
    CloudHTTP["Express app.ts<br/>/api/web /api/ai /api/account<br/>/api/billing /api/invoices /api/client /api/admin"]
    PointSvc["point-service 积分账本"]
    CloudAuth["auth-service JWT + bcrypt + RBAC"]
    Release["release-service 发行与校验和"]
  end

  subgraph Data["数据层"]
    SQLite[("workspace.sqlite<br/>node:sqlite")]
    LocalStore[("本地 storage/<br/>原件 / 知识文件")]
    Rag[("knowledge-rag-index.json<br/>llm-cache/")]
    PG[("PostgreSQL<br/>账户 / 订单 / 积分 / 知识库")]
    Qdrant[("Qdrant<br/>knowledge_chunks 可选")]
  end

  subgraph Ext["外部依赖"]
    Model["LLM / 视觉模型 / ASR / Embedding 供应商"]
    CaseMCP["元典 / 威科 / 北大法宝 MCP"]
    Pay["支付宝 / 微信支付"]
    Offic["官方法源<br/>npc_flk / moj_xzfg / gov_gjgzk"]
    Collab["Collabora (WOPI) :9980"]
  end

  Main -->|utilityProcess.fork| Renderer
  Preload -.->|IPC| Main
  Renderer -->|HTTP 127.0.0.1:18787| HTTP
  Renderer -->|IPC 账户请求| Main
  Main -->|HTTPS 官网账户接口| CloudHTTP
  Site --> Preview
  Preview -->|/api/* 代理| CloudHTTP

  HTTP --> Routes --> Service
  Service --> Intel
  Service --> Infra
  Service --> Integrations
  Service --> Commercial
  Infra --> SQLite
  Infra --> LocalStore
  Infra --> Rag
  Commercial -.->|commercial 模式| PG
  Commercial -.-> Qdrant
  Integrations -->|cloud 模式| CloudHTTP
  Integrations -->|direct 模式| Model
  Integrations --> CaseMCP
  Integrations -->|MCP 透传| CloudHTTP
  Service --> Pay
  Service --> Offic
  Integrations --> Collab
  CloudHTTP --> PointSvc
  CloudHTTP --> CloudAuth
  CloudHTTP --> Release
  PointSvc --> PG
  CloudAuth --> PG
  Release --> PG
```

关键边界说明：

- `server/` 是**唯一的案件真相源**。案件、证据、文书、联动结果全部落在本地工作区，
  云端不存案件内容，只存账号、积分与调用流水。
- `cloud-server` 的 `/api/ai` 是**模型网关**：桌面端配置 `AI_GATEWAY_MODE=cloud` 时，
  所有 LLM / Embedding / ASR 调用经此转发并按积分计费；配置为 `direct` 时桌面端直连供应商。
- `web/` 是官网与账户中心前端，`preview-server.mjs` 只做静态托管 + `/api/*` 反向代理，
  自身不含业务逻辑。

---

## 3. 运行时拓扑

### 3.1 桌面发布态（用户实际运行的形态）

```mermaid
flowchart LR
  U["用户"] --> W["Electron 主进程<br/>main.cjs"]
  W --> S["utilityProcess: desktop-service.cjs<br/>Express on 127.0.0.1:18787"]
  S --> R["渲染进程加载<br/>http://127.0.0.1:18787"]
  W -.->|watchdog ping/pong<br/>30s 间隔 / 60s 超时| S
  S --> FS["userData/<br/>data / storage / logs"]
```

- 端口：`findAvailablePort(18787, 1)`，实际**只尝试 18787 一个端口**。
- 进程模型：主进程 `utilityProcess.fork(desktop-service.cjs)`，子进程内
  `import(.desktop/server/dist/app.js)` 并 `app.listen(127.0.0.1:PORT)`，
  同一进程同时提供 API 与前端静态资源。
- 看门狗：`service-supervisor.cjs` 30s 一次 ping、60s 无响应即 kill；
  退出后按 `[500,1500,4000,8000,15000] ms` 退避重启，5 次用尽后每 30s 低频重试，永不放弃。
- 稳定日志：`userData/logs`，事件来源包括 stdout/stderr 重定向、无响应、进程退出、内存 RSS。
- 渲染进程崩溃或窗口 8s 无响应时弹窗恢复（reload），草稿保留。
- 数据目录（`applyDesktopServerEnv`）：

| 环境变量 | 桌面端取值 |
| --- | --- |
| `APP_RUNTIME_ROOT` | `app/.desktop/server`（内置 dist + migrations + seeds） |
| `APP_DATA_ROOT` | `userData/runtime` |
| `WORKSPACE_DATA_DIR` | `userData/data` |
| `STORAGE_LOCAL_ROOT` | `userData/storage` |
| `FRONTEND_DIST_DIR` | `app/dist` |
| `AUTO_RUN_MIGRATIONS` | `false` |
| `AI_GATEWAY_MODE` | `cloud`（由 `.desktop/server/.env.local` 提供） |
| `CLOUD_API_BASE_URL` | `https://lawverify.zhijing.fun`（仅当原值是本机地址时替换） |

### 3.2 开发态

| 服务 | 端口 | 启动命令 |
| --- | --- | --- |
| 桌面前端 | 5173 | `app: npm run dev:web` |
| 本地后端 | 8787 | `server: npm run dev`（tsx watch） |
| 云端后端 | 8788 | `cloud-server: npm run dev` |
| 官网/账户中心 | 4273 | `web: npm run dev`（vite）或 `preview-server.mjs` |
| 一键联调 | — | 根目录 `dev-workbench.cmd` / `platform-dev.cmd` |

开发态下 `app/src/api.ts` 的 `API_BASE_URL` 指向 `http://<host>:8787`，
桌面壳以 `npm run dev:electron` 加载 5173。

### 3.3 平台发布态

```mermaid
flowchart LR
  Internet["公网"] --> CF["Cloudflare Tunnel<br/>(运维层)"]
  CF --> W["web preview-server :4273<br/>静态 + /api 代理"]
  W --> C["cloud-server :8788"]
  C --> PG[("PostgreSQL")]
  C --> Collab["Collabora :9980"]
```

- `platform-dev.cmd` 管理 web 与 cloud-server；`install-platform-recovery.ps1`
  注册登录自启任务 `LawVerify-Platform-Autostart` 与每分钟健康检查 `LawVerify-Platform-Recovery`。
- 本地 PostgreSQL 容器端口 `54329`（`docker-compose.cloud-postgres.yml`）。
- Collabora 容器 `9980`，服务端通过 `COLLABORA_PROXY_PATH=/collabora` 反代（`integrations/collabora-proxy.ts`），
  支持 WebSocket 升级。

---

## 4. 数据流向图

### 4.1 链路 A：材料导入 → 原件理解

```mermaid
flowchart TB
  Files["本地目录 / 拖拽上传<br/>case-directories.cjs 扫描"] --> Upload["POST /api/evidences/import<br/>或 /api/v1/evidences/import"]
  Upload --> Reserve["reserveUpload 中间件<br/>并发 ≤2，批次 ≤512MB"]
  Reserve --> Disk["boundedFileStorage 落盘<br/>data/upload-tmp + sha256"]
  Disk --> Store["object-storage<br/>rename 进 storage/evidence/YYYY-MM-DD/uuid.ext"]
  Store --> Workspace["写工作区<br/>证据编号 E01… / 附件 X01…"]
  Workspace --> Queue{"处理方式"}
  Queue -->|deferUnderstanding| Skip["仅登记，不启动模型"]
  Queue -->|后台| BG["queueBackgroundEvidenceProcessing"]
  Queue -->|同步| Sum["summarizeEvidence"]
  BG --> Sum
  Sum --> Parse["document-jobs → document-worker 子进程<br/>mammoth / pdf-parse / 旧版 .doc 自解析"]
  Parse --> Mode{"理解模式<br/>evidence-understanding-mode"}
  Mode -->|text| TextLLM["文本理解"]
  Mode -->|vision| VisionLLM["逐页视觉理解<br/>页数上限 10"]
  Mode -->|retrieval| Retrieval["块级索引 → 命中块送模型<br/>阈值 0.25 / 至少 6 块"]
  TextLLM --> Insight["EvidenceInsight<br/>证明目的/关键事实/争议/证明局限"]
  VisionLLM --> Insight
  Retrieval --> Insight
  Insight --> Risk["scanEvidenceRisks 规则扫描<br/>程序瑕疵独立于语义链"]
  Risk --> Write["commitEvidenceSummary<br/>重读最新工作区再合并"]
  Write --> Memory["rebuildCaseContextMemory<br/>案件记忆"]
```

要点：

- 上传全程**按文件落盘**，内存占用与文件大小无关；单文件上限 512MB。
- 重复材料按 `contentHash` 判定：内容相同直接沿用原件理解结果并标记 `duplicateOf`。
- 摘要按 `summaryCacheKey` 缓存，内容变更即失效；`force` 可强制重跑。
- 规则化风险扫描与模型理解**互为补充**：程序瑕疵（举证期限、形式要件、签章缺失）不在语义空间内，
  检索式理解只覆盖命中块时必须靠规则兜底。

### 4.2 链路 B：案件记忆与代理立场

```mermaid
flowchart TB
  Ins["EvidenceInsight 集合"] --> Mem["rebuildCaseContextMemory"]
  Mem --> Dim["四个维度<br/>争议与立场 / 事实脉络<br/>证据结构 / 办案关注"]
  Dim --> Draft["CasePosition 草稿<br/>当事人/诉讼地位/目标/认可/争议/约束"]
  Draft --> Confirm["用户确认<br/>confirmCasePosition version 校验"]
  Confirm --> Strategy["rebuildCaseStrategy<br/>主张 / 成立要件 / 证明责任<br/>支持材料 / 不利材料 / 缺口 / 反驳"]
  Strategy --> Agent["case-agent 对话<br/>caseAgentMessage"]
  Agent --> Answer["主张与举证思路"]
```

- 立场由用户显式确认后生效；系统规则明确：立场不改变客观事实，保留不利证据与矛盾。
- 策略输入用 `strategyInputKey`（记忆版本 + 立场）做缓存键；材料指纹变化时提示重新梳理。

### 4.3 链路 C：文书生成 → 句级联动 → 导出

```mermaid
flowchart TB
  Gen["generateCertificate / streamGenerateCertificate<br/>按证据清单 + 焦点 + 角色生成"]
  Mem2["案件记忆"] --> Gen
  Evi["证据摘要"] --> Gen
  Gen --> Cert["Certificate + paragraphs"]
  Cert --> Link["autoLinkCertificate 流式"]
  Link --> Focus["linkage-policy 句级门控<br/>fact / dispute / legal_issue<br/>identity / background / heading"]
  Focus --> Recall["候选召回<br/>显式提及 + 语义向量 + 关键词"]
  Recall --> Judge["模型判定适配关系<br/>support / partial / contradict"]
  Judge --> Statute["法条核验<br/>版本/废止/正文缺失 → warning"]
  Judge --> CaseRef["案例核验<br/>案号格式 / 官方来源"]
  Statute --> Attach["挂接到具体句子<br/>EvidenceLink + ParagraphReference"]
  CaseRef --> Attach
  Attach --> Save["合并进最新工作区<br/>冲突 → 409 WORKSPACE_CONFLICT"]
  Save --> Export["导出 Word<br/>含段落核验批注"]
```

要点：

- 联动锚定到**句子**而非整段。`SentenceLinkageFocus` 记录每句的 `evidenceNeeded / statuteNeeded / caseNeeded`。
- 句级门控是**排除规则**（标题、身份字段、套话），不替代模型判断。
- 引用警示：`statute-repealed` / `statute-amended` / `statute-content-missing` 标记在引用上，
  不能当作可直接引用的依据。
- `linkageInputKey` 记录本次联动依赖的材料指纹；材料增减或重新理解后可提示重新核验。
- 保存前重读最新工作区并只合并挂接与引用，避免联动期间后台更新被旧快照覆盖。

### 4.4 链路 D：账户、积分与模型网关

```mermaid
flowchart LR
  Login["官网账户登录"] -->|"POST /api/account/login"| CloudAuth2["cloud-server auth-service<br/>bcrypt + JWT"]
  CloudAuth2 -->|JWT + x-case-agent-token| Renderer
  Renderer -->|"AI_GATEWAY_MODE=cloud"| Gateway["/api/ai/*"]
  Gateway -->|"x-ai-request-id<br/>幂等键"| Bill["billedAiRequest<br/>按组织+用户限并发 3"]
  Bill --> Consume["consumePointAction<br/>积分账本扣减"]
  Consume --> PG2[("point_ledger")]
  Bill --> Up["模型 / Embedding / ASR / MCP 供应商"]
  Bill -->|"失败"| Refund["refundPointAction<br/>幂等退款 + 对账标记"]
  Renderer -->|"/api/cloud/* 本地反代"| Proxy["server legacy.ts proxyCloudRequest"]
  Proxy --> CloudHTTP2["cloud-server"]
  Main -->|"electron IPC 账户请求<br/>域名白名单 /api/account|billing|invoices|client|web"| CloudHTTP2
```

要点：

- 桌面端对云端有**三条通道**：Electron IPC 直连（发布态）、`/api/cloud/*` 本地反代（开发/浏览器态）、
  浏览器直连官网域名。
- 模型网关按「组织 + 用户」限并发 3，桌面端也按同一上限排队，避免被网关判为「分析任务过多」。
- 计费幂等键为 `ai:<requestId>`，退款键为 `ai-refund:<requestId>`；失败走退款，异常走对账。
- 案例检索有本地（内置法库 + 本地 RAG）与商业（PostgreSQL + Qdrant）两套，按
  `KNOWLEDGE_RAG_MODE=local|commercial|auto` 切换。

---

## 5. 关键流程图

本章是运行时的**过程视图**，与第 4 章的数据流向图互补：
第 4 章回答「数据往哪走」，本章回答「什么时候发生、按什么顺序发生、失败时怎么退」。

### 5.1 桌面端冷启动时序

```mermaid
sequenceDiagram
  autonumber
  participant U as 用户
  participant M as Electron 主进程
  participant W as 窗口 (Renderer)
  participant S as 本地服务进程
  participant SV as ServiceSupervisor

  U->>M: 启动 LawVerify
  M->>M: requestSingleInstanceLock()
  alt 已有实例
    M-->>U: 聚焦已有窗口并退出
  else 首个实例
    M->>M: setPath(userData) 并迁移旧目录 data/storage/runtime
    M->>M: whenReady: 主题、代理、IPC、崩溃上报、目录链接注册
    M->>M: bootApplication() → createWindow()
    M->>SV: new ServiceSupervisor(fork=utilityProcess.fork)
    SV->>S: fork desktop-service.cjs
    S->>S: import .desktop/server/dist/app.js
    S->>S: initializeCommercialInfrastructure()（迁移 + 清 upload-tmp）
    S->>S: app.listen(127.0.0.1:18787)
    S-->>SV: postMessage({type:'ready'})
    SV-->>M: status='ready' + 广播到所有窗口
    M->>W: loadURL(http://127.0.0.1:18787)
    W->>S: GET / （SPA 回落 index.html）
    W->>S: GET /api/workspace
    S-->>W: 工作区快照
    W-->>U: 工作台就绪
  end
```

要点：

- `userData` 目录从旧的 `LexVerify` / `lexverify-mvp` **只迁移业务数据**（data / storage / runtime），
  Chromium 缓存不迁移，避免旧 UI 产物残留。
- 开发态跳过本地服务进程：窗口直接加载 `http://127.0.0.1:5173`，API 走 `http://<host>:8787`。

### 5.2 单次 API 请求的处理链

```mermaid
flowchart TB
  In["请求进入"] --> RC["requestContext<br/>生成/透传 x-request-id"]
  RC --> HL["helmet（关闭 CSP 与 CORP）"]
  HL --> CO["cors 白名单校验"]
  CO --> CP["compression"]
  CP --> JS["express.json（100mb）"]
  JS --> HB["streamHeartbeat<br/>空闲 15s 补注释行"]
  HB --> ST1["静态 /uploads 原件目录"]
  ST1 --> CL["Collabora 反代（支持 WS 升级）"]
  CL --> ST2["静态 app/dist 前端产物"]
  ST2 --> NS["/api 与 /api/v1 强制 no-store"]
  NS --> Route{"路由归属"}
  Route -->|"/api/v1/*"| V1["v1Router<br/>统一响应 {success,requestId,data,meta}"]
  Route -->|"/api/*"| LG["legacyRouter"]
  Route -->|其他 GET| SPA["回落 index.html"]
  Route -->|都不匹配| NF["notFound 404"]
  V1 --> Err{"抛错？"}
  LG --> Err
  Err -->|否| OK["200 正常响应"]
  Err -->|是| EH["errorHandler<br/>统一 {success:false,requestId,error{code,message}}"]
```

两条 API 前缀并存：`/api` 是旧接口（保持前端可运行），`/api/v1` 是版本化接口。
两者**共用同一套 service.ts 业务逻辑**，不是两套实现。

工作区账号隔离靠请求头 `x-workspace-account`（或 query 参数 `workspaceAccount`）：
路由层用 `runWithWorkspaceAccount()` 把它写进 `AsyncLocalStorage`，
`store.ts` 再据此切换到 `data/workspaces/<slug>/` 目录。

### 5.3 后台材料理解队列

```mermaid
flowchart TB
  Trigger["任一触发点<br/>导入材料 / 确认立场 / 前端读工作区"] --> Q["backgroundEvidenceProcessingQueue<br/>key = account + caseId"]
  Q --> Timer{"该 key 已在队列？"}
  Timer -->|是| Skip["直接返回<br/>不重置定时器"]
  Timer -->|否| D["setTimeout 1500ms"]
  D --> Drain["drainBackgroundEvidenceProcessingQueue"]
  Drain --> Pick["取出队首案件"]
  Pick --> Check{"任务状态合法？<br/>queued / processing 且 autoAnalyze≠false"}
  Check -->|否| Next["丢弃该任务，继续下一件"]
  Check -->|是| Pending["筛出待理解材料<br/>排除 type=other 与已完成"]
  Pending --> Empty{"还有待理解？"}
  Empty -->|否| Finish["task.stage='正在整理案件记忆'<br/>清理失效排除记录 → 重建记忆"]
  Empty -->|是| Run["mapSettledWithConcurrency 并发 3"]
  Run --> Each{"该材料"}
  Each -->|duplicateOf| Inherit["继承原件理解结果<br/>不调模型、不扣费"]
  Each -->|已 ready| Cache["cacheOnly 命中缓存"]
  Each -->|正常| Sum["summarizeEvidence（锁外执行模型调用）"]
  Sum --> Fail{"理解失败？"}
  Fail -->|是| Mark["标记 failed + 记入 skippedEvidenceIds"]
  Fail -->|否| Ok["commitEvidenceSummary<br/>重读最新工作区再合并"]
  Ok --> Next2["下一份材料"]
  Mark --> Next2
  Next2 --> Run
  Next --> More{"队列还有？"}
  More -->|是| Pick
  More -->|否| End["收尾：重建案件记忆 + 策略"]
```

两个设计约束值得注意：

1. **队列去重**：同一案件已在队列时不重置 1500ms 定时器。
    前端每次读工作区都会重新排队，若每次都重设定时器会无限推迟，自动理解永远得不到执行。
2. **只在队首串行处理案件，案件内材料并发**：
    案件之间一次只做一个，案件内多份材料并发 3。
    理解耗时在写锁之外，落库仍由 `summarizeEvidence` 内部串行合并。

### 5.4 流式文书生成时序

```mermaid
sequenceDiagram
  autonumber
  participant W as Renderer
  participant R as /api/certificates/generate/stream
  participant S as service.ts
  participant L as LLM（网关或直连）
  participant DB as workspace.sqlite

  W->>R: POST + AbortSignal
  R->>R: withAssistantModel 校验所选模型
  R->>S: streamGenerateCertificate
  S->>DB: readWorkspace()
  S->>S: rebuildCaseContextMemory（案件记忆）
  S->>L: 流式请求
  loop 每个段落
    L-->>R: delta 增量文本
    R-->>W: SSE 事件 paragraph
    W->>W: 追加到编辑器
  end
  L-->>R: [DONE]
  R->>S: attachAutoStatuteReferences（法条核验）
  S->>DB: commitToLatestWorkspace（重读最新快照后合并）
  DB-->>S: 冲突？
  alt 冲突
    S-->>R: 409 WORKSPACE_CONFLICT
  else 正常
    S-->>R: done 事件 + 统计（挂接数 / 引用数 / 警示数）
  end
  Note over W,S: 用户点「停止」→ AbortSignal 触发<br/>LLM 调用立即中断，不继续消耗额度
```

流式通道是 SSE（`text/event-stream`），服务端 `streamHeartbeat` 中间件在空闲 15s 时补一行注释，
让客户端不会把长空闲误判为断连。

### 5.5 句级联动的执行顺序

```mermaid
flowchart TB
  Start["autoLinkCertificate"] --> Llm{"LLM 已配置？"}
  Llm -->|否| Err["直接报错：证据联动依赖大模型理解"]
  Llm -->|是| Read["读取文书与案件材料"]
  Read --> Mem["重建案件记忆<br/>争议焦点 / 证据薄弱点"]
  Mem --> Analyze["analyzeCertificateAutoLinksWithLlm<br/>逐段判定：需要证据？法条？案例？"]
  Analyze --> Enrich["按焦点补齐超大材料理解<br/>enrichRetrievalLimitedInsights"]
  Enrich --> Reread["重读工作区<br/>联动可能持续数分钟，后台也在更新"]
  Reread --> Ev["attachAutoEvidenceLinks<br/>证据关系与证明力"]
  Ev --> Stat["attachAutoStatuteReferences<br/>版本 / 废止 / 正文缺失 → warning"]
  Stat --> Case["attachAutoCaseReferences<br/>案例存在性与官方来源"]
  Case --> Merge["合并挂接与引用<br/>段落正文与人工挂接以最新工作区为准"]
  Merge --> FP["记录 linkageMaterialFingerprint"]
  FP --> Save{"写入冲突？"}
  Save -->|是| C409["409：材料或文书在联动期间被更新<br/>请重新执行联动"]
  Save -->|否| Stat2["done 事件：统计 + 增量载荷<br/>统计：联动段落数 / 证据挂接数<br/>法条引用数 / 警示数 / 案例引用数"]
```

顺序上有个反直觉的点：**证据 → 法条 → 案例**是串行的三段，
每段都在上一段的结果上继续挂接，所以法条核验看到的是已经挂好证据的段落。

`done` 事件不回传全量工作区快照——那动辄十几 MB，会超过客户端流式接收上限。
改为只带增量（改写后的文书 + 本案记忆 + 本案材料理解），前端按 id 逐字段合并进本地工作区。

模型调用的结果按 `namespace + 请求内容哈希` 缓存在 `llm-cache/`，
任务被中断后重跑可以直接复用已完成的阶段（进度提示里会显示「已复用 N 项模型结果」）。

### 5.6 AI 网关计费与退款

```mermaid
flowchart TB
  Req["POST /api/ai/chat/completions<br/>头：x-ai-request-id（UUID，必填）"] --> Auth["authenticate + requirePermission('account.read')"]
  Auth --> Gate{"AI_GATEWAY_ENABLED？"}
  Gate -->|否| E503["503 AI_GATEWAY_DISABLED"]
  Gate -->|是| Conc{"该「组织+用户」在途请求 ≥3？"}
  Conc -->|是| E429["429 AI_CONCURRENCY_LIMIT"]
  Conc -->|否| Bill["billedAiRequest"]
  Bill --> Begin["beginAiRequest（登记流水）"]
  Begin --> Consume["consumePointAction<br/>幂等键 ai:&lt;requestId&gt;"]
  Consume --> Up["调用模型供应商"]
  Up --> Success{"成功？"}
  Success -->|是| Done["updateAiRequest('succeeded')<br/>返回结果"]
  Success -->|否| Pend["updateAiRequest('refund_pending')"]
  Pend --> Refund["refundPointAction<br/>幂等键 ai-refund:&lt;requestId&gt;"]
  Refund --> Refunded["updateAiRequest('refunded')"]
  Refunded --> Err["抛出原始错误"]
  Refund -.->|"退款本身失败"| Recon["标记 refund_pending<br/>由 reconcileAiRequests 每 60s 对账"]
```

两条兜底：

- **限流发生在扣费之前**，所以 429 重试不会重复计费。
- 退款失败不吞掉，留在 `refund_pending` 状态，由云端 `reconcileAiRequests`（60s 周期）对账。

### 5.7 应用更新流程

```mermaid
flowchart TB
  Check["检查更新"] --> Fetch["拉取发行信息<br/>/api/web/releases/latest"]
  Fetch --> Verify{"verifyUpdateRelease 校验"}
  Verify -->|"版本不新 / 平台或架构不符<br/>sha256 不匹配 / 非 HTTPS"| Reject["拒绝并提示从官网下载"]
  Verify -->|通过| Name["validateUpdateFileName<br/>.dmg 或 .exe，且版本与芯片匹配"]
  Name --> Download["downloadInstaller<br/>流式下载 + 实时 sha256"]
  Download --> Complete{"字节数与哈希一致？"}
  Complete -->|否| Clean["删除临时文件并报错"]
  Complete -->|是| Launch{"平台"}
  Launch -->|Windows| Win["启动安装器并退出"]
  Launch -->|macOS| Mac1["prepareMacUpdate<br/>校验签名 / 暂存新包 / 备份原包"]
  Mac1 --> Mac2["launchMacUpdate<br/>拉起独立 helper 脚本"]
  Mac2 --> Mac3["helper 等待旧进程退出<br/>替换 .app 并重启"]
  Mac3 --> Mac4{"新版本启动成功？"}
  Mac4 -->|是| Ack["acknowledgeMacUpdate(ready=true)"]
  Mac4 -->|否| Rollback["恢复原版本<br/>提示用户"]
```

安全约束：

- 安装包必须 HTTPS，下载时实时计算 sha256 与发行信息比对。
- 文件名必须匹配当前平台与架构（`LawVerify-Mac-<ver>-<arch>.dmg` / `LawVerify-Setup-<ver>.exe`），
  防止把 mac 包装到 Windows。
- macOS 更新由独立 helper 进程完成替换，应用退出码与结果通过 `userData/updates/mac/` 下的
  状态文件回传，启动时 `readStartupJob` 校验 manifest 后才认这次更新。

### 5.8 故障自愈与降级

```mermaid
flowchart TB
  Fail["故障信号"] --> Type{"类型"}
  Type -->|"本地服务进程退出"| Exit["ServiceSupervisor 退避重启<br/>500 / 1500 / 4000 / 8000 / 15000 ms"]
  Exit --> Limit{"5 次内？"}
  Limit -->|是| Exit
  Limit -->|否| Low["降级：每 30s 低频重试<br/>界面自动恢复可用，不要求用户重开"]
  Type -->|"60s 无响应（ping 无 pong）"| Kill["kill 子进程 → 触发重启"]
  Type -->|"渲染进程崩溃"| Reload["弹窗「恢复窗口」→ reload<br/>本地草稿保留"]
  Type -->|"窗口 8s 无响应"| Reload2["同上"]
  Type -->|"材料解析超时 / 进程异常"| DFail["标记该材料 failed<br/>原件保留，提示重试"]
  Type -->|"模型 429"| Retry["退避重试（最多 3 次）<br/>网关模式不重复计费"]
  Type -->|"工作区写入冲突"| C409["409 WORKSPACE_CONFLICT<br/>已有结果不被覆盖"]
  Type -->|"sqlite 损坏"| Corrupt["阻止自动重置<br/>保留 workspace.sqlite 与 JSON 备份待人工恢复"]
  Type -->|"云端 401"| Logout["丢弃本地凭据<br/>提示重新登录官网账户"]
```

贯穿其中的原则是**「宁可降级，不丢数据」**：
本地服务起不来时低频重试而不是让用户重开应用；
sqlite 损坏时阻止自动重置而不是清库；
工作区冲突时保留已有结果而不是覆盖。

---

## 6. 持久化位置一览

| 数据 | 位置 | 形态 |
| --- | --- | --- |
| 案件、证据、文书、联动 | `userData/data/workspace.sqlite` | node:sqlite，`node:sqlite` 同步 API |
| 多账号工作区 | `userData/data/workspaces/<account-slug>/` | 每账号独立 sqlite + JSON 备份 |
| 原件、知识文件 | `userData/storage/evidence/YYYY-MM-DD/<uuid>.<ext>` | 文件系统，key 寻址 |
| 模型调用缓存 | `userData/data/llm-cache/<account>.json` | 命名空间 + 请求哈希，600 条上限 |
| 本地 RAG 索引 | `userData/data/knowledge-rag-index.json` | 文件块 + embedding |
| 工作区备份 | `workspace-backups/workspace-<ts>-<uuid>.sqlite` | 保留最近 3 份，保留最近 5 分钟不重复备份 |
| 内置法律库 | `app/.desktop/server/seeds/default-law-library.json` | 构建期由 `files/法律文件/` 生成 |
| 云端业务数据 | PostgreSQL | users / organizations / memberships / payment_orders / point_ledger / ai_gateway_requests / feedback / invoices / knowledge_files |
| 知识库向量 | Qdrant `knowledge_chunks` | 可选，仅 commercial 模式 |

旧版 `workspace.json` 仍在读取路径中：存在时按账号归属迁移到 sqlite，迁移失败会阻止自动重置而不是清库。

---

## 7. 并发与一致性约束

| 机制 | 位置 | 作用 |
| --- | --- | --- |
| `runExclusiveWorkspaceMutation` | `infrastructure/workspace-lock.ts` | 工作区「整体快照写入」必须串行，读-改-写互斥；模型调用放锁外，保证多材料可并发理解 |
| `mergeValue` 冲突检测 | `infrastructure/workspace-sqlite.ts` | 三方合并，检测到并发改同一字段时抛 `WORKSPACE_CONFLICT`（409） |
| 文档处理队列 | `infrastructure/document-jobs.ts` | 最多 2 个活跃 worker，16 个排队，超时 60s，单次处理 15 分钟上限 |
| 材料并发 | `EVIDENCE_SUMMARY_CONCURRENCY=3` | 多份材料并行理解 |
| 模型并发 | `EVIDENCE_UNDERSTANDING_LLM_CONCURRENCY=6` | 逐页与材料级共享配额，避免叠加压垮供应商 |
| 云端并发 | `CLOUD_AI_MAX_CONCURRENCY=3` | 桌面端按网关上限排队 |
| 上传并发 | `reserveUpload` | 同时最多 2 批 |
| 内存 | `--max-old-space-size=2048`（本地服务）/ `256`（文档 worker） | 几十份原件解码后的堆上限，避免 GC 把事件循环占死 |

---

## 8. 关键环境变量

### server/（本地后端）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `SERVER_HOST` | 8787 / `127.0.0.1` | 默认只监听回环，工作区与原件无鉴权 |
| `API_PREFIX` / `API_V1_PREFIX` | `/api` / `/api/v1` | 双前缀并存，旧接口不破坏 |
| `AI_GATEWAY_MODE` | `direct` | `direct` 直连供应商，`cloud` 走云端网关 |
| `KNOWLEDGE_RAG_MODE` | `local` | `local` / `commercial` / `auto` |
| `EVIDENCE_VISION_PAGE_LIMIT` | 10 | 扫描件逐页视觉理解的页数上限 |
| `EVIDENCE_RETRIEVAL_PAGE_THRESHOLD` | 500 | 超过此页数改走检索式理解 |
| `EVIDENCE_LLM_SINGLE_CALL_CHARS` | 20000 | 单次模型调用覆盖的正文长度 |
| `EVIDENCE_RETRIEVAL_MIN_SCORE_RATIO` / `_MIN_CHUNKS` | 0.25 / 6 | 检索命中门槛与强相关块下限 |
| `LLM_TIMEOUT_MS` | 60000 | 直连超时；云端 120000 |
| `MAX_EVIDENCE_FILE_MB` / `MAX_UPLOAD_BATCH_MB` | 512 / 512 | 单文件与单批上限 |
| `JSON_LIMIT` | 100mb | 桌面端工作区快照体积较大 |
| `COLLABORA_PROXY_PATH` / `_TARGET` | `/collabora` / `http://127.0.0.1:9980` | WOPI 反代 |

### cloud-server/（云端）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CLOUD_PORT` / `CLOUD_HOST` | 8788 / `0.0.0.0` | |
| `AI_GATEWAY_ENABLED` | false | 关闭时 `/api/ai` 直接 503 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | — | 网关上游；`LLM_CHAT_MODELS` 逗号分隔扩展可选模型 |
| `EMBEDDING_*` | — | `EMBEDDING_DIMENSION` 默认 1024 |
| `DATABASE_URL` | — | 缺省时退回 `dev-store` 文件存储 |
| `DEV_PAYMENT_SIMULATION` | false | 支付模拟开关 |
| `REFERRAL_REWARDS_ENABLED` | false | 推荐返积分开关 |

### 桌面端特殊处理

- `env.ts` 依次加载 `server/.env` 与 `server/.env.local`，均 `override: true`。
- `zod` schema 校验失败直接抛错启动，不做静默兜底。
- `.desktop/server/.env.local` 只写 7 项，不携带任何开发凭据进发行包。

---

## 9. 已知边界

- 本地工作区与证据原件**无鉴权**，服务端默认只绑 `127.0.0.1`；暴露到局域网需显式改 `SERVER_HOST`。
- 桌面端使用云端模型时，材料内容会发送到配置的服务（README「专业边界」已声明）。
- `web/preview-server.mjs` 是开发/轻量部署用静态服务，生产级静态托管与 TLS 由外层运维承担（未验证具体生产拓扑）。
- `service.ts` 单文件约 33 万字符、`App.tsx` 约 42 万字符，是当前最大的复杂度热点。

云端与本地的职责划分、数据出本机的实际范围，详见
[云端与本地的职责边界](cloud-local-boundary.md)。

