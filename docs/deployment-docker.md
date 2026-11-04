# 官网与云端平台 Docker 部署

适用于 Linux 服务器部署 `web`（官网 / 账号中心）+ `cloud-server`（云端接口）+ PostgreSQL。
`server`（本地工作台服务）随桌面安装包分发，不在此部署范围内。

```text
浏览器 / 桌面客户端
  -> web 容器（nginx:80，宿主机 WEB_PORT，默认 8090）
       /          -> 官网静态文件（SPA）
       /api/*     -> cloud-server 容器:8788
                       -> postgres 容器:5432（数据卷 lawverify_postgres-data）
```

相关文件：

| 文件 | 说明 |
| --- | --- |
| `deploy/docker-compose.yml` | 三个服务的编排，compose 项目名 `lawverify` |
| `deploy/.env.example` | 服务器配置模板，复制为 `deploy/.env`（不提交） |
| `deploy/deploy.sh` | 本机执行：打包当前工作区、上传、在服务器构建并启动 |
| `deploy/admin.sh` | 服务器执行：管理系统管理员账号 |
| `cloud-server/Dockerfile`、`web/Dockerfile`、`web/nginx.conf` | 镜像与反向代理 |

## 首次部署

服务器需要 Docker 与 Docker Compose v2。

1. 在服务器创建配置（密钥在服务器上生成）：

   ```bash
   mkdir -p /opt/lawverify/deploy/releases
   # 把仓库中的 deploy/.env.example 内容写入 /opt/lawverify/deploy/.env，然后：
   chmod 600 /opt/lawverify/deploy/.env
   sed -i "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" /opt/lawverify/deploy/.env
   sed -i "s/^JWT_SECRET=$/JWT_SECRET=$(openssl rand -hex 48)/" /opt/lawverify/deploy/.env
   ```

   再按实际访问地址修改 `CLOUD_PUBLIC_BASE_URL`、`CLOUD_WEB_ORIGIN`、`VITE_SITE_URL`。
   可选 URL 类变量不用时整行注释，不要留空值。

2. 在本机仓库根目录执行：

   ```bash
   DEPLOY_HOST=root@服务器 ./deploy/deploy.sh
   ```

   脚本上传的是当前工作区（含未提交改动，不含被忽略文件），服务器上的
   `deploy/.env` 与 `deploy/releases/` 不会被覆盖。cloud-server 启动时自动执行数据库迁移。

3. 创建系统管理员（见下一节），并确认云服务器安全组放行 `WEB_PORT`。

只更新某个服务：`DEPLOY_SERVICES=web DEPLOY_HOST=... ./deploy/deploy.sh`。
修改 `VITE_*` 后必须重新构建 web 镜像；修改其他变量只需在服务器执行 `docker compose up -d`。

## 系统管理员账号

拥有 `/admin` 权限的账号由 `ADMIN_EMAILS` 决定。账号本身可在服务器上用命令管理：

```bash
cd /opt/lawverify/deploy
./admin.sh list                                  # 查看 ADMIN_EMAILS 中账号是否已创建
./admin.sh create admin                          # 创建账号，自动生成随机密码并打印一次
./admin.sh set-password admin                    # 重置为随机密码并打印
echo '新密码' | ./admin.sh set-password admin --password-stdin   # 指定密码（不进 shell 历史需自行处理）
./admin.sh set-email admin ops@example.com      # 修改登录账号名
```

- 修改密码或账号名会立即使该账号所有已登录会话失效。
- `set-email` 或新建其他账号后，记得同步修改 `.env` 中的 `ADMIN_EMAILS` 并执行 `docker compose up -d cloud-server`。
- 启动时只会在 `ADMIN_INITIAL_EMAIL` 账号不存在、且设置了 `ADMIN_INITIAL_PASSWORD` 时创建它；
  已存在的账号不会被改动，重启不会重置密码。
- 本地开发（未配置 `DATABASE_URL`）同样可用：`npm --prefix cloud-server run admin:dev -- list`。

## 安装包下载

把安装包放到服务器 `deploy/releases/`，文件名需符合
`LawVerify-Setup-x.y.z.exe` 或 `LawVerify-Mac-x.y.z-<arm64|x64>.dmg`，无需重启。
也可设置 `RELEASE_DOWNLOAD_BASE_URL`（必须 HTTPS）改由 CDN 提供。

## 绑定域名与 HTTPS（80/443 已被其他 nginx 占用时）

同一台机器上已有 nginx 接管 80/443 时，不要再让 LawVerify 抢这两个端口，而是在现有 nginx 上加站点转发到 `WEB_PORT`：

1. 域名 A 记录指向服务器。
2. 参考 `deploy/nginx-outer-vhost.conf.example`，先在外层 nginx 加 80 端口的站点（含 `/.well-known/acme-challenge/`），`nginx -t` 后重载。
3. 签发证书（证书状态保存在 `/opt/lawverify/letsencrypt`）：

   ```bash
   DOMAIN=域名 ACME_WEBROOT=外层nginx的acme目录 CERT_DIR=外层nginx证书目录 \
   NGINX_CONTAINER=外层nginx容器名 /opt/lawverify/deploy/issue-cert.sh
   ```

4. 加 443 站点，80 端口改为跳转 HTTPS，重载。
5. `.env` 中 `CLOUD_PUBLIC_BASE_URL`、`CLOUD_WEB_ORIGIN`、`VITE_SITE_URL` 改为 `https://域名`，执行
   `docker compose build web && docker compose up -d`。
6. 用 cron 每周执行一次第 3 步的命令完成续期，未到期时不会重复签发。

此时 `WEB_PORT` 只需外层 nginx 能访问，安全组不必对公网开放。

## 运维

```bash
cd /opt/lawverify/deploy
docker compose ps
docker compose logs -f cloud-server
docker compose restart cloud-server
# 数据库备份
docker compose exec -T postgres pg_dump -U lawverify lawverify_cloud | gzip > backup-$(date +%F).sql.gz
```

## 注意事项

- 当前反向代理只提供 HTTP。正式对外（尤其支付回调）需要域名与 HTTPS，可在外层 nginx/负载均衡终止 TLS 后转发到 `WEB_PORT`。
- 已发布的桌面客户端默认连接 `https://lawagent.zhijing.fun`；指向其他平台地址需要相应构建客户端。
- 生产环境保持 `DEV_PAYMENT_SIMULATION=false`。
