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

## 5. Collabora 对接平台官网域名

`docker-compose.collabora.yml` 已不再写死 `lawagent.zhijing.fun`，改为读取平台官网映射：

```powershell
$env:PLATFORM_WEB_DOMAIN="你的平台官网域名"
$env:PLATFORM_WEB_ORIGIN="https://你的平台官网域名:443"
docker compose -f .\docker-compose.collabora.yml up -d
```

说明：

- `PLATFORM_WEB_DOMAIN`：平台官网主机名
- `PLATFORM_WEB_ORIGIN`：Collabora 使用的完整 HTTPS 来源地址
