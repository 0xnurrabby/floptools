# Auto-publish: after every commit, push to GitHub and redeploy Vercel (production).
# Token source, in order: $env:VERCEL_TOKEN, then .vercel-token.txt (git-ignored).
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$token = $null
if ($env:VERCEL_TOKEN) { $token = $env:VERCEL_TOKEN.Trim() }
elseif (Test-Path ".vercel-token.txt") { $token = (Get-Content ".vercel-token.txt" -Raw).Trim() }

if (-not $token) {
  Write-Host "[auto-publish] no Vercel token found (VERCEL_TOKEN or .vercel-token.txt). Skipping deploy."
  exit 0
}

Write-Host "[auto-publish] pushing to GitHub..."
git push origin main 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[auto-publish] WARNING: git push reported exit code $LASTEXITCODE (stderr suppressed)."
}

Write-Host "[auto-publish] deploying to Vercel (production)..."
npx --yes vercel@latest --yes --prod --name floptools --token $token 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[auto-publish] WARNING: vercel deploy reported exit code $LASTEXITCODE."
}
Write-Host "[auto-publish] done."
