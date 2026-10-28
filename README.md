<p align="center">
  <a href="https://lawagent.zhijing.fun/">
    <img src="docs/lawverify-mark.svg" width="88" height="88" alt="LawVerify 品牌标记">
  </a>
</p>

<h1 align="center">LawVerify</h1>

<p align="center">
  <strong>让每一句主张，都有据可查。</strong>
</p>

<p align="center">
  面向律师的案件分析、证据联动与文书核验工作台。<br>
  理解原件，梳理争议，围绕代理目标组织主张与举证思路。<br>
  从案件记忆到文书写作，从具体陈述到逐句核验，让事实与依据始终相伴。
</p>

<p align="center">
  <a href="https://lawagent.zhijing.fun/download"><img src="https://img.shields.io/badge/Windows-DOWNLOAD-2945DF?style=for-the-badge" alt="下载 Windows 客户端"></a>
  <a href="https://lawagent.zhijing.fun/download"><img src="https://img.shields.io/badge/macOS-APPLE%20SILICON-202227?style=for-the-badge&amp;logo=apple&amp;logoColor=white" alt="下载 Apple 芯片 Mac 客户端"></a>
  <a href="https://lawagent.zhijing.fun/download"><img src="https://img.shields.io/badge/macOS-INTEL-65666F?style=for-the-badge&amp;logo=apple&amp;logoColor=white" alt="下载 Intel Mac 客户端"></a>
</p>

<p align="center">
  <a href="https://lawagent.zhijing.fun/">官网</a> ·
  <a href="https://lawagent.zhijing.fun/download">下载中心</a> ·
  <a href="#产品特色">产品特色</a> ·
  <a href="#典型工作流">办案场景</a> ·
  <a href="#开发环境">开发指南</a> ·
  <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="app/package.json"><img src="https://img.shields.io/badge/source-v0.1.52-2945DF?style=flat-square" alt="当前源码版本 v0.1.52"></a>
  <a href="https://github.com/Hexuanfang/LawVerify/stargazers"><img src="https://img.shields.io/github/stars/Hexuanfang/LawVerify?style=flat-square&amp;color=2945DF" alt="GitHub Stars"></a>
  <a href="https://github.com/Hexuanfang/LawVerify/commits/main"><img src="https://img.shields.io/github/last-commit/Hexuanfang/LawVerify/main?style=flat-square&amp;color=65666F" alt="最近一次 main 分支提交"></a>
</p>

<p align="center">
  <a href="#1-句级联动从找到相关材料走向核对具体主张"><img src="https://img.shields.io/badge/证据联动-句级核验-2945DF?style=flat-square" alt="证据联动：句级核验"></a>
  <a href="#2-案件记忆保留律师真正关心的案情结构"><img src="https://img.shields.io/badge/案件记忆-持续复用-6554C0?style=flat-square" alt="案件记忆：持续复用"></a>
  <a href="#3-案件助手围绕代理目标组织主张与举证思路"><img src="https://img.shields.io/badge/案件助手-主张与举证-357A5B?style=flat-square" alt="案件助手：主张与举证"></a>
</p>

---

LawVerify 将分散的案件材料转化为可持续使用的案件记忆，把代理立场、争议焦点、证据原件、法律条文与案例参照放在同一办案工作流中。

产品的核心不止于生成一份文书，更在于帮助律师回答：**这句话由什么材料支持？证明到什么程度？还有哪些矛盾和缺口？**

## 产品特色

| 核心能力 | 为办案带来的价值 |
| --- | --- |
| 句级证据联动 | 将具体陈述与证据关联，逐句核验，减少全文反复翻找 |
| 案件级长期记忆 | 持续保留争议焦点、时间线、主张与抗辩，不必每次重新介绍案情 |
| 代理立场驱动的案件助手 | 围绕已确认的代理方和办案目标，梳理主张、举证责任与补证方向 |
| 原件理解与律师关注 | 从材料内容提取证明目的、关键事实、争议和证明局限 |
| 证据、法条、案例协同核验 | 在当前句旁查看关联依据，保持文书正文整洁 |
| 连续文稿与流式写作 | 边生成边审阅，支持定向改写、人工修订和 Word 导出 |

