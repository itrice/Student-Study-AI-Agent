param(
  [string]$SshKey = (Join-Path $HOME ".ssh\id_rsa_agent_deployer"),
  [string]$Target = "deployer@192.168.1.66",
  [string]$RemoteDir = "/var/www/student-start-ai-agent",
  [string]$AppUrl = "http://192.168.1.66:3000",
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $env:TEMP ("math-coach-deploy-" + (Get-Date -Format "yyyyMMddHHmmss") + ".tar.gz")
$remoteArchive = "/tmp/math-coach-deploy.tar.gz"

function Assert-NativeSuccess([string]$Name) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Name 失败，退出码 $LASTEXITCODE"
  }
}

try {
  if (-not (Test-Path -LiteralPath $SshKey)) {
    throw "SSH 密钥不存在：$SshKey"
  }

  if (-not $SkipTests) {
    Write-Host "==> 本地测试"
    & node --test
    Assert-NativeSuccess "node --test"
  }

  Write-Host "==> 打包工作区（排除 .env、data、.git、node_modules）"
  & tar -czf $archive `
    --exclude=.git `
    --exclude=node_modules `
    --exclude=data `
    --exclude=.env `
    --exclude=pnpm-lock.yaml `
    -C $projectRoot .
  Assert-NativeSuccess "tar"

  Write-Host "==> 上传到 $Target"
  & scp -i $SshKey -o BatchMode=yes $archive "${Target}:${remoteArchive}"
  Assert-NativeSuccess "scp"

  $remoteCommand = @'
set -eu
cd "__REMOTE_DIR__"
mkdir -p data
if [ -n "$(docker compose ps -q app 2>/dev/null)" ]; then
  echo "==> 部署前备份"
  docker compose exec -T app node scripts/backup-database.mjs
fi
previous_image=$(docker compose images -q app 2>/dev/null | head -1 || true)
if [ -n "$previous_image" ]; then
  docker tag "$previous_image" math-mistake-coach:previous
  echo "==> 已保留上一版镜像：math-mistake-coach:previous"
fi
echo "==> 解压源码"
tar -xzf "__REMOTE_ARCHIVE__"
echo "==> 目标机 Node 22 测试"
test_output=$(docker run --rm --user "$(id -u):$(id -g)" -e TZ=Asia/Shanghai -v "$PWD":/app -w /app node:22-alpine node --test 2>&1)
echo "$test_output" | tail -8
echo "remote-tests=ok"
echo "==> 构建镜像"
docker compose build
echo "==> 重建容器"
docker compose up -d --force-recreate
echo "==> 等待健康检查"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "remote-health=ok"
    docker compose ps
    exit 0
  fi
  sleep 1
done
echo "remote-health=failed"
docker compose logs --tail=50
exit 1
'@
  $remoteCommand = $remoteCommand.Replace("__REMOTE_DIR__", $RemoteDir).Replace("__REMOTE_ARCHIVE__", $remoteArchive)
  $remoteCommand = $remoteCommand.Replace("`r`n", "`n")

  Write-Host "==> 远程构建、备份、重建"
  & ssh -i $SshKey -o BatchMode=yes $Target $remoteCommand
  Assert-NativeSuccess "ssh deploy"

  Write-Host "==> 本机验证"
  $health = Invoke-RestMethod -Uri "$AppUrl/api/health" -TimeoutSec 10
  Write-Host ("部署完成：{0}  health=ok  schemaVersion={1}  tools={2}" -f $AppUrl, $health.schemaVersion, $health.toolCount)
} finally {
  if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  }
}
