# LawVerify Windows 安装包签名说明

本文档用于把 LawVerify 的 Windows 安装包从“未知发布者”升级为可验证的商业发行包，降低浏览器下载与 Windows SmartScreen 的不信任提示。

## 1. 为什么会出现“不信任”

当用户下载 `LawVerify-Setup-*.exe` 时，Windows SmartScreen 主要看两件事：

1. 安装包是否带有有效代码签名
2. 该发布者和该文件是否已经建立足够的信誉

如果安装包未签名，或者签名主体无法识别，用户通常会看到：

- `发布者：未知`
- `Microsoft Defender SmartScreen 无法验证此文件是否安全`

这类提示无法通过前端页面文案消除，必须靠发行签名解决。

## 2. 推荐方案

LawVerify 面向真实商业用户，优先级建议如下：

1. 首选：`EV Code Signing` 证书
2. 次选：`Microsoft Trusted Signing`
3. 过渡方案：普通 `OV Code Signing` 证书

说明：

- 有效签名用于验证发布者与文件完整性，但任何签名方案都不保证立即消除 SmartScreen 提示
- 发布者和文件信誉、企业安全策略仍会影响拦截结果

## 3. 当前项目已接入的签名链路

桌面端打包位于：

- [app/package.json](file:///d:/trae_projects/lexVerify/app/package.json)

当前已经补好的关键点：

1. `electron-builder` 保持统一输出 `LawVerify-Setup-${version}.exe`
2. Windows 签名哈希算法固定为 `SHA-256`
3. 已配置 RFC3161 时间戳服务器
4. 已增加签名后校验命令：`npm run verify:signature`
5. `build:desktop:signed` 在构建前检查证书，强制启用签名，并在构建后验证安装器与客户端

普通 `build:desktop` 不等同于签名发行。签名构建会覆盖普通构建中关闭
可执行文件签名的设置；没有证书时立即失败，不再输出“签名成功”的未签名安装包。

签名检查脚本位于：

- [app/electron/inspect-windows-signature.ps1](file:///d:/trae_projects/lexVerify/app/electron/inspect-windows-signature.ps1)

## 4. 本地使用 PFX 证书签名

适用于你拿到企业代码签名证书 `.pfx` 的场景。

在 PowerShell 中进入：

```powershell
Set-Location "D:\trae_projects\lexVerify\app"
```

注入当前会话环境变量：

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"
$env:WIN_CSC_LINK="D:\certs\LawVerify-CodeSigning.pfx"
$env:WIN_CSC_KEY_PASSWORD="替换为你的证书密码"
```

然后执行：

```powershell
npm run build:desktop:signed
```

构建完成后验证签名：

```powershell
npm run verify:signature
```

如果要检查指定文件：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\electron\inspect-windows-signature.ps1" -InstallerPath ".\release\LawVerify-Setup-0.0.1.exe"
```

## 5. 验签通过的标准

至少要满足以下几项：

1. `Signature status` 为 `Valid`
2. `Publisher` 不再是 `UNSIGNED`
3. `Timestamp` 不为 `MISSING`
4. 资源管理器文件属性中的“数字签名”页可见
5. 用户打开安装包时不再显示 `发布者：未知`

## 6. 对外发行时的注意事项

为了持续积累 SmartScreen 信誉，下面几项要尽量稳定：

1. 品牌名固定使用 `LawVerify`
2. 官网下载域名长期一致
3. 安装包命名规则长期一致
4. 证书主体名称保持稳定
5. 每次发版都签名，不要混用已签名和未签名包

## 7. Trusted Signing 说明

如果后续采用 `Microsoft Trusted Signing`，整体方向不变，但签名方式不再是本地 `PFX` 注入，而是改为微软云签名流程。

这条路线更适合：

- 需要更快建立 SmartScreen 信誉
- 不希望长期保管本地私钥
- 希望把签名流程接入 CI/CD

## 8. 当前建议的最小闭环

对 LawVerify 当前阶段，建议按这个顺序推进：

1. 先采购 `EV` 证书或评估 `Trusted Signing`
2. 先把本地发行包全量改为已签名包
3. 每次发版前执行 `npm run verify:signature`
4. 再进行官网分发与真实用户下载验证

## 9. 相关文档

- [桌面开发常用命令](file:///d:/trae_projects/lexVerify/docs/desktop-dev-commands.md)
- [桌面端 package.json](file:///d:/trae_projects/lexVerify/app/package.json)