### 1. 句级联动：从“找到相关材料”走向“核对具体主张”

证据关联锚定到文书中的具体句子，而非笼统挂在整篇文书或段落上。

- 结合全案背景与段落语义，判断当前句是否需要证据、法条或案例支持。
- 基于材料内容、显式提及和语义检索召回候选，再核对其与当前陈述的适配关系。
- 高亮当前句，支持上一句、下一句导航，在侧边对照关联材料与原件。
- 支持人工绑定、解绑与纠正；同一份证据可以用于核验不同句子的主张。

**引用在侧边，正文保持清爽。** 写作与核验不必拆成两个互不衔接的过程。

### 2. 案件记忆：保留律师真正关心的案情结构

LawVerify 不只保存一段案情摘要，还会结合已链接材料，形成可用于后续讨论、写作和核验的案件总览。

| 分析维度 | 关注内容 |
| --- | --- |
| 争议与立场 | 争议焦点、双方主张与抗辩、待核实事实 |
| 事实脉络 | 事件时间线、关键人物、关键金额与资金往来 |
| 证据结构 | 事实与证据支持矩阵、材料矛盾、证明薄弱点 |
| 办案关注 | 待补强问题、证明责任及程序风险关注事项 |

材料变更后可更新梳理结果，也可手动“重新梳理案件”。同一案件的讨论与文书撰写可以复用已有理解，减少反复整理背景的工作。

### 3. 案件助手：围绕代理目标组织主张与举证思路

律师可以通过自然语言说明代理当事人、诉讼地位、办案目标、认可事项、争议事项和办案约束，经确认后用于案件分析。

- 按主张梳理成立要件与证明责任。
- 区分支持材料、不利材料、补证事项和备选论证。
- 提示对方可能的反驳、应对思路、下一步行动与风险关注。
- 围绕本案材料继续讨论案情，代理立场的调整需再次确认。

**代理立场决定论证方向，不改变客观事实。** 系统保留不利材料和矛盾，不将当事人单方陈述直接视为已证实事实。

### 4. 原件理解：从文件摘要深入到证明目的与证明局限

支持 Word、PDF、图片和文本的解析或预览，结合可用的原文、页图与视觉模型理解材料，而非仅根据文件名推断内容。

- 提取证明目的、关键事实、金额、时间、争议点与证明局限。
- 在原件预览旁呈现“律师关注”，帮助识别需要进一步核验的事项。
- 区分原始证据、文书底稿与身份资格类材料，减少将主张性材料误当作独立证明的情况。
- 按材料内容指纹复用理解结果；内容变更或主动刷新时重新分析，减少重复等待与模型费用。

### 5. 法律与案例参照：让论证依据回到可核对的来源

内置法律文件与真实 Embedding 向量索引，支持语义检索、条文级查找，以及官方法源核对；可配置接入元典、威科先行、北大法宝等案例来源。

法条与案例参照可以关联到具体句子，与证据一同在侧边审阅。重点是核对条文内容、裁判争议与适用条件，而不是堆叠引用数量。外部来源须具备相应配置和使用权限。

### 6. 文书工作台：写作、核验与交付连续进行

采用接近 Word 连续文稿的编辑体验，支持文书导入、AI 辅助撰写、流式生成、定向改写、备注和 Word 导出。

律师可以边生成边审阅，结合案件记忆修订表达，在当前句查看证据与法律依据，再导出继续打磨。证据目录与原件预览伴随正文工作区，减少跨窗口切换。

### 7. 多目录材料与跨平台桌面体验

同一案件可链接多个本地文件夹，增量导入材料，保留原件并支持大文件分批处理。案件与文书工作区存储在本地，桌面安装包内置业务服务，终端用户无需另装 Node.js、Docker 或数据库。

提供 Windows 客户端，以及 Apple 芯片、Intel 两种架构的 macOS 测试包。官网统一提供下载与账户中心，支持账户、积分、订单、支付和发票业务。

