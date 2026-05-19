# ---------------------------------------------------------------------------
# test-backend.ps1
# ---------------------------------------------------------------------------
# Smoke test for the Context.io backend. Run from VS Code's PowerShell terminal
# while `npm run dev` is running in another terminal.
#
# Usage:
#   .\test-backend.ps1
#   .\test-backend.ps1 -BaseUrl http://localhost:8787
# ---------------------------------------------------------------------------

param(
  [string]$BaseUrl = "http://localhost:8787"
)

$ErrorActionPreference = "Continue"
$script:Pass = 0
$script:Fail = 0

function Write-Header($text) {
  Write-Host ""
  Write-Host "── $text ──" -ForegroundColor Blue
}

# Hit an endpoint and check status. Body is shown either way.
function Test-Endpoint {
  param(
    [string]$Label,
    [int]$ExpectedStatus,
    [string]$Method,
    [string]$Path,
    [object]$Body = $null,
    [hashtable]$Headers = @{}
  )

  $uri = "$BaseUrl$Path"
  $params = @{
    Uri             = $uri
    Method          = $Method
    Headers         = $Headers
    UseBasicParsing = $true
    # We never want PowerShell to throw on 4xx/5xx — we want to inspect them.
    SkipHttpErrorCheck = $true
  }
  if ($null -ne $Body) {
    $params["Body"]        = ($Body | ConvertTo-Json -Depth 10 -Compress)
    $params["ContentType"] = "application/json"
  }

  try {
    $resp = Invoke-WebRequest @params
    $status = [int]$resp.StatusCode
    $bodyText = $resp.Content
  } catch {
    # Fallback for older PS versions without SkipHttpErrorCheck.
    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      $stream = $_.Exception.Response.GetResponseStream()
      $reader = New-Object System.IO.StreamReader($stream)
      $bodyText = $reader.ReadToEnd()
    } else {
      Write-Host "  ✗ $Label — request failed: $($_.Exception.Message)" -ForegroundColor Red
      $script:Fail++
      return
    }
  }

  if ($status -eq $ExpectedStatus) {
    Write-Host "  ✓ $Label [$status]" -ForegroundColor Green
    $script:Pass++
  } else {
    Write-Host "  ✗ $Label — expected $ExpectedStatus, got $status" -ForegroundColor Red
    $script:Fail++
  }

  if ($bodyText) {
    try {
      $pretty = $bodyText | ConvertFrom-Json | ConvertTo-Json -Depth 10
      $pretty -split "`n" | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    } catch {
      Write-Host "      $bodyText" -ForegroundColor DarkGray
    }
  }
}

# ---------- preflight ----------

Write-Host "Context.io backend smoke tests" -ForegroundColor White
Write-Host "Target: $BaseUrl"

try {
  $health = Invoke-WebRequest -Uri "$BaseUrl/health" -TimeoutSec 3 -UseBasicParsing
  if ($health.StatusCode -ne 200) { throw "non-200" }
} catch {
  Write-Host ""
  Write-Host "Cannot reach $BaseUrl/health." -ForegroundColor Red
  Write-Host "Start the backend first in another terminal:"
  Write-Host "  cd context-io-backend; npm run dev" -ForegroundColor White
  exit 1
}

# ---------- tests ----------

Write-Header "1. Health check"
Test-Endpoint -Label "GET /health returns 200" -ExpectedStatus 200 `
  -Method GET -Path "/health"

Write-Header "2. Validation — must reject bad input"

Test-Endpoint -Label "empty body" -ExpectedStatus 400 `
  -Method POST -Path "/translate-context" -Body @{}

Test-Endpoint -Label "missing text" -ExpectedStatus 400 `
  -Method POST -Path "/translate-context" -Body @{ targetLanguage = "es" }

Test-Endpoint -Label "empty text" -ExpectedStatus 400 `
  -Method POST -Path "/translate-context" -Body @{ text = "   "; targetLanguage = "es" }

Test-Endpoint -Label "missing targetLanguage" -ExpectedStatus 400 `
  -Method POST -Path "/translate-context" -Body @{ text = "hello" }

Test-Endpoint -Label "targetLanguage = auto (not allowed)" -ExpectedStatus 400 `
  -Method POST -Path "/translate-context" -Body @{ text = "hello"; targetLanguage = "auto" }

