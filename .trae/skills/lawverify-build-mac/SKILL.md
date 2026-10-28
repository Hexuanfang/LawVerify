---
name: lawverify-build-mac
description: Build LawVerify macOS installers (arm64 + x64, unsigned or signed) through the project's GitHub Actions workflow mac-desktop.yml. Use when the user asks to package/build/repackage the macOS or DMG version, or when a release must cover both Windows and Mac. Requires gh CLI authenticated to Hexuanfang/LawVerify and a GitHub-reachable network. Do not use for the Windows EXE (use lawverify-build-exe), cloud-server-only builds, or website builds.
---

# LawVerify macOS Build (GitHub Actions)

Windows 本机无法构建 macOS 的 DMG（`electron-builder` 的 dmg 目标依赖 macOS
工具链）。因此 mac 安装包统一通过仓库自带的 GitHub Actions 工作流
`.github/workflows/mac-desktop.yml` 在 `macos-15` / `macos-15-intel`
runner 上远程构建，一条脚本完成：推送 → 触发 → 等待 → 下载 → 校验。

## Before you start

前置条件（按序确认，缺一不可）：

1. **gh CLI 已安装并认证**：
   - 安装：`winget install GitHub.cli`
   - 认证：`gh auth login`（选 GitHub.com → HTTPS → 浏览器/设备码）
   - 设备码流程注意「登录状态目录可写」：若默认目录写入失败，为 cookie 文件
     指定一个可写目录，例如
     `set GH_CONFIG_DIR=%LOCALAPPDATA%\gh` 后再执行 `gh auth login`。
   - 验证：`gh auth status`
2. **GitHub 网络可达**：本机需能连 `ssh`/`https` GitHub。若在国内网络环境，
   Git 不会自动继承 Windows 系统代理，需要为 GitHub 域名显式配置全局代理
   （端口以实际 VPN 为准，历史使用 `12450`）：
   ```
   git config --global "http.https://github.com/.proxy" "http://127.0.0.1:12450"
   ```
   取消代理：`git config --global --unset "http.https://github.com/.proxy"`。
   `git config --get "http.https://github.com/.proxy"` 用于确认是否已配置。
3. **远端仓库**：`origin` 指向 `https://github.com/Hexuanfang/LawVerify.git`。
4. **代码与版本已推送**：GitHub Actions 构建的是**远端**代码，不是本地代码。
   - 先在本地打通 Windows 打包流程（它会写回 `app/package.json` 的新版本号），
     commit 好所有改动，再把分支推到远端 `main`
     （构建历史使用 `build/mac-desktop-*` 分支，merge 回 `main` 后统一从
     `main` 触发）。
5. **Apple 账号（仅 signed 需要）**：`--Signed` 需要 GitHub Actions 环境变量
   `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` / `APPLE_ID` /
   `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`，以及 Apple Developer
   订阅。个人订阅签名身份显示为个人姓名；公司订阅需邓白氏编码（D-U-N-S）。
   未具备证书时默认走 unsigned（ad-hoc）测试包即可。

## Run

从仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".trae\skills\lawverify-build-mac\scripts\build-mac.ps1"
```

默认行为（构建 v<版本> 未签名双架构测试包）：

- 读取 `app\package.json` 的 `version`
- 检查 git / gh / 认证 / 代理 / 工作区与远端同步状态（可加 `-Push` 自动推送）
- 触发 `mac-desktop.yml` 的 `workflow_dispatch`（`signed=false`）
- 等待 runner 完成（arm64 + x64 各跑一遍 build → verify → 产出）
- 下载产物到 `app\release-mac-unsigned`
- 就地重算并比对每个 dmg/zip 的 SHA256

Flags（仅在用户明确要求时使用）：

- `-Signed` — 构建 Developer ID 签名 + Apple 公证版本（需 Apple 凭据）。
- `-Push`   — 先把本地已提交的改动 `git push` 到 origin 再触发构建。
- `-KeepDownloads` — 保留 GitHub Artifact 下载目录（默认整理后保留实际产物，
  各架构 Artifact 子目录会被平铺到目标根目录）。

## Post-check and report to the user

构建成功（退出码 0）后，汇总：

- 版本：`app\package.json` 中的 `version`（例如 `0.1.52`）。
- 产物目录：`app\release-mac-unsigned\`（signed 时为 `app\release-mac\`）。
- 文件清单：`LawVerify-Mac-<version>-arm64[-unsigned].dmg/.zip/.sha256`、
  `LawVerify-Mac-<version>-x64[-unsigned].dmg/.zip/.sha256`、
  `verification-all.json`。
- SHA256 已逐一比对通过。
- 注意：unsigned 测试包首次在 Mac 上运行需用户在
  「系统设置 → 隐私与安全性」中手动放行；正式商用必须走 signed + notarized。

## Expected warnings (not failures)

- 「Unsigned 包 ad-hoc 签名」属预期；`codesign` 校验步骤仍会执行。
- GitHub Actions 偶发网络超时需要重跑 build 步骤，not a code issue。
- `gh run watch` 进度输出较长，属正常。

## Failure handling

脚本任一环节失败即抛错并停止，报告具体命令与退出码，不要绕过失败手动修补。
常见排查：

- 触发返回 404 → 检查 `mac-desktop.yml` 是否存在、分支名是否正确。
- run 失败 → `gh run view <run-id> --log` 查看具体 job 日志。
- 下载不到文件 → 确认 run 状态为 `success`，并核对 artifact 命名
  （`LawVerify-Mac-<arch>-unsigned`）。