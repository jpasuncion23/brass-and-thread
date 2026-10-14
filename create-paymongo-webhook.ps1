# =========================================================================
# Brass & Thread - register the paymongo-webhook Edge Function with PayMongo
# -------------------------------------------------------------------------
# PayMongo's dashboard has no Webhooks page for some accounts, so this
# creates the webhook through their API instead. Run it yourself in
# PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File .\create-paymongo-webhook.ps1
#
# It asks for your secret key (hidden while typing - never saved anywhere)
# and the paymongo-webhook function URL, then prints the webhook's signing
# secret (whsk_...). Paste that into Supabase -> Edge Functions -> Secrets
# as PAYMONGO_WEBHOOK_SECRET.
#
# Test and live keys get separate webhooks - run this again with your
# sk_live_ key when you go live.
# =========================================================================

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$secure = Read-Host "PayMongo SECRET key (sk_test_...)" -AsSecureString
$key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
).Trim()

# The input is hidden, so a double paste (Ctrl+V plus right-click both
# paste in a terminal) goes unnoticed - undo it if the key is repeated.
if ($key.Length % 2 -eq 0) {
  $half = $key.Substring(0, $key.Length / 2)
  if ($half + $half -eq $key) { $key = $half }
}

Write-Host ("Key read: {0}...{1} ({2} characters)" -f $key.Substring(0, [Math]::Min(8, $key.Length)), $key.Substring([Math]::Max(0, $key.Length - 4)), $key.Length)

if (-not $key.StartsWith("sk_")) {
  Write-Host "That doesn't look like a secret key (should start with sk_test_ or sk_live_)." -ForegroundColor Red
  exit 1
}

$url = (Read-Host "paymongo-webhook URL (https://...supabase.co/functions/v1/...)").Trim()
if (-not $url.StartsWith("https://")) {
  Write-Host "The URL should start with https://" -ForegroundColor Red
  exit 1
}

$headers = @{
  Authorization  = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${key}:"))
  "Content-Type" = "application/json"
}

$body = @{
  data = @{
    attributes = @{
      url    = $url
      events = @("checkout_session.payment.paid", "source.chargeable", "payment.paid", "payment.failed")
    }
  }
} | ConvertTo-Json -Depth 5

# Already have a webhook for this URL (in this key's mode)? Update its
# events instead of making a second one - its signing secret stays the
# same, so PAYMONGO_WEBHOOK_SECRET in Supabase doesn't need to change.
$existing = $null
try {
  $list = Invoke-RestMethod -Method Get -Uri "https://api.paymongo.com/v1/webhooks" -Headers $headers
  $existing = $list.data | Where-Object { $_.attributes.url -eq $url } | Select-Object -First 1
} catch {
  Write-Host "Couldn't list existing webhooks:" -ForegroundColor Red
  Write-Host $_.ErrorDetails.Message
  exit 1
}

if ($existing) {
  try {
    $res = Invoke-RestMethod -Method Put -Uri "https://api.paymongo.com/v1/webhooks/$($existing.id)" -Headers $headers -Body $body
  } catch {
    Write-Host "PayMongo rejected the update:" -ForegroundColor Red
    Write-Host $_.ErrorDetails.Message
    exit 1
  }
  Write-Host ""
  Write-Host "Webhook updated: $($res.data.id)" -ForegroundColor Green
  Write-Host "Events: $($res.data.attributes.events -join ', ')"
  Write-Host "Signing secret unchanged - nothing to update in Supabase." -ForegroundColor Yellow
  exit 0
}

try {
  $res = Invoke-RestMethod -Method Post -Uri "https://api.paymongo.com/v1/webhooks" -Headers $headers -Body $body
} catch {
  Write-Host "PayMongo rejected the request:" -ForegroundColor Red
  Write-Host $_.ErrorDetails.Message
  Write-Host ""
  Write-Host "Existing webhooks on this account:" -ForegroundColor Yellow
  try {
    $list = Invoke-RestMethod -Method Get -Uri "https://api.paymongo.com/v1/webhooks" -Headers $headers
    foreach ($w in $list.data) {
      Write-Host ("  {0}  {1}  [{2}]  secret: {3}" -f $w.id, $w.attributes.url, $w.attributes.status, $w.attributes.secret_key)
    }
  } catch {
    Write-Host $_.ErrorDetails.Message
  }
  exit 1
}

Write-Host ""
Write-Host "Webhook created: $($res.data.id)" -ForegroundColor Green
Write-Host "Events: $($res.data.attributes.events -join ', ')"
Write-Host ""
Write-Host "Signing secret - paste into Supabase as PAYMONGO_WEBHOOK_SECRET:" -ForegroundColor Yellow
Write-Host $res.data.attributes.secret_key
