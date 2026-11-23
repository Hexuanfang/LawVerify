# 本机材料解析

桌面应用启动后在本机后台启动 Python worker，通过标准输入输出传递任务和结果位置。Python worker 使用随包的 MinerU 模型解析 PDF、图片、Word 和纯文本，业务服务校验结果并写入工作区。解析失败或存在审核提示的证据可在原件预览中编辑正文并确认。[旧版客户端的云服务部署](../docs/deployment-parser.md)

## 目录结构

```text
python-workers/
├── http-service.mjs                     # HTTP 入口
├── worker.py                            # Python worker 入口
├── requirements.txt                     # Python 依赖
└── mineru-home/                         # 模型根目录
    └── models/
        └── MinerU-4_models_onnx/         # CPU 部署权重
            ├── Layout/
            ├── MFR/
            ├── OCR/
            └── Table/
```

`mineru-home/` 由 Git 忽略。部署时单独上传 ONNX 权重目录，保留内部子目录和隐藏文件。MinerU 在 `models/.derived/` 和 `models/.locks/` 生成的本机缓存可在新环境重新生成。

## 本机调试解析服务

使用 uv 管理的 Python 3.13 准备可搬移运行环境。已有模型时设置 `--models` 指向包含 `models/` 的 MinerU 目录，也可用 `--download-models` 在构建阶段下载官方 ONNX 权重。

```powershell
$env:UV_CACHE_DIR = Join-Path (Get-Location) 'tmp/parser-build-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path (Get-Location) 'tmp/uv-python'
uv run --no-project --managed-python --python 3.13 server/scripts/prepare-parser-runtime.py --download-models
```

准备脚本默认将 Python 环境复制到 `tmp/parser-runtime`，在副本安装依赖，并将模型放到 `python-workers/mineru-home/models/`。通过 `--output` 指定其他运行环境路径时，模型仍放在该运行环境旁边的 `.models/models/` 中。缓存可通过 `UV_CACHE_DIR` 指定到项目 tmp。已有不完整输出可用 `--resume` 继续，离线缓存齐备时可用 `--offline`。

## 配置

| 变量 | 用途 |
| --- | --- |
| LAWVERIFY_PYTHON | Python 可执行文件，直接运行时默认 `python3` |
| LAWVERIFY_MINERU_HOME | 包含 `models` 子目录的模型根目录 |
| PARSER_DEVICE | 桌面默认 `auto`，优先复用预热 CPU；设为 `cpu` 关闭 GPU，设为 `gpu` 优先尝试合适的独显 |
| PARSER_WORKERS | 桌面最多并发 2 个 worker；设为 `1` 可固定串行 |
| PARSER_TIMEOUT_MS | 单份解析超时，默认 900000 毫秒 |

旧版 DOC 由 Python worker 直接抽取纯文本，无需安装 LibreOffice。

桌面解析根据可用逻辑核心数、CPU 负载和空闲内存分配 worker。计算线程合计最多 4 个，并限制在约半数可用逻辑核心内。Windows 和 Linux 在系统允许时还会绑定相应核心，macOS 使用低优先级和计算线程限制。

桌面 App 启动时按资源余量预热一个 1～4 线程的 CPU worker。单份任务优先复用常驻 worker。批量达到 4 份且资源充足时，最多使用两个 CPU worker，每个占用 2 核；资源紧张时串行解析。解析空闲约 15 秒后，额外 worker 会退出，常驻 worker 释放文档推理模型并保留基础 OCR。常驻 worker 意外退出后会自动补起。如果系统可用内存低于 512 MiB，空闲的常驻 worker 也会释放，待资源恢复后重新预热。

正常调度按总内存预留 2～8 GiB，单个 worker 的驻留内存预算为 1～3 GiB。首个 CPU worker 可以借用部分预留，给系统保留至少 512 MiB。常规预算仍不足时，有实际解析任务就使用单线程 CPU 落盘模式，驻留内存上限为 3 GiB，系统可按需使用交换空间。较低预算的 CPU worker 超限时，也会自动切换到该模式重试一次。Windows 在系统允许时用 Job Object 限制提交量，比驻留内存上限最多高 256 MiB。

超过 20 页的 PDF 优先尝试获取 3 GiB，整份解析超限时可按每段最多 20 页串行处理。落盘模式直接按每段最多 4 页处理，推理窗口限制为一页。每段结束后写盘，内存超限时减半重试该段，最终按原页码合并正文和坐标。案件材料重试时接着已落盘的分段处理，单页超限会提示原页码。

PDF 和图片可尝试有余量的 Windows DirectML 独显。仅当专用显存至少 6 GiB、显存预算足以预留资源且引擎负载不超过 65% 时分派，最多启用一个 GPU worker。任务间重新检查余量。GPU 繁忙、推理失败或达到内存上限时，任务自动转到 CPU。CPU 解析 PDF 和图片至少分配 1.5 GiB，PDF 按内存预算每批处理 1～3 页，并保留原页码。当前 macOS 随包的 ONNX 运行环境使用 CPU。

解析产物位于工作区 parsing 目录，按账号摘要隔离，包含正文、页码、文字位置与可用的聊天重建结果。单份失败不会中断其他解析，进程异常最多重试一次。

## 桌面打包

`prepare:desktop` 准备本地业务服务、迁移、法库种子，以及要写入安装包 `resources/parser` 的 Python 脚本、运行环境和模型。可用 `LAWVERIFY_PARSER_RUNTIME_SOURCE` 和 `LAWVERIFY_PARSER_MODELS_SOURCE` 指向现有构建资源。应用启动时在后台预热，首次启动会将模型权重复制到用户数据目录，以便生成本机缓存。

常规流程为前端构建、业务服务构建、桌面资源准备、Electron 打包。Windows 入口为项目根目录 `build-desktop.cmd`，Mac 入口为 `npm --prefix app run build:mac`。内置法库沿用已校验缓存，缓存更新仍走现有法库导出流程。

启动本机开发服务前准备好运行环境和模型。执行 `npm --prefix server run build` 后，可运行 `node --test server/scripts/test-local-parsing.mjs` 验证本机解析。旧版 HTTP 部署的评估命令见 [旧版评估说明](../docs/deployment-parser.md#评估)。

聊天适配使用 MinerU 内部文字行接口，升级版本时需重跑单聊、群聊、长图与连续截图验证。当前自动布局识别针对浅色白/绿色气泡，未知布局可选择“按聊天截图解析”并人工核对。同案同标题截图出现至少两条且累计不少于16字的连续重叠时，审核面板提示可能的前后关系，保留每张原件，由律师核对连续性。