## 典型工作流

**链接材料 → 理解原件 → 梳理案件 → 确认代理立场 → 形成举证思路 → 撰写文书 → 逐句核验 → 导出 Word**

| 办案场景 | 使用方式 |
| --- | --- |
| 接案与阅卷 | 汇总多目录材料，阅读原件理解与案件总览，识别争议和待核实事项 |
| 举证准备 | 对照主张、成立要件、支持与不利材料，梳理补证方向 |
| 质证意见与法律文书 | 结合案件记忆组织草稿，定向修改，再逐句核对材料与依据 |
| 庭前审阅 | 沿句级导航检查关键事实陈述、引用来源与证明缺口 |

## 专业边界

LawVerify 是律师的辅助工作台，不替代专业判断，也不承诺胜诉或核验准确率。**材料相关不等于证明成立，模型生成不等于事实认定。** 证据原件、法条效力、案例出处与适用条件仍需律师核对。

图像与扫描件的理解取决于原件质量、页图和模型配置，不承诺所有格式均具备完整 OCR、语音转写或页内坐标定位能力。案件与原件在本地保存不等于全部处理离线：使用云端或外部模型时，相关材料内容可能发送至配置的服务，应按保密要求确认授权与数据处理范围。

当前源码桌面版本为 `0.1.52`，以 [`app/package.json`](app/package.json) 为准，各平台发行状态以官网下载为准。macOS 当前提供未完成 Developer ID 签名与 Apple 公证的测试包，正式发行与真实设备验收要求见 [Mac 构建与发行](docs/mac-desktop-build.md)。

## 架构

```text
Windows / macOS Electron 客户端 / 浏览器工作台
  └─ server：本地案件、证据、文书、AI 与检索
       ├─ SQLite 工作区 + 本地原件及资产
       ├─ LLM / 视觉模型 / Embedding / 案例 MCP
       └─ cloud-server：云端身份、积分及账户业务

官网与账户中心 web
  └─ preview-server：静态页面 + /api/* 代理
       └─ cloud-server
            └─ PostgreSQL：账户、订单、积分账本等
```

桌面安装包内置本地服务，不要求终端用户安装 Node.js、Docker、PostgreSQL 或 Qdrant。但云端账户、模型和外部检索能力依赖相应服务，不能因此视为完全离线产品。

| 目录 | 职责 |
| --- | --- |
| `app/src/` | React + TypeScript + Tiptap 工作台 |
| `app/electron/` | 桌面启动、IPC、更新、资源准备与验签 |
| `server/src/` | Express API、文书联动、材料理解、本地工作区 |
| `server/src/intelligence/` | 证据匹配、句级门控、模型响应解析 |
| `server/src/integrations/` | LLM、Embedding、Qdrant、案例 MCP、Collabora |
| `cloud-server/src/` | 云端认证、账务、支付、发票、发行与管理 |
| `web/` | 官网与账户中心、静态服务及 API 代理 |
| `files/法律文件/` | 构建内置法律库的 Word 源文件 |
| `scripts/`、`docs/` | 构建部署工具与专题文档 |

主入口为各模块的 `package.json`、`src/index.ts` 和 `app/electron/main.cjs`。根目录历史 JavaScript 文件不是下列推荐启动命令的入口。

### 关联如何工作

`材料理解 → 案件记忆 → 段落上下文 → 句级关联需求 → 候选召回 → 适配校验 → 挂接原句`

证据召回结合内容线索、显式提及和向量相似度；法条、案例走各自检索与适配流程。句级门控、候选 ID 校验、摘录来源检查和数量限制用于减少无关关联，人工绑定用于补充或纠正。

这些检查不是准确率保证。混合事实与法律评价的句子仍可能漏链，摘要匹配不等于原件逐页核验，模型置信度也不是经过校准的准确率。核心实现见 [`service.ts`](server/src/service.ts) 和 [`linkage-policy.ts`](server/src/intelligence/linkage-policy.ts)。

