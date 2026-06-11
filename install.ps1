# AION one-command installer for Windows
#   irm https://raw.githubusercontent.com/aion-agent/aion/main/install.ps1 | iex
# Installs Node.js LTS if missing (winget), downloads AION, installs the
# global `aion` command. No git required. No admin required (winget may ask).

$ErrorActionPreference = "Stop"
$Repo = "aion-agent/aion"   # ← GitHub repo (owner/name)

Write-Host ""
Write-Host "  AION installer" -ForegroundColor Magenta
Write-Host "  --------------" -ForegroundColor DarkGray

# ── 1. Node.js >= 18 ─────────────────────────────────────
function Test-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return $false }
    try { return ([int]((node -v).TrimStart("v").Split(".")[0]) -ge 18) } catch { return $false }
}

if (-not (Test-Node)) {
    Write-Host "  Node.js >= 18 not found - installing via winget..." -ForegroundColor Yellow
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        Write-Host "  winget is unavailable. Install Node.js LTS manually from https://nodejs.org, then re-run this script." -ForegroundColor Red
        exit 1
    }
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    # refresh PATH in this session
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not (Test-Node)) {
        Write-Host "  Node installed but not on PATH yet - open a NEW terminal and re-run this script." -ForegroundColor Yellow
        exit 1
    }
}
Write-Host "  [ok] Node $(node -v)"

# ── 2. download AION (no git needed) ─────────────────────
$dest = Join-Path $env:LOCALAPPDATA "Programs\aion"
$zip  = Join-Path $env:TEMP "aion-main.zip"
Write-Host "  downloading AION..."
Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile $zip -UseBasicParsing
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
$tmp = Join-Path $env:TEMP ("aion-extract-" + [guid]::NewGuid().ToString("n").Substring(0, 8))
Expand-Archive -Path $zip -DestinationPath $tmp -Force
Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $dest
Remove-Item $zip -Force; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "  [ok] AION -> $dest"

# ── 3. global command ────────────────────────────────────
Write-Host "  installing global 'aion' command..."
Push-Location $dest
npm install -g . --silent | Out-Null
Pop-Location

Write-Host ""
Write-Host "  [ok] done. Start with:  " -NoNewline -ForegroundColor Green
Write-Host "aion" -ForegroundColor Cyan
Write-Host "      (first launch opens the setup wizard - Ollama, cloud providers, Telegram)" -ForegroundColor DarkGray
Write-Host ""
