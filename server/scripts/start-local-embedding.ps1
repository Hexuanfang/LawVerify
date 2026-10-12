param(
  [int]$Port = 8011
)

$python = "C:\Users\Windows11\anaconda3\python.exe"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

if (!(Test-Path $python)) {
  throw "未找到 Python：$python"
}

$env:EMBEDDING_MODEL = if ($env:EMBEDDING_MODEL) { $env:EMBEDDING_MODEL } else { "BAAI/bge-small-zh-v1.5" }
$env:FASTEMBED_CACHE_PATH = if ($env:FASTEMBED_CACHE_PATH) { $env:FASTEMBED_CACHE_PATH } else { (Join-Path $env:TEMP "lawverify-fastembed-cache") }

& $python -m uvicorn local_embedding_api:app --host 127.0.0.1 --port $Port --app-dir $scriptRoot
