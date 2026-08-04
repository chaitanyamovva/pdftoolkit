# publish.ps1
# Builds the PDF Signer image and pushes it to Docker Hub so TrueNAS
# (or any other host) can pull and run it.
#
# Usage (from inside the pdf-signer-app folder):
#   .\publish.ps1 -DockerHubUser movvasaichaitanya
#   .\publish.ps1 -DockerHubUser movvasaichaitanya -Tag v1.1

param(
    [Parameter(Mandatory = $true)]
    [string]$DockerHubUser,

    [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"
$ImageName = "$DockerHubUser/pdf-signer:$Tag"

Write-Host "== Checking Docker is running ==" -ForegroundColor Cyan
try {
    docker version | Out-Null
} catch {
    Write-Host "Docker doesn't seem to be running. Start Docker Desktop and wait for the whale icon to settle, then re-run this script." -ForegroundColor Red
    exit 1
}

Write-Host "== Building $ImageName ==" -ForegroundColor Cyan
docker build -t $ImageName .
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed. Scroll up for the error." -ForegroundColor Red
    exit 1
}

Write-Host "== Logging in to Docker Hub (skip if already logged in) ==" -ForegroundColor Cyan
docker login
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker Hub login failed." -ForegroundColor Red
    exit 1
}

Write-Host "== Pushing $ImageName ==" -ForegroundColor Cyan
docker push $ImageName
if ($LASTEXITCODE -ne 0) {
    Write-Host "Push failed. Scroll up for the error." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "== Done ==" -ForegroundColor Green
Write-Host "Image published as: $ImageName" -ForegroundColor Green
Write-Host "On TrueNAS, use this exact image repository/tag when creating the Custom App:" -ForegroundColor Yellow
Write-Host "  Image repository: $DockerHubUser/pdf-signer"
Write-Host "  Image tag:        $Tag"
