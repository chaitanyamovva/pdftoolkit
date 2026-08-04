# run-local.ps1
# Builds the PDF Signer image and runs it locally with docker-compose,
# so you can test it in your browser before deploying to TrueNAS.
#
# Usage (from inside the pdf-signer-app folder):
#   .\run-local.ps1

$ErrorActionPreference = "Stop"

Write-Host "== Checking Docker is running ==" -ForegroundColor Cyan
try {
    docker version | Out-Null
} catch {
    Write-Host "Docker doesn't seem to be running. Start Docker Desktop and wait for the whale icon to settle, then re-run this script." -ForegroundColor Red
    exit 1
}

Write-Host "== Building and starting the app (docker compose up --build) ==" -ForegroundColor Cyan
docker compose up --build -d

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build or startup failed. Scroll up for the error." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "== App is starting up ==" -ForegroundColor Green
Write-Host "Give it a few seconds, then open: http://localhost:5000" -ForegroundColor Green
Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Yellow
Write-Host "  docker compose logs -f      # follow logs"
Write-Host "  docker compose down         # stop the app"
Write-Host "  docker compose ps           # check status"

Start-Sleep -Seconds 3
try {
    Start-Process "http://localhost:5000"
} catch {
    # non-fatal if the browser doesn't auto-open
}
