# 旧版客户端的云端 Python 解析服务部署

桌面新版随安装包提供 Python 和 MinerU 模型，并由应用在本机启动解析进程。以下部署说明用于仍依赖云解析的旧版客户端。[桌面解析资源准备](../python-workers/README.md#桌面打包)

Python 解析服务使用 MinerU 4.2.2，支持 PDF、图片、聊天截图、Word 与文本。解析容器与 `cloud-server` 部署在同一台云服务器，共用 `lawverify_default` 网络。现有 HTTPS 站点通过外层 Nginx 提供 `/parse`。[云端平台部署说明](deployment-docker.md)

## 部署 Python workers

发布端和云服务器需要 Docker 与 Compose v2。在云服务器用示例创建 `python-workers/.env` 并配置签名公钥、模型目录。默认完整路径为 `/opt/lawverify/python-workers/.env`。在已有 `cloud-server` 的服务器上新增或更新解析服务时，从发布端运行以下命令。首次部署整套平台时，可在同一命令中指定 `web cloud-server python-workers`。

```bash
./deploy/deploy.sh --host user@host python-workers
```

将 `python-workers/mineru-home/models/MinerU-4_models_onnx/` 整目录上传到目标机器的对应位置。默认部署根目录为 `/opt/lawverify`，因此默认模型目录为 `/opt/lawverify/python-workers/mineru-home/models/MinerU-4_models_onnx/`。

`PARSER_MODELS_DIR` 指向目标机器上包含 `models/` 的模型根目录。相对路径以目标的 `deploy/` 为基准，默认是 `../python-workers/mineru-home`。已有部署可以在 `.env` 中显式指定原模型根目录，或迁移模型后更新该配置。模型以只读方式挂载，由 worker 复制权重到解析数据卷。首次启动需要等待模型预热。

镜像从 `python-workers/` 源码目录构建，使用同目录的 `Dockerfile` 和 `.dockerignore`，模型和环境文件均排除在构建上下文之外。发布端可在 `python-workers/.env.build` 设置 `DOCKER_REGISTRY_PREFIX`、`DEBIAN_MIRROR` 和 `PIP_INDEX_URL`。解析端口默认绑定回环地址，云端流量走 HTTPS。当前环境模板配置了 8 核 CPU 配额、一个 worker 和 5 GiB 内存上限。

如果服务器已运行同名解析容器，先核对它的 Compose 项目：

```bash
docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' lawverify-parser
```

若项目名与 `lawverify` 不同，安排解析任务清空后再切换。部署前保存旧容器配置和卷，解除同名容器占用后发布新版。新版使用 `lawverify_parser-data`，会从只读模型目录重新准备缓存。旧卷可保留用于回退。

## 调用解析服务

采用云解析的旧版 Windows 和 macOS 安装包读取其版本的 `app/electron/release-endpoints.json`。

| 字段 | 用途 |
| --- | --- |
| `loginBaseUrl` | 登录和云端账户 API 的 HTTPS 源地址，例如 `https://lv.zhijing.fun` |
| `parserTicketBaseUrl` | 签发解析票据的 HTTPS 基础地址，客户端拼接 `/api/account/parser-ticket` |
| `parserServiceBaseUrl` | 上传原件的默认 HTTPS 基础地址，客户端拼接 `/parse` |

取票服务需要认可登录服务签发的会话，解析服务需要信任取票服务的签名公钥。单次打包可用 `LAWVERIFY_PARSER_SERVICE_URL` 覆盖解析上传地址，回环 HTTP 地址可用于本机调试。开发时可通过 `server/.env.local` 设置 `PARSER_SERVICE_URL` 和 `PARSER_TICKET_BASE_URL`，未设置取票地址时沿用 `CLOUD_API_BASE_URL`。

材料解析入口通过 `PARSER_SERVICE_URL` 上传原件并接收解析结果，校验通过后写入本地工作区。请求结束后清理容器内的临时文件。容器被强制终止时可能遗留临时目录，数据卷用于保留模型缓存。

接口为 `POST /parse?fileName=<编码后的文件名>&mode=auto`，请求体为原件字节，使用 `Authorization: Bearer <解析票据>`。`mode` 支持 `auto`、`document`、`chat`。单份原件上限 512 MiB，结果上限 64 MiB，默认解析超时 15 分钟。

## 多账号解析

使用 Ed25519 密钥对。在 `deploy/cloud-server/.env` 配置 `PARSER_TICKET_PRIVATE_KEY`，格式为 PKCS#8 DER 的 Base64。在 `python-workers/.env` 配置 `PARSER_TICKET_PUBLIC_KEY`，格式为 SPKI DER 的 Base64。启用公钥后，解析服务仅接受签名票据。 [Nginx 配置方法](deployment-docker.md#同域-https-代理材料解析)

工作台使用当前账号会话调用 `POST /api/account/parser-ticket`，取得有效期 120 秒的票据，再向配置的解析服务 `/parse` 上传原件。成功响应的 `X-Parser-Task-Id` 用于关联任务，结果在原请求中返回。

解析容器根据签名用户 ID 限流。`PARSER_MAX_ACCOUNT_PENDING` 默认为 2，每账号最多有 1 件解析正在执行。`PARSER_MAX_ACCOUNT_IN_FLIGHT_MB` 默认为 512 MiB。实例默认总共允许 16 个在途请求和 1024 MiB 原件额度。上传中、排队和解析中的原件都占额度。账号间轮转分配空闲 worker，超出额度返回 `429` 和 `Retry-After`。断连和超时会取消对应任务，并清理该请求的临时目录。

这些容量限制由每个解析实例维护。通过多个实例扩容时，需要在入口统一账号限额。普通账号会话注销后无法签发新凭证，已经签发的凭证会在原定有效期内到期。

## 评估

设置 `PARSER_TEST_SERVICE_URL` 和 `CLOUD_API_BASE_URL` 为相同的云端 HTTPS 基础地址，并设置测试账号的 `PARSER_TEST_SESSION_TOKEN`。

`PARSER_TEST_SAMPLES` 可指向预生成的合成样本 `samples/` 目录，评估会读取同级的 `expected.json`。也可以用 `LAWVERIFY_TEST_PYTHON` 指定带 Pillow 和 ReportLab 的 Python 生成样本，按需通过 `OCR_TEST_FONT` 指定中文字体。解析请求全部发往配置的服务。

```bash
node --test server/scripts/test-mineru-protocol.mjs
node server/scripts/benchmark-remote-parser.mjs
node server/scripts/benchmark-mineru-workers.mjs
```

评估将云端结果与合成样本预期值核对，并记录 HTTP 耗时和异常恢复结果。并发基准测量客户端同时发出 1 或 2 个请求时的耗时。报告分别写入项目的 `tmp/remote-parser-evaluation-*` 和 `tmp/mineru-benchmark-*`。

```bash
cd deploy
docker compose --project-directory . --env-file ../python-workers/.env -f python-workers/compose.yml logs --tail 80 parser
docker stats --no-stream
```
