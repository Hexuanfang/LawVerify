# 本机材料解析

证据、知识库文件及导入文稿统一提交给 Python worker。PDF 与图片使用 MinerU，本机 Word 和纯文本解析由同一 worker 分派。证据解析产物由 Python 写出，业务状态由 TypeScript 写入。解析失败或存在审核提示的证据可在原件预览中编辑正文并确认。

## 本机开发

可以用 `LAWVERIFY_PYTHON` 指定已安装 MinerU 的 Python，用 `LAWVERIFY_MINERU_HOME` 指定已有模型目录。也可以准备项目内的可搬移环境，服务会自动发现。

```powershell
$env:UV_CACHE_DIR = Join-Path (Get-Location) 'tmp/parser-build-cache'
uv run --no-project --python <uv管理的Python> server/scripts/prepare-parser-runtime.py --models <已有MinerU_HOME>
```

准备脚本复制当前 Python 基础环境到 `server/python/.runtime`，核实副本路径后仅在副本安装依赖，将模型复制到 `server/python/.models`。缓存可通过 `UV_CACHE_DIR` 指定到项目 tmp。已有不完整输出可用 `--resume` 继续，离线缓存齐备时可用 `--offline`。

模型准备需在安装/构建阶段完成。worker 运行时指定本地模型来源，不自动联网安装。

## 配置

| 变量 | 用途 |
| --- | --- |
| LAWVERIFY_PYTHON | 可选，Python 可执行文件绝对路径 |
| LAWVERIFY_MINERU_HOME | 可选，包含 models 子目录的模型根目录 |
| PARSER_DEVICE | auto 或 cpu，默认 auto |
| PARSER_WORKERS | 0 自动选择，或 1～4 显式数量 |
| PARSER_TIMEOUT_MS | 单份解析超时，默认 900000 毫秒 |

旧版 DOC 由 Python worker 直接抽取纯文本，无需安装 LibreOffice。

自动模式下先启动一个 worker，根据实际设备与内存决定是否增加至两个 CPU worker。GPU 默认一个。总内存小于 12 GB 或可用内存不足 4 GB 时，CPU 也保留一个。每个 worker 的算子线程上限为 4。

解析产物位于工作区 parsing 目录，按账号摘要隔离，包含正文、页码、文字位置与可用的聊天重建结果。单份失败不会中断其他解析，进程异常最多重试一次。

## 桌面打包

资源准备默认读取 `.runtime` 和 `.models`，也可显式设置 `LAWVERIFY_PARSER_RUNTIME_SOURCE` 与 `LAWVERIFY_PARSER_MODELS_SOURCE`。构建会检查平台和架构，将资源置于 app.asar.unpacked。虚拟环境含绝对基础路径，不能直接充当随包环境。

首次运行随包环境时，权重复制到用户数据目录，后续复用该副本。派生 ONNX 图和锁文件写入数据目录，兼容只读安装目录。这会额外占用一份模型空间。

Mac 按 arm64 与 x64 分别准备资源。构建 all 时可用 LAWVERIFY_PARSER_RUNTIME_SOURCE_ARM64 与 LAWVERIFY_PARSER_RUNTIME_SOURCE_X64 提供两个运行环境，构建器逐个准备和打包。当前固定依赖 4.2.2 的 Windows 环境已实测。Apple Silicon 需要进一步真机验收，Intel Mac 的依赖兼容候选仍需验证，尚未承诺可直接安装该版本。

Mac 自动模式只有在本地具备 Torch 权重及完整加速依赖时才交给 MinerU 自动选择后端，初始化失败回退 ONNX CPU。该分支已实现，尚未真机验证。

聊天适配使用 MinerU 内部文字行接口，升级版本时需重跑单聊、群聊、长图与连续截图验证。当前自动布局识别针对浅色白/绿色气泡，未知布局可选择“按聊天截图解析”并人工核对。同案同标题截图出现至少两条且累计不少于16字的连续重叠时，审核面板提示可能的前后关系，保留每张原件，由律师核对连续性。