## 开发环境

- Windows 使用 NSIS 构建，macOS 使用 DMG 构建；PowerShell 运维脚本以 Windows 为目标平台，Mac 构建可通过 GitHub Actions 或 Mac 本机完成。
- 推荐 **Node.js 22.23.1 或兼容的较新版本**、npm、Git。本地工作区使用内置 `node:sqlite`，不要使用旧版 Node。
- 云端账户平台需要 PostgreSQL；`commercial` 知识库模式还需要服务端 PostgreSQL、Qdrant 和 Embedding。
- LLM、视觉模型、Embedding 与外部案例库需要各自的配置和授权。

仓库没有根级 npm workspace，依赖按模块安装。以下命令均从仓库根目录运行。

```powershell
npm --prefix server ci
npm --prefix app ci
npm --prefix cloud-server ci
npm --prefix web ci
```

### 本地工作台

首次创建配置文件，已有配置不要覆盖：

```powershell
Copy-Item server/.env.example server/.env.local
Copy-Item app/.env.example app/.env.local
```

编辑 `server/.env.local`：

- 保留 `KNOWLEDGE_RAG_MODE=local`，无需为本地工作区启动数据库服务。
- 若不使用服务端 PostgreSQL，清空模板中的 `DATABASE_URL`，避免误连示例数据库。
- 设置独立的 `JWT_SECRET`，按需填写 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 和 `EMBEDDING_*`。
- 图像理解另配 `LLM_VISION_*`；案例库另配 `YUANDIAN_*`、`WK_*`、`PKULAW_*`。
- 接入自建账户平台时，设置 `CLOUD_API_BASE_URL`。

`app/.env.local` 的 `VITE_API_BASE_URL` 指向本地服务；`VITE_CLOUD_API_BASE_URL` 和 `VITE_ACCOUNT_CENTER_URL` 默认指向正式官网。自建联调请改为自己的平台地址，不要对生产账户执行测试扣费。

```powershell
# 浏览器工作台：API 8787 + Vite 5173
npm --prefix app run dev:stack

# 或桌面联调：同时启动 API、Vite 和 Electron
npm --prefix app run dev:desktop
```

两条命令二选一，勿同时启动。未配置模型时不能据此认定 AI 理解、向量检索或生成能力已经验证。

### 官网与云端平台

```powershell
Copy-Item cloud-server/.env.example cloud-server/.env.local
Copy-Item web/.env.example web/.env.local
```

在云端配置中设置 PostgreSQL `DATABASE_URL`、独立 `JWT_SECRET`、网站来源及回调 URL。本地联调将 `web/.env.local` 中的 `VITE_CLOUD_API_BASE` 设为 `http://127.0.0.1:4273`，工作台的云端地址也相应修改。

可选的开发数据库：

```powershell
docker compose -f docker-compose.cloud-postgres.yml up -d
```

该 Compose 使用 PostgreSQL 16，主机端口 `54329`、数据库 `lawverify_cloud`，凭据见 Compose 文件，仅适合开发。已有 PostgreSQL 时不需要 Docker。

```powershell
npm --prefix cloud-server run migrate
.\platform-dev.cmd start -Rebuild
.\platform-dev.cmd status
# 停止：.\platform-dev.cmd stop
```

平台脚本负责官网 `4273` 和云端 `8788`，会停止占用这两个端口的进程，运行前确认无其他重要服务。它不负责启动 PostgreSQL、Qdrant、Cloudflare Tunnel 或桌面工作台。

| 服务 | 默认地址 |
| --- | --- |
| 工作台前端开发 | `http://127.0.0.1:5173` |
| 工作台 API / 健康检查 | `http://127.0.0.1:8787/api/health` |
| 打包桌面本地服务 | 从 `18787` 起选择可用端口 |
| 官网及 API 代理 | `http://127.0.0.1:4273` |
| 云端健康检查 | `http://127.0.0.1:8788/health` |

