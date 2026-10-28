# LawVerify Mac 构建与发行

## 当前方案

- 共用现有客户端与内置服务代码，分别构建 Apple 芯片（arm64）和 Intel（x64）。
- 当前版本以 `app/package.json` 为准，本次保留 0.1.52，不修改 Windows 安装包。
- 未签名测试包采用本机临时签名（ad-hoc），不代表 Developer ID 签名或 Apple 公证。
- 测试包写入 `app/release-mac-unsigned/`；正式签名包写入 `app/release-mac/`。
- 测试包不会随构建自动部署；经明确授权可手动开放官网下载，不进入稳定版自动更新。

## GitHub 云端构建

工作流：`.github/workflows/mac-desktop.yml`。

首次推送到 `build/mac-desktop-*` 分支会自动生成未签名测试包，不需要 Apple 凭据。
工作流合并到默认分支后，也可在 GitHub Actions 中手动运行 `Build Mac desktop`，
将 `signed` 保持为 false。

两台 macOS runner 分别原生构建并验证 Apple 芯片和 Intel 安装包。
在成功任务的 Artifacts 中下载对应架构的归档，解压后得到：

- `LawVerify-Mac-0.1.52-arm64-unsigned.dmg`
- `LawVerify-Mac-0.1.52-x64-unsigned.dmg`
- 对应 ZIP、SHA256 文件和 `verification-*.json`

Artifact 默认保存 30 天，不等同于官网正式下载地址。版本变动时文件名随之变化。
构建失败不会上传未经验证的安装包。

## 法律库与依赖

`app/build/default-law-library.json` 保存已经生成的真实 1024 维法律向量及来源指纹，
不含 API 密钥。构建时校验法律原件的 SHA256 指纹，匹配后直接复用，
无需向 GitHub 配置模型凭据，也不会重复调用 Embedding 服务。

法律原件变更后，先在本地重新生成种子，再执行：

```powershell
npm.cmd --prefix app run export:law-cache
```

导出时核对每份原件全文、分块内容、向量数量和维度。CI 遇到旧缓存会中止构建，
不能用空库或关键词索引代替真实向量。云端通过锁文件安装依赖。

## Apple 账号开通后

1. 创建 **Developer ID Application** 证书，并保存配套私钥。
2. 从钥匙串导出带密码的 `.p12`；只含证书、不含私钥的 `.cer` 不能用于云端签名。
3. 在 GitHub 仓库的 `mac-signing` Environment 中配置以下 Secrets：

| Secret | 内容 |
| --- | --- |
| `MAC_CSC_LINK` | `.p12` 文件的 Base64 内容 |
| `MAC_CSC_KEY_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_ID` | Apple 开发者账户邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple 账户生成的专用密码，不是登录密码 |
| `APPLE_TEAM_ID` | 开发者后台显示的 Team ID |

建议为 `mac-signing` 设置人工审批，并限制可运行的发行分支。
不要把这些内容写入代码、聊天、日志或 Git。

工作流在默认分支可手动运行后，将 `signed` 设为 true。
它会从同一版本源码重新生成正式包，执行 Developer ID 签名、
应用公证及票据装订，再提交最终 DMG 公证并装订票据。
缺少凭据、签名失败或公证失败都会中止任务。

正式文件名不再带 `-unsigned`：

- `LawVerify-Mac-0.1.52-arm64.dmg`
- `LawVerify-Mac-0.1.52-x64.dmg`

不能把测试包重命名为正式包，也不能用重新压缩替代签名、公证。
同一正式版本已经发行后，修改源码或重新发行应提升版本号。

## Mac 本地构建

在 Mac 安装 Node.js 22 并安装依赖后，在仓库根目录执行：

```bash
npm ci --prefix server
npm ci --prefix app
npm --prefix app run build:mac -- --arch arm64
# Intel 使用 --arch x64
```

正式构建先安全配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、
`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，再运行：

```bash
npm --prefix app run build:mac:signed -- --arch arm64
```

Windows 入口会明确拒绝 DMG 构建，避免误将 Windows Electron 打入 Mac 包。

## 验证与上线

自动检查包括：构建类型检查、Electron SQLite 读写、打包后的原生架构、
实际应用中的 SQLite 和内置服务健康检查、代码签名完整性、
DMG/ZIP 完整性与 SHA256；正式包额外校验 Gatekeeper 和公证票据。

自动检查不替代真实用户的 GUI 验收。正式上线前分别在 Apple 芯片、Intel Mac 上验证：

1. 从浏览器下载并核对 SHA256，打开 DMG，将应用拖入“应用程序”。
2. 启动、登录、导入文件夹，验证 PDF/Word/图片预览及文书导出。
3. 关闭窗口后从 Dock 重新打开，确认工作区正常。
4. 用新版替换旧版，确认案件、证据与登录状态按预期保留。
5. 验证更新检测只返回本机系统与芯片对应的 DMG。

未公证测试包可能被 Gatekeeper 阻止；仅用于受控测试，不要求用户关闭系统安全保护。
GitHub runner 的后台健康检查不能证明所有 GUI 功能已经通过。

正式发行验收通过后，将正式 DMG 放入 `app/release/`。复制时先用临时扩展名，
复制完成并核对校验值后再原子重命名为最终名称，避免下载半成品。
下载页按平台与芯片筛选；旧 Windows 客户端未带查询参数时仍返回 Windows x64。
Mac 更新下载后校验 SHA256、打开 DMG 并退出应用，由用户拖入“应用程序”替换旧版。

## 手动开放测试人员下载

2026-10-28 经授权将两套 0.1.52 Mac 测试 DMG 校验后原子复制到 `app/release/`，
并部署官网与云端分发服务。页面按普通 Mac 下载入口展示，不额外添加签名或公证提示；
云端保留 `channel: test`，`/api/web/releases/latest` 始终排除测试包。

官网入口：`https://lawagent.zhijing.fun/download`。
原始测试产物仍保留在 `app/release-mac-unsigned/`。

在 `cloud-server` 目录验证本地完整下载：

```powershell
node --import tsx src/scripts/test-mac-download.ts --full
```

在 `cloud-server` 目录验证公网完整下载：

```powershell
node --import tsx src/scripts/test-mac-download.ts --base https://lawagent.zhijing.fun --full
```

遇到传输连接中断时，可验证分段安全续传后的完整文件：

```powershell
node --import tsx src/scripts/test-mac-download.ts --base https://lawagent.zhijing.fun --full --resume --arch x64
```

`--arch` 可选 `arm64` 或 `x64`。需要本机代理时，配置 `HTTPS_PROXY`，
并在 Node.js 命令中加入 `--use-env-proxy`；校验值不匹配不会被重试掩盖。

测试覆盖两套真实 DMG 的元数据、稳定更新隔离、文件长度、Range、
校验文件及完整下载后的 SHA256。测试包开放下载不代表已完成 Apple 公证或 GUI 验收。
