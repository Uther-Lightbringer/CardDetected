# 一键部署到云服务器（Windows PowerShell 版）
# 用法：npm run deploy
#       $env:DEPLOY_HOST='xxx'; $env:DEPLOY_DIR='/opt/xx'; npm run deploy
param()

$ErrorActionPreference = 'Stop'

$REMOTE = if ($env:DEPLOY_HOST) { $env:DEPLOY_HOST } else { 'aliyun' }
$DIR    = if ($env:DEPLOY_DIR)  { $env:DEPLOY_DIR }  else { 'cardetect' }

# 检查未提交改动
$dirty = git status --porcelain
if ($dirty) {
    Write-Host "⚠️  有未提交的改动，部署内容将只包含已提交（HEAD）的代码" -ForegroundColor Yellow
}

# 打包源码到临时文件（用 zip 格式避免 Windows 下 tar 损坏问题）
$archive = Join-Path $env:TEMP "cardetect-deploy.zip"
Write-Host "== 打包源码（git archive HEAD）=="
git archive --format=zip -o "$archive" HEAD
if ($LASTEXITCODE -ne 0) { throw "git archive 失败" }
Write-Host "   包大小: $([math]::Round((Get-Item $archive).Length / 1KB)) KB"

try {
    # 上传
    Write-Host "== 传输到 ${REMOTE}:~/$DIR =="
    scp "$archive" "${REMOTE}:/root/cardetect-deploy.zip"
    if ($LASTEXITCODE -ne 0) { throw "scp 上传失败" }

    # 远端解压 + 构建
    Write-Host "== 远端构建并重启容器 =="
    ssh $REMOTE "mkdir -p /root/$DIR && unzip -o /root/cardetect-deploy.zip -d /root/$DIR && rm -f /root/cardetect-deploy.zip && cd /root/$DIR && docker compose down && docker compose up -d --build"
    if ($LASTEXITCODE -ne 0) { throw "远端构建失败" }

    Write-Host "== 完成 ==" -ForegroundColor Green
} finally {
    Remove-Item $archive -ErrorAction SilentlyContinue
}