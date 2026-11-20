# 官网与云端平台 Docker 部署

用 `deploy/deploy.sh` 在本机或通过 SSH 部署官网、云端 API、PostgreSQL 和 Python workers。
桌面工作台 `server` 和 Tiptap 文书编辑器随桌面安装包分发。

```text
浏览器 / 桌面客户端 -> 外层 Nginx（HTTPS）
  /parse   -> parser 容器:8790
  其他请求  -> web 容器（宿主机 WEB_PORT，默认 8090）
                /       -> 官网静态文件（SPA）
                /api/*  -> cloud-server 容器:8788
                            -> postgres 容器:5432（数据卷 lawverify_postgres-data）
```

相关文件：

| 文件 | 说明 |
| --- | --- |
| `deploy/deploy.sh` | 统一部署入口，支持 `--local` 和 `--host` |
| `deploy/web/` | 官网运行配置、镜像构建配置和外层 nginx 示例 |
| `deploy/cloud-server/` | 云端 API 和 PostgreSQL 配置 |
| `deploy/python-workers/` | Python 解析 worker 运行和镜像构建配置 |
| 各服务目录的 `.env.example`、`.env.build.example` | 按需在部署目标配置 `.env`，在发布端配置 `.env.build` |
| `deploy/admin.sh` | 服务器执行：管理系统管理员账号 |
| `cloud-server/Dockerfile`、`web/Dockerfile`、`python-workers/Dockerfile`、`web/nginx.conf` | 镜像与反向代理 |

## 首次部署

发布端和服务器均需要 Docker 与 Docker Compose v2。发布端还需要 Bash 和 SSH，并能构建服务器架构的 Linux 镜像。

1. 在部署目标将 `deploy/cloud-server/.env.example` 复制为 `deploy/cloud-server/.env`。生成并填写数据库密码和 JWT 密钥。

   ```bash
   cd /opt/lawverify/deploy
   chmod 600 cloud-server/.env
   sed -i "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" cloud-server/.env
   sed -i "s/^JWT_SECRET=$/JWT_SECRET=$(openssl rand -hex 48)/" cloud-server/.env
   ```

   再按实际访问地址修改 `CLOUD_PUBLIC_BASE_URL`、`CLOUD_WEB_ORIGIN`。
   可选 URL 类变量不用时整行注释，不要留空值。

2. 在本机仓库根目录执行：

   ```bash
   cp deploy/web/.env.build.example deploy/web/.env.build
   # 在发布端的 deploy/web/.env.build 填写 VITE_SITE_URL 等变量后运行
   ./deploy/deploy.sh --host user@host web cloud-server
   ```

   脚本读取目标镜像标签和 CPU 架构，再在发布端构建镜像。web 镜像包含编译后的静态站点，cloud-server 镜像包含编译后的 JavaScript、运行依赖和数据库迁移。SSH 部署只传运行镜像和配置模板，目标通过 `docker image load` 加载应用镜像。PostgreSQL 使用上游镜像。

3. 创建系统管理员（见下一节），并确认云服务器安全组放行 `WEB_PORT`。

## 独立发布

```bash
./deploy/deploy.sh --host user@host web
./deploy/deploy.sh --host user@host cloud-server
./deploy/deploy.sh --host user@host python-workers
./deploy/deploy.sh --local all
```

服务参数可组合。`all` 部署全部服务，省略服务参数时部署 `web cloud-server`。SSH 模式可继续使用 `DEPLOY_HOST`、`DEPLOY_DIR` 和 `DEPLOY_SERVICES`，显式服务参数优先。

- `web` 只启动官网。默认将 `/api/` 请求转发给同一 Docker 网络中的 `cloud-server:8788`。若 API 在其他主机，设置目标 `deploy/web/.env` 的 `CLOUD_SERVER_UPSTREAM` 为 web 容器可访问的 HTTP 源地址，例如 `http://10.0.0.20:8788`。
- `cloud-server` 启动云端 API 和 PostgreSQL。它们与 web 共用 `lawverify_default` 网络。可用 `postgres` 单独更新数据库容器。
- 各服务的 `.env` 分别用 `WEB_IMAGE_TAG`、`CLOUD_SERVER_IMAGE_TAG` 或 `PARSER_IMAGE_TAG` 指定镜像标签。修改 `VITE_*` 后重新发布 web。

### 升级现有部署

- 新的服务环境文件优先，已有的 `deploy/.env` 仍可为 web 和 cloud-server 提供配置。发布端原有 `deploy/.env.build` 仍可作为两者的构建配置。现有 `deploy/releases/` 和 `lawverify_postgres-data` 可继续使用。

Python workers 与 cloud-server 部署在同一台云服务器，可单独更新。见 [云端 Python 解析服务部署](deployment-parser.md)。

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
- `set-email` 或新建其他账号后，记得同步修改 `deploy/cloud-server/.env` 中的 `ADMIN_EMAILS` 并用下方运维命令重建 cloud-server。
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
2. 参考 `deploy/web/nginx-outer-vhost.conf.example`，先在外层 nginx 加 80 端口的站点（含 `/.well-known/acme-challenge/`），`nginx -t` 后重载。
3. 签发证书（证书状态保存在 `/opt/lawverify/letsencrypt`）：

   ```bash
   DOMAIN=域名 ACME_WEBROOT=外层nginx的acme目录 CERT_DIR=外层nginx证书目录 \
   NGINX_CONTAINER=外层nginx容器名 /opt/lawverify/deploy/issue-cert.sh
   ```

   服务器拉不到 Docker Hub 镜像时，在本机拉取后传过去：

   ```bash
   docker pull --platform linux/amd64 certbot/certbot:v3.1.0
   docker save --platform linux/amd64 certbot/certbot:v3.1.0 | gzip | ssh root@服务器 'gunzip | docker load'
   ```

4. 加 443 站点，80 端口改为跳转 HTTPS，重载。
5. 将服务器 `deploy/cloud-server/.env` 的 `CLOUD_PUBLIC_BASE_URL` 和 `CLOUD_WEB_ORIGIN`、发布端 `deploy/web/.env.build` 的 `VITE_SITE_URL` 改为 `https://域名`，再从发布端运行 `deploy/deploy.sh`。
6. 用 cron 每周执行一次第 3 步的命令完成续期，未到期时不会重复签发。

此时 `WEB_PORT` 只需外层 nginx 能访问，安全组不必对公网开放。

### 同域 HTTPS 代理材料解析

部署 `python-workers` 后，将 [外层 Nginx 示例](../deploy/web/nginx-outer-vhost.conf.example) 的 `location = /parse` 加入现有的 443 站点。Nginx 将原请求直接转给解析服务，包括查询参数和 Bearer 票据。官网及 `/api/` 继续走原有反代。解析路由允许 512 MiB 原件，以流式方式转发请求体，读取超时为 960 秒。

- 外层 Nginx 在宿主机运行时，默认上游是 `http://127.0.0.1:8790`。
- 外层 Nginx 在 Docker 内运行时，将它接入 `cloud-server` 和 `parser` 共用的 `lawverify_default` 网络。用以下三行替换解析路由里的 `proxy_pass http://127.0.0.1:8790;`，以便按服务名连接，并在解析容器重建后重新解析地址。

  ```nginx
  resolver 127.0.0.11 valid=10s ipv6=off;
  set $parser_upstream http://parser:8790;
  proxy_pass $parser_upstream;
  ```

配置后先执行 `nginx -t`，再重载。通过 `https://域名/parse` 发送无凭证 POST 应返回 `401`。保持解析端口只在回环或 Docker 网络可达。桌面安装包默认使用现有云端 HTTPS 地址，打包到其他域名时用 `LAWVERIFY_PARSER_SERVICE_URL` 指定 HTTPS 基础地址。客户端会自动添加 `/parse`。

## 运维

```bash
cd /opt/lawverify/deploy
cloud=(docker compose --project-directory . --env-file cloud-server/.env -f cloud-server/compose.yml)
"${cloud[@]}" ps
"${cloud[@]}" logs -f cloud-server
"${cloud[@]}" up -d --no-build cloud-server
# 数据库备份
"${cloud[@]}" exec -T postgres pg_dump -U lawverify lawverify_cloud | gzip > backup-$(date +%F).sql.gz
```

若仍使用旧的共享配置，改用 `--env-file .env`，并设置 `CLOUD_SERVER_ENV_FILE=.env`。

## 注意事项

- 当前反向代理只提供 HTTP。正式对外（尤其支付回调）需要域名与 HTTPS，可在外层 nginx/负载均衡终止 TLS 后转发到 `WEB_PORT`。
- 已发布的桌面客户端默认连接 `https://lawverify.zhijing.fun`；指向其他平台地址需要相应构建客户端。
- 生产环境保持 `DEV_PAYMENT_SIMULATION=false`。
