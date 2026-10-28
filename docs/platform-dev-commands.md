# 平台联调一键命令

适用于本地同时启动：

- `web` 平台官网：`http://127.0.0.1:4273`
- `cloud-server` 云端接口：`http://127.0.0.1:8788`

## 1. 一键启动

在项目根目录执行：

```powershell
.\platform-dev.cmd start
```

如需启动前强制重新构建：

```powershell
.\platform-dev.cmd start -Rebuild
```

## 2. 查看状态

```powershell
.\platform-dev.cmd status
```

## 3. 停止服务

```powershell
.\platform-dev.cmd stop
```

## 4. 重启服务

```powershell
.\platform-dev.cmd restart
```

## 5. 自动恢复

在生产主机当前登录用户下执行一次：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-platform-recovery.ps1
```

安装登录启动任务 `LawVerify-Platform-Autostart` 和每分钟健康检查任务
`LawVerify-Platform-Recovery`。检查云端业务接口及官网；仅启动或恢复故障服务，
健康服务保持不变。允许电池供电运行，任务失败自动重试，重复运行不会启动多份服务。
任务采用当前用户登录会话，注销、关机、休眠期间不能提供公网服务。

`stop` 会写入手动停机标记，自动恢复不会干扰维护；`start` 或 `restart`
清除标记。恢复日志位于 `tmp/platform-runtime/recovery.log`，状态位于
`tmp/platform-runtime/state.json`。

```powershell
.\platform-dev.cmd ensure
Get-ScheduledTaskInfo -TaskName LawVerify-Platform-Recovery
Invoke-WebRequest -UseBasicParsing https://lawagent.zhijing.fun/api/web/site/config
```

恢复检查不接管其他程序占用的端口，也不重启 Cloudflared、数据库或 AI 提供方。
每分钟检查不等于零停机保证；发布后还需验证公网及桌面代理业务接口。

## 6. Collabora 对接平台官网域名

`docker-compose.collabora.yml` 已不再写死 `lawagent.zhijing.fun`，改为读取平台官网映射：

```powershell
$env:PLATFORM_WEB_DOMAIN="你的平台官网域名"
$env:PLATFORM_WEB_ORIGIN="https://你的平台官网域名:443"
docker compose -f .\docker-compose.collabora.yml up -d
```

说明：

- `PLATFORM_WEB_DOMAIN`：平台官网主机名
- `PLATFORM_WEB_ORIGIN`：Collabora 使用的完整 HTTPS 来源地址
