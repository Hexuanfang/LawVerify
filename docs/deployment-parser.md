# 旧版客户端的云端 Python 解析

新版桌面安装包自带 Python 和 MinerU 模型，材料解析在本机运行。本文的接口和评估说明适用于已独立运行的旧版云端解析服务。[桌面解析资源准备](../python-workers/README.md#桌面打包)

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

使用 Ed25519 密钥对。在 `deploy/cloud-server/.env` 配置 `PARSER_TICKET_PRIVATE_KEY`，格式为 PKCS#8 DER 的 Base64。在旧版解析进程的环境中配置 `PARSER_TICKET_PUBLIC_KEY`，格式为 SPKI DER 的 Base64。启用公钥后，解析服务仅接受签名票据。[Nginx 配置方法](deployment-docker.md#同域-https-代理材料解析)

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
