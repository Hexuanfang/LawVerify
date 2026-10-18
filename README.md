# LawVerify

[English](README.en.md) | 简体中文

**面向律师的证据整理、文书撰写与逐句核验工作台。**

LawVerify 将案件材料、文书、法律依据与案例参照放在同一工作流中，帮助律师查看原件、梳理争议、核对引用。项目包含 Windows 桌面客户端、本地业务服务，以及独立的官网与账户平台。

官网：[lawagent.zhijing.fun](https://lawagent.zhijing.fun/)

> AI 输出用于辅助审阅，不替代律师判断。材料相关不等于能够证明主张；法条、案例、证据摘录及适用条件仍须人工核对。当前桌面版本以 [`app/package.json`](app/package.json) 为准，为 `0.1.33`。

## 核心功能

- **案件与证据管理**：链接多个本地文件夹、增量导入材料，支持 Word、PDF、图片及文本的解析或预览；大文件采用分批导入和原件对象存储。
- **文书工作台**：基于 Tiptap 编辑、导入和 AI 撰写文书，支持流式生成、Word 导出、备注及证据绑定或解绑。
- **句级核验**：高亮当前句、前后句导航，在侧边查看关联的证据原件、法律条文和案例。
- **材料理解与案件记忆**：提取证明目的、关键事实、争议点、证明局限与律师关注事项；按内容指纹复用理解结果，汇总全案背景。
- **法律知识与案例参照**：内置法律文件、按条文检索、Embedding 向量检索，以及元典、威科先行、北大法宝 MCP 接入。外部来源须自行配置并取得使用权限。
- **账户平台**：官网、定价、下载、账户中心、积分、支付、发票和用户反馈；管理功能与普通用户入口隔离。

图片和扫描件的可理解程度取决于原件质量、页图与模型配置。不要把空白 OCR 或占位文字视为完成识别；本项目不承诺所有格式均具备完整 OCR、ASR 或页内坐标定位能力。

## 架构

```text
Windows Electron 客户端 / 浏览器工作台
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

- Windows 为桌面构建及 PowerShell 运维脚本的主要目标平台。
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

`prepare:desktop` 会重新生成内置法律库的向量索引，须配置可用 Embedding API，可能产生费用；不可删除法律源文件来绕过失败。商业发行前必须实际验证签名。当前 `signAndEditExecutable=false`，`-Signed` 也不能单独保证产物已签名；有效签名不保证完全消除 SmartScreen 提示。

## 数据与安全

- 本地工作区保存为 SQLite，包含案件、文书、理解结果及句级关联；原件和媒体资产独立存储。旧 JSON 仅供首次事务迁移，不再持续写入。
- 桌面数据位于 `%APPDATA%\LawVerify\data` 和 `%APPDATA%\LawVerify\storage`；开发服务默认使用 `server/data`、`server/storage`，可通过路径环境变量修改。
- 备份前关闭客户端，备份完整数据和存储目录。不要单独删除 WAL/SHM，也不要用旧 JSON 覆盖新 SQLite。详见[工作区存储](docs/workspace-storage.md)。
- `.env*`（除模板）、日志、依赖、缓存、构建产物和案件运行资料不应提交。已经进入 Git 历史的敏感数据须另行清理，泄露密钥须轮换。
- **发行前检查密钥打包**：`prepare-desktop.cjs` 会从 `server/.env.local` 复制包括模型和 MCP 密钥在内的白名单配置到安装包。切勿将平台共享密钥直接分发给用户；生产方案应使用受控服务或用户自有凭据。
- **云端上线前必须处理默认管理员初始化**：当前 `seedAdminAccount()` 带有固定开发凭据且启动时可能重设密码。须调整该逻辑，并审查 `ADMIN_EMAILS`、权限、HTTPS、来源白名单、支付回调验签和日志脱敏，不能仅更换环境变量便认定可安全上线。
- 支付商户密钥只留在云端。`DEV_PAYMENT_SIMULATION` 仅用于隔离的开发环境。
- 反馈问题请提供版本、复现步骤、期望与实际结果；截图和材料应先脱敏。

## 更多文档

- [工作区存储与迁移](docs/workspace-storage.md)
- [桌面开发命令](docs/desktop-dev-commands.md)
- [平台运行命令](docs/platform-dev-commands.md)
- [Windows 签名](docs/windows-code-signing.md)
- [多法源案例接入](docs/legal-case-mcp.md)
- [官方法源](docs/legal-official-sources.md)
- [证据匹配设计](docs/evidence-matching-architecture.md)

部分早期设计文档包含历史状态或规划；运行方式和现状以源码、配置模板及本 README 为准。

## 许可

仓库尚未提供项目级开源许可证。代码可见不等于获准复制、再分发或商业使用；第三方依赖和法律、案例来源分别适用各自许可。
