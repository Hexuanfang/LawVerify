# LawVerify 桌面开发常用命令

## 推荐的最小动作打包入口

以后优先使用仓库根目录的一键脚本，不需要再手动切到 `app` 目录：

```powershell
.\build-desktop.cmd
```

可选模式：

```powershell
.\build-desktop.cmd -Dir
.\build-desktop.cmd -Signed
```

- 默认：生成正式 `NSIS` 安装包
- `-Dir`：生成免安装目录版
- `-Signed`：生成签名安装包（需先注入证书环境变量）

以下命令默认在目录 `D:\trae_projects\lexVerify\app` 下执行。

## 1. 日常开发联调

启动前端、后端和 Electron 桌面壳，适合平时改 UI 和交互后立即看效果：

```bash
npm run dev:desktop
```

## 2. 构建免安装桌面版

生成 `win-unpacked` 目录，适合验证桌面运行效果，但不需要安装：

```bash
npm run build:desktop:dir
```

生成后可直接运行：

```bash
D:\trae_projects\lexVerify\app\release\win-unpacked\LawVerify.exe
```

## 3. 构建正式 Windows 安装包

生成正式 NSIS 安装包：

```bash
npm run build:desktop
```

安装包位置：

```text
D:\trae_projects\lexVerify\app\release\LawVerify-Setup-<version>.exe
```

## 4. 构建已签名安装包

在当前 PowerShell 会话先注入证书环境变量，再构建：

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"
$env:WIN_CSC_LINK="D:\certs\LawVerify-CodeSigning.pfx"
$env:WIN_CSC_KEY_PASSWORD="替换为你的证书密码"
npm run build:desktop:signed
```

## 5. 验证安装包签名状态

默认检查 `app/release` 目录下最新的 `LawVerify-Setup-*.exe`：

```powershell
npm run verify:signature
```

## 推荐工作流

1. 平时开发：`npm run dev:desktop`
2. 本地回归打包：`.\build-desktop.cmd -Dir`
3. 正式 EXE 打包：`.\build-desktop.cmd`
4. 交付前签名：`.\build-desktop.cmd -Signed`
5. 发版前验签：`npm run verify:signature`
