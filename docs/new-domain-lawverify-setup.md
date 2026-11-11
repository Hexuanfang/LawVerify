# 新域名 lawverify.zhijing.fun 上线操作清单

仓库侧已完成域名切换（官网链接、canonical、下载链接、注册邀请链接统一到 `lawverify.zhijing.fun`，
`lawagent.zhijing.fun` 继续可用）。本文件只描述**服务器侧**需要人工执行的步骤。

## 现状（已在服务器上核实）

| 项 | 值 |
| --- | --- |
| 域名解析 | `lawagent.zhijing.fun`、`lawverify.zhijing.fun` 均 A 记录指向 `60.205.199.126` |
| 80/443 入口 | 宿主机上的 `diagnosis-test-web-1` 容器内的 nginx（源码 `/opt/diagnosis-test/nginx.https.conf`，挂载为容器内 `/etc/nginx/conf.d/default.conf`） |
| LawVerify 官网 | 容器 `lawverify-web-1`，宿主机端口 `8090`，外层反代 `proxy_pass http://172.19.0.1:8090` |
| 云端接口 | 容器 `lawverify-cloud-server-1`，由官网容器内 nginx 以 `/api/*` 同源反代 |
| 证书 | `/opt/diagnosis-test/certs/<域名>.pem|.key`，由 `/opt/lawverify/deploy/issue-cert.sh` 用 certbot 容器 webroot 方式签发 |
| 续期 | root crontab，每周一次执行 `issue-cert.sh`（当前只签 `lawagent.zhijing.fun`） |

因为新域名尚未在 nginx 中配置，也没有证书，`https://lawverify.zhijing.fun/` 目前命中默认站点并证书校验失败。

## 步骤

### 1. 备份外层 nginx 配置

```bash
cp -a /opt/diagnosis-test/nginx.https.conf /opt/diagnosis-test/nginx.https.conf.bak.$(date +%Y%m%d%H%M)
```

### 2. 先加 80 端口的 server 块（签证书要用 ACME 校验路径）

在 `/opt/diagnosis-test/nginx.https.conf` 末尾追加：

```nginx
# ---- LawVerify：lawverify.zhijing.fun -> /opt/lawverify（docker compose 项目 lawverify，宿主机 8090）----
server {
  listen 80;
  server_name lawverify.zhijing.fun;
  location /.well-known/acme-challenge/ { root /var/www/certbot; }
  location / { return 301 https://$host$request_uri; }
}
```

### 3. 校验并重载

```bash
docker exec diagnosis-test-web-1 nginx -t
docker exec diagnosis-test-web-1 nginx -s reload
```

### 4. 签发新域名证书

复用现有脚本（脚本结尾会自动 `nginx -t` 并 reload）：

```bash
DOMAIN=lawverify.zhijing.fun \
ACME_WEBROOT=/opt/diagnosis-test/certbot-www \
CERT_DIR=/opt/diagnosis-test/certs \
NGINX_CONTAINER=diagnosis-test-web-1 \
/opt/lawverify/deploy/issue-cert.sh
```

### 5. 补上 443 server 块

证书就位后，再在同一个配置文件追加：

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name lawverify.zhijing.fun;

  ssl_certificate /etc/nginx/certs/lawverify.zhijing.fun.pem;
  ssl_certificate_key /etc/nginx/certs/lawverify.zhijing.fun.key;
  ssl_protocols TLSv1.2 TLSv1.3;

  location / {
    proxy_pass http://172.19.0.1:8090;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 30m;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
  }
}
```

然后：

```bash
docker exec diagnosis-test-web-1 nginx -t
docker exec diagnosis-test-web-1 nginx -s reload
```

### 6. 续期任务加上新域名

当前 root crontab 里只有一条签发记录，用 `crontab -l` 查看后，在同一时间追加一条（注意 `17 4 * * 1` 的分钟和小时保持一致）：

```
17 4 * * 1 DOMAIN=lawverify.zhijing.fun ACME_WEBROOT=/opt/diagnosis-test/certbot-www CERT_DIR=/opt/diagnosis-test/certs NGINX_CONTAINER=diagnosis-test-web-1 /opt/lawverify/deploy/issue-cert.sh >> /opt/lawverify/letsencrypt/renew.log 2>&1
```

改完执行 `crontab -e` 保存即可（用 `crontab -l` 复核）。

### 7. 更新云端环境变量

`/opt/lawverify/deploy/.env`：

```dotenv
CLOUD_WEB_ORIGIN=https://lawverify.zhijing.fun,https://lawagent.zhijing.fun
CLOUD_PUBLIC_BASE_URL=https://lawverify.zhijing.fun
```

`CLOUD_WEB_ORIGIN` 是跨域白名单，两个域名都要保留；`CLOUD_PUBLIC_BASE_URL` 决定下载链接、注册邀请链接和支付回跳地址。
改完需要重建容器才能生效：

```bash
cd /opt/lawverify/deploy
docker compose up -d --force-recreate cloud-server
```

### 8. 部署本次仓库改动

仓库侧改动涉及 `web`（官网链接、canonical、sitemap）与 `cloud-server`（`config.ts` 默认值）。
`web` 镜像需要在 `/opt/lawverify/deploy` 目录用最新代码重新构建（构建参数 `VITE_SITE_URL` 来自同目录 `.env`，
该值若非空会覆盖代码里的官网域名，请设为空或 `https://lawverify.zhijing.fun`）：

```bash
cd /opt/lawverify/deploy
docker compose build web
docker compose up -d web
```

或使用仓库自带的发布脚本（`scripts/deploy-platform-release.ps1`，会构建 web + cloud-server 并上传）：

```powershell
.\scripts\deploy-platform-release.ps1 `
  -RemoteHost 60.205.199.126 -RemoteUser root `
  -RemoteWebRoot /opt/lawverify/web `
  -RemoteReleaseRoot /opt/lawverify/deploy/releases `
  -RemoteCloudRoot /opt/lawverify/cloud-server `
  -RestartCommand "cd /opt/lawverify/deploy && docker compose up -d --force-recreate web cloud-server"
```

### 9. 公网回归验证

```bash
curl -I https://lawverify.zhijing.fun/                      # 期望 200
curl -I https://lawverify.zhijing.fun/api/web/site/config   # 期望 200
curl -I https://lawagent.zhijing.fun/                       # 旧域名仍是 200
curl -s https://lawverify.zhijing.fun/api/web/site/config   # 期望返回 siteName / accountCenterUrl
```

浏览器再确认：官网页脚、下载页按钮、"复制下载页链接"、注册邀请链接均指向 `lawverify.zhijing.fun`。

## 注意

- 桌面客户端的云端接口地址仍固定为 `lawagent.zhijing.fun`（两个域名指向同一套服务），
  这样新域名证书未就绪时不会让已发布的客户端全线不可用；待新域名稳定运行后再统一切换。
- `CLOUD_WEB_ORIGIN` 漏配新域名时，跨域调用云端接口会被 CORS 拒绝，页面能打开但接口报错。