`npm --prefix web run dev` 仅启动网站 Vite 开发服务，不等同于带 API 代理的 `preview-server.mjs`。服务端和云端配置依次读取 `.env`、`.env.local`，后者优先；修改前端 `VITE_*` 后需重启开发服务或重新构建。

## 构建与验证

```powershell
npm --prefix server run test:workspace
npm --prefix server run test:linkage
npm --prefix server run build
npm --prefix app run build
npm --prefix cloud-server run build
npm --prefix web run build
npm --prefix app run lint
```

这些测试覆盖工作区及联动回归，不代表所有外部模型、支付渠道或安装环境已通过端到端验证。

Windows 安装包：

```powershell
.\build-desktop.cmd -Dir
.\build-desktop.cmd
# 配置签名凭据并核对签名设置后：
.\build-desktop.cmd -Signed
npm --prefix app run verify:signature
```

产物位于 `app/release/`，安装包名为 `LawVerify-Setup-<version>.exe`。根目录构建脚本使用当前版本，不自动升级版本号。

内置法律库使用真实向量缓存，构建时校验原件指纹并复用匹配结果；法律原件变更后需配置可用 Embedding API 重新生成并导出缓存，可能产生费用，不可用空库或关键词索引替代。商业发行前必须实际验证签名。当前 `signAndEditExecutable=false`，`-Signed` 也不能单独保证产物已签名；有效签名不保证完全消除 SmartScreen 提示。

macOS 的双架构构建、签名、公证与验证流程见 [Mac 构建与发行](docs/mac-desktop-build.md)，下载完整性检查见 [发行下载验证](docs/download-release-verification.md)。

## 数据与安全

- 本地工作区保存为 SQLite，包含案件、文书、理解结果及句级关联；原件和媒体资产独立存储。旧 JSON 仅供首次事务迁移，不再持续写入。
- 桌面数据位于 `%APPDATA%\LawVerify\data` 和 `%APPDATA%\LawVerify\storage`；开发服务默认使用 `server/data`、`server/storage`，可通过路径环境变量修改。
- 备份前关闭客户端，备份完整数据和存储目录。不要单独删除 WAL/SHM，也不要用旧 JSON 覆盖新 SQLite。详见[工作区存储](docs/workspace-storage.md)。
- `.env*`（除模板）、日志、依赖、缓存、构建产物和案件运行资料不应提交。已经进入 Git 历史的敏感数据须另行清理，泄露密钥须轮换。
- **发行前检查密钥打包**：`prepare-desktop.cjs` 当前生成不含开发密钥的桌面配置，默认使用云端 AI 网关，不复制开发环境中的模型与 MCP 凭据。发行时仍需检查最终产物，禁止将平台共享密钥写入前端、安装包或 Git。
- **云端上线前必须处理默认管理员初始化**：当前 `seedAdminAccount()` 带有固定开发凭据且启动时可能重设密码。须调整该逻辑，并审查 `ADMIN_EMAILS`、权限、HTTPS、来源白名单、支付回调验签和日志脱敏，不能仅更换环境变量便认定可安全上线。
- 支付商户密钥只留在云端。`DEV_PAYMENT_SIMULATION` 仅用于隔离的开发环境。
- 反馈问题请提供版本、复现步骤、期望与实际结果；截图和材料应先脱敏。

## 更多文档

- [工作区存储与迁移](docs/workspace-storage.md)
- [桌面开发命令](docs/desktop-dev-commands.md)
- [平台运行命令](docs/platform-dev-commands.md)
- [Windows 签名](docs/windows-code-signing.md)
- [Mac 构建与发行](docs/mac-desktop-build.md)
- [发行下载验证](docs/download-release-verification.md)
- [多法源案例接入](docs/legal-case-mcp.md)
- [官方法源](docs/legal-official-sources.md)
- [证据匹配设计](docs/evidence-matching-architecture.md)

部分早期设计文档包含历史状态或规划；运行方式和现状以源码、配置模板及本 README 为准。

## 许可

仓库尚未提供项目级开源许可证。代码可见不等于获准复制、再分发或商业使用；第三方依赖和法律、案例来源分别适用各自许可。