Test-Endpoint -Label "invalid tone" -ExpectedStatus 400 `
  -Method POST -Path "/translate-context" -Body @{ text = "hello"; targetLanguage = "es"; tone = "sassy" }

Test-Endpoint -Label "invalid source language" -ExpectedStatus 400 `
  -Method POST -Path "/translate-context" -Body @{ text = "hello"; sourceLanguage = "klingon"; targetLanguage = "es" }

Write-Header "3. Unknown routes"
Test-Endpoint -Label "GET /nope returns 404" -ExpectedStatus 404 `
  -Method GET -Path "/nope"

Write-Header "4. Real translation calls (these hit Claude — cost a few cents)"
Write-Host "  Note: requires ANTHROPIC_API_KEY in your backend .env" -ForegroundColor Yellow

Test-Endpoint -Label "startup CFO → Spanish" -ExpectedStatus 200 `
  -Method POST -Path "/translate-context" -Body @{
    text           = "We need to derisk the runway before the next board meeting."
    profession     = "Startup CFO"
    sourceLanguage = "en"
    targetLanguage = "es"
    tone           = "executive"
  }

Test-Endpoint -Label "ICU nurse → Spanish" -ExpectedStatus 200 `
  -Method POST -Path "/translate-context" -Body @{
    text           = "Push the patient on pressors and re-check the lactate in 30."
    profession     = "ICU Nurse"
    sourceLanguage = "en"
    targetLanguage = "es"
    tone           = "neutral"
  }

Test-Endpoint -Label "backend engineer → French" -ExpectedStatus 200 `
  -Method POST -Path "/translate-context" -Body @{
    text           = "We rolled back the migration after seeing replication lag spike."
    profession     = "Backend Engineer"
    sourceLanguage = "en"
    targetLanguage = "fr"
    tone           = "neutral"
  }

Test-Endpoint -Label "no profession (general)" -ExpectedStatus 200 `
  -Method POST -Path "/translate-context" -Body @{
    text           = "Looking forward to our chat tomorrow."
    sourceLanguage = "en"
    targetLanguage = "de"
    tone           = "conversational"
  }

Write-Header "5. CORS preflight"
Test-Endpoint -Label "OPTIONS preflight from chrome-extension origin" -ExpectedStatus 204 `
  -Method OPTIONS -Path "/translate-context" -Headers @{
    "Origin"                         = "chrome-extension://abcdefghijklmnop"
    "Access-Control-Request-Method"  = "POST"
    "Access-Control-Request-Headers" = "Content-Type"
  }

Write-Header "6. Rate limiting (35 quick requests, expects some 429s)"
Write-Host "  Firing 35 requests..."
$codes = @()
1..35 | ForEach-Object {
  try {
    $r = Invoke-WebRequest -Uri "$BaseUrl/translate-context" -Method POST `
      -ContentType "application/json" `
      -Body '{"text":"","targetLanguage":"es"}' `
      -UseBasicParsing -SkipHttpErrorCheck
    $codes += [int]$r.StatusCode
  } catch {
    if ($_.Exception.Response) { $codes += [int]$_.Exception.Response.StatusCode }
  }
}
$n429 = ($codes | Where-Object { $_ -eq 429 }).Count
$n400 = ($codes | Where-Object { $_ -eq 400 }).Count
Write-Host "  Got: $n400 × 400 (validation), $n429 × 429 (rate limited)"
if ($n429 -gt 0) {
  Write-Host "  ✓ Rate limiter is active" -ForegroundColor Green
  $script:Pass++
} else {
  Write-Host "  ! No 429s seen — your RATE_LIMIT_MAX may be set high" -ForegroundColor Yellow
}

# ---------- summary ----------

Write-Host ""
Write-Host "─────────────────────────────────────" -ForegroundColor White
if ($script:Fail -eq 0) {
  Write-Host "All checks passed   ($($script:Pass) passed)" -ForegroundColor Green
  exit 0
} else {
  Write-Host "$($script:Fail) failed, $($script:Pass) passed" -ForegroundColor Red
  exit 1
}
