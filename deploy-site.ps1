$ErrorActionPreference = "Stop"
# Incremental Netlify deploy of changed static files for giesweekly.com.
# Only the files listed below are pushed; everything else (homepage, worker-built
# pages) is preserved by merging into the live manifest. Safe to run anytime.
# Netlify PAT is read from the environment; never hardcode it here (this tree
# syncs to Google Drive). Set it for the current PowerShell session with:
#   $env:NETLIFY_PAT = "nfp_..."
# or persist it for your user account with:
#   [Environment]::SetEnvironmentVariable("NETLIFY_PAT", "nfp_...", "User")
$TOKEN = $env:NETLIFY_PAT
if ([string]::IsNullOrWhiteSpace($TOKEN)) {
  throw "NETLIFY_PAT is not set. Set it before running this script, e.g. `$env:NETLIFY_PAT = 'nfp_...' (see comment above). Do not hardcode the token in this file."
}
$SITE  = "32bd51d3-9349-4db5-88bd-4b7dc87eb2a3"
$root  = $PSScriptRoot
$hdr   = @{ Authorization = "Bearer $TOKEN" }

# Netlify path -> local file. Add lines here when you change other static pages.
$push = [ordered]@{
  "/about/index.html" = (Join-Path $root "about\index.html")
  "/_redirects"       = (Join-Path $root "_redirects")
}

Write-Host "Fetching current Netlify file manifest..."
$current = Invoke-RestMethod -Uri "https://api.netlify.com/api/v1/sites/$SITE/files" -Headers $hdr
$manifest = @{}
foreach ($f in $current) { $manifest[$f.path] = $f.sha }

$shaMap = @{}
foreach ($p in $push.Keys) {
  if (-not (Test-Path $push[$p])) { throw "Missing file: $($push[$p])" }
  $sha = (Get-FileHash -Algorithm SHA1 -Path $push[$p]).Hash.ToLower()
  $shaMap[$p] = $sha
  $manifest[$p] = $sha
}

Write-Host "Creating deploy ($($manifest.Count) files in manifest)..."
$body = @{ files = $manifest; async = $false } | ConvertTo-Json -Depth 5 -Compress
$deploy = Invoke-RestMethod -Method Post -Uri "https://api.netlify.com/api/v1/sites/$SITE/deploys" -Headers $hdr -ContentType "application/json" -Body $body
Write-Host "Deploy $($deploy.id): $($deploy.required.Count) file(s) to upload"

foreach ($p in $push.Keys) {
  if ($deploy.required -contains $shaMap[$p]) {
    $ct = if ($p -like "*.html") { "text/html" } elseif ($p -eq "/_redirects") { "text/plain" } else { "application/octet-stream" }
    Write-Host "  uploading $p"
    $bytes = [System.IO.File]::ReadAllBytes($push[$p])
    Invoke-RestMethod -Method Put -Uri "https://api.netlify.com/api/v1/deploys/$($deploy.id)/files$p" -Headers $hdr -ContentType $ct -Body $bytes | Out-Null
  }
}

Write-Host "Waiting for deploy to go live..."
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 2
  $d = Invoke-RestMethod -Uri "https://api.netlify.com/api/v1/deploys/$($deploy.id)" -Headers $hdr
  if ($d.state -eq "ready")  { Write-Host "LIVE: https://giesweekly.com/about/  (deploy $($d.id))"; break }
  if ($d.state -eq "error")  { Write-Host "Deploy FAILED"; break }
}
Write-Host "Done."
