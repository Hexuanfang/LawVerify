# Docker 部署使用说明

在仓库根目录用 `deploy/deploy.sh` 发布服务。所有示例均在 Bash 中执行。

## 选择服务

| 参数 | 启动的服务 | 容器名称 | 配置目录 |
| --- | --- | --- | --- |
| `web` | 官网 | `lawverify-web` | [web/](web/) |
| `cloud-server` | 云端 API、PostgreSQL | `lawverify-cloud-server`、`lawverify-postgres` | [cloud-server/](cloud-server/) |
| `postgres` | PostgreSQL | `lawverify-postgres` | [cloud-server/](cloud-server/) |
| `python-workers` | Python 解析服务，Compose 服务名为 `parser`，与云端 API 同机部署 | `lawverify-parser` | [python-workers/](python-workers/) |
| `all` | 全部服务 | 上述四个容器 | 上述三个目录 |

`cloud-server` 和 `postgres` 共用同一个 `lawverify-postgres` 容器。指定 `cloud-server` 时，Compose 会先确保 PostgreSQL 通过健康检查，再启动云端 API。只需启动数据库时，单独指定 `postgres`。同时指定这两个参数时，效果与仅指定 `cloud-server` 相同。

云端解析服务源码和 Python 依赖清单位于仓库根目录的 [`python-workers/`](../python-workers/)。

服务参数可以组合。省略服务参数时默认部署 `web cloud-server`，也可用 `DEPLOY_SERVICES` 设置默认选择。显式服务参数优先。用 `./deploy/deploy.sh --help` 查看脚本用法。

固定容器名在同一台 Docker 主机上必须唯一。已有部署会在下次执行对应服务的部署命令时采用新名称。

## 首次配置

发布端和部署目标均需 Docker 与 Docker Compose v2。发布端须能构建目标 CPU 架构的 Linux 镜像。进行 SSH 部署时，发布端还需 SSH 客户端。

### 目标机器上的运行配置

按所选服务复制模板并填写配置。下表的目标路径以本机仓库根目录或 SSH 目标的部署根目录为基准。SSH 部署根目录默认为 `/opt/lawverify`，可通过 `DEPLOY_DIR` 自定义。脚本上传 Compose 文件和模板，实际环境文件在目标机器上单独配置。

| 模板 | 目标文件 | 配置要点 |
| --- | --- | --- |
| [`deploy/web/.env.example`](web/.env.example) | `deploy/web/.env` | 可选。默认监听宿主机的 8090 端口，并将 `/api/` 转发到同一 Docker 网络的 `cloud-server:8788`。API 位于另一台主机时，填写 `CLOUD_SERVER_UPSTREAM`。 |
| [`deploy/cloud-server/.env.example`](cloud-server/.env.example) | `deploy/cloud-server/.env` | 配置 `POSTGRES_PASSWORD`、`JWT_SECRET`、`CLOUD_PUBLIC_BASE_URL` 和 `CLOUD_WEB_ORIGIN`。 |
| [`python-workers/.env.example`](../python-workers/.env.example) | `python-workers/.env` | 配置 `PARSER_TICKET_PUBLIC_KEY`。将 `PARSER_MODELS_DIR` 指向目标机器上包含 `models/MinerU-4_models_onnx` 的目录，默认使用部署根目录下的 `python-workers/mineru-home`。 |

数据库和云端 API 应使用独立生成的密钥。PostgreSQL 密码可用 `openssl rand -hex 24` 生成，以便直接用于数据库连接 URL。

### 发布端的构建配置

需要自定义构建参数时，将对应服务的 `.env.build.example` 复制为同目录的 `.env.build`。

- `deploy/web/.env.build` 中配置 `VITE_SITE_URL` 等前端变量。修改后重新部署 `web`，变量会写入网页。
- `deploy/web/.env.build` 和 `deploy/cloud-server/.env.build` 均可配置 `NPM_REGISTRY`。也可以通过 `DEPLOY_BUILD_ENV_FILE` 为这两个服务指定构建配置。
- `python-workers/.env.build` 可配置 `DOCKER_REGISTRY_PREFIX`、`DEBIAN_MIRROR` 和 `PIP_INDEX_URL`。

## 运行部署

本机部署的例子如下。

```bash
./deploy/deploy.sh --local web
./deploy/deploy.sh --local all
```

通过 SSH 选择服务发布。

```bash
./deploy/deploy.sh --host user@host web cloud-server
./deploy/deploy.sh --host user@host python-workers
```

也可用 `DEPLOY_HOST` 指定 SSH 主机。自定义目标路径时，将 `DEPLOY_DIR` 设为目标机器上的绝对路径，脚本会在该路径下使用 `deploy/` 目录。

SSH 部署在发布端生成应用镜像，目标机器加载镜像后启动容器。web 镜像包含编译后的静态站点，cloud-server 镜像包含编译后的 JavaScript、运行依赖和数据库迁移。目标机器从镜像仓库获取 PostgreSQL 镜像。Python 模型由目标机器挂载。

## 检查服务

在部署目标执行对应检查。示例使用默认端口，Python workers 首次启动时需等待模型预热。

```bash
curl -fsS http://127.0.0.1:8090/
curl -fsS http://127.0.0.1:8090/api/web/site/config  # web 与 cloud-server 均已部署
curl -fsS http://127.0.0.1:8790/health              # Python workers
```

在目标机器的 `deploy/` 目录运行 `./admin.sh list` 可查看管理员账号。安装包默认放在同一目录下的 `releases/`。

## 从旧版升级

- web 和 cloud-server 可读取旧 `deploy/.env` 与发布端的 `deploy/.env.build`。Python workers 优先读取根目录 `python-workers/` 中的环境文件，也兼容原来的 `deploy/python-workers/` 路径。
- 现有安装包目录和 PostgreSQL 卷可继续使用。已有解析容器跨 Compose 项目切换时，见 [解析服务升级说明](../docs/deployment-parser.md#部署-python-workers)。

详细的 HTTPS、管理员和备份步骤见 [官网与云端平台部署](../docs/deployment-docker.md)。解析服务接入见 [Nginx 同域代理](../docs/deployment-docker.md#同域-https-代理材料解析) 和 [云端 Python 解析服务部署](../docs/deployment-parser.md)。
