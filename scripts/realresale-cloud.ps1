[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("configure", "deploy", "start", "stop", "status")]
  [string]$Action,

  [Parameter()]
  [string]$Image,

  [Parameter()]
  [ValidateSet("NVIDIA L40S", "NVIDIA GeForce RTX 4090", "NVIDIA RTX A5000")]
  [string]$Gpu = "NVIDIA L40S"
)

$ErrorActionPreference = "Stop"
$apiRoot = "https://rest.runpod.io/v1"
$stateDirectory = Join-Path $env:LOCALAPPDATA "RealResaleCloud"
$credentialPath = Join-Path $stateDirectory "runpod-api-key.secure"
$configPath = Join-Path $stateDirectory "deployment.json"

function Get-RunpodToken {
  if (-not (Test-Path -LiteralPath $credentialPath)) {
    throw "Runpod API key not configured. Run: .\scripts\realresale-cloud.ps1 configure"
  }

  $encrypted = Get-Content -LiteralPath $credentialPath -Raw
  $secureToken = ConvertTo-SecureString $encrypted
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Get-CloudConfig {
  if (-not (Test-Path -LiteralPath $configPath)) {
    throw "No Runpod Pod is configured. Deploy first with the published GHCR image."
  }
  return Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}

function Invoke-RunpodApi {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter()][object]$Body
  )

  $token = Get-RunpodToken
  $headers = @{ Authorization = "Bearer $token" }
  $parameters = @{
    Method = $Method
    Uri = "$apiRoot$Path"
    Headers = $headers
    TimeoutSec = 60
  }
  if ($null -ne $Body) {
    $parameters.ContentType = "application/json"
    $parameters.Body = $Body | ConvertTo-Json -Depth 10 -Compress
  }

  try {
    return Invoke-RestMethod @parameters
  }
  catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode) {
      throw "Runpod API request failed (HTTP $statusCode). Check the API key, account balance, image visibility, and Pod status."
    }
    throw "Could not reach the Runpod API. Check this PC's internet connection and try again."
  }
  finally {
    $headers.Authorization = $null
    $token = $null
  }
}

switch ($Action) {
  "configure" {
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    $secureToken = Read-Host "Paste the Runpod API key (input is hidden)" -AsSecureString
    if ($secureToken.Length -lt 20) {
      throw "The API key looks too short. No key was saved."
    }
    ConvertFrom-SecureString $secureToken | Set-Content -LiteralPath $credentialPath -NoNewline
    Write-Host "API key saved encrypted for this Windows user only."
    Write-Host "It was not written into the repository."
  }

  "deploy" {
    if (-not $Image -or $Image -notmatch '^ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+:[a-zA-Z0-9_.-]+$') {
      throw "Supply a public GHCR image, for example: -Image ghcr.io/OWNER/REALRESALE:main"
    }
    if (Test-Path -LiteralPath $configPath) {
      throw "A Pod is already configured. Use status/start/stop rather than creating a second billable Pod."
    }
    $confirmation = Read-Host "This creates a billable on-demand $Gpu Pod and 50 GB persistent Pod volume. Type DEPLOY to continue"
    if ($confirmation -cne "DEPLOY") {
      Write-Host "Deployment cancelled. No cloud resources were created."
      break
    }

    $body = @{
      name = "realresale"
      imageName = $Image.ToLowerInvariant()
      computeType = "GPU"
      cloudType = "SECURE"
      gpuTypeIds = @($Gpu)
      gpuCount = 1
      gpuTypePriority = "availability"
      interruptible = $false
      containerDiskInGb = 30
      volumeInGb = 50
      volumeMountPath = "/workspace"
      ports = @("3001/http")
      env = @{
        NODE_ENV = "production"
        HOST = "0.0.0.0"
        PORT = "3001"
        DATA_DIR = "/workspace/realresale-data"
      }
    }
    $pod = Invoke-RunpodApi -Method "POST" -Path "/pods" -Body $body
    if (-not $pod.id) {
      throw "Runpod did not return a Pod ID. Check the Runpod console before retrying to avoid duplicate deployments."
    }
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    @{ podId = $pod.id; image = $Image.ToLowerInvariant(); createdAt = (Get-Date).ToUniversalTime().ToString("o") } |
      ConvertTo-Json |
      Set-Content -LiteralPath $configPath
    Write-Host "Pod created. ID: $($pod.id)"
    Write-Host "Run .\scripts\realresale-cloud.ps1 status to check when it is ready."
    Write-Host "The Pod keeps billing while running, including idle time."
  }

  "status" {
    $config = Get-CloudConfig
    $pod = Invoke-RunpodApi -Method "GET" -Path "/pods/$($config.podId)"
    Write-Host "Pod: $($pod.id)"
    Write-Host "Status: $($pod.desiredStatus)"
    if ($pod.costPerHr) {
      Write-Host "GPU rate: $($pod.costPerHr)/hour (Runpod credits)"
    }
    if ($pod.desiredStatus -eq "RUNNING") {
      Write-Host "Website: https://$($pod.id)-3001.proxy.runpod.net"
    }
    else {
      Write-Host "Website is offline until the Pod is started."
    }
  }

  "start" {
    $config = Get-CloudConfig
    $null = Invoke-RunpodApi -Method "POST" -Path "/pods/$($config.podId)/start"
    Write-Host "Start requested. Check readiness with .\scripts\realresale-cloud.ps1 status."
    Write-Host "GPU billing resumes while the Pod is running."
  }

  "stop" {
    $config = Get-CloudConfig
    $null = Invoke-RunpodApi -Method "POST" -Path "/pods/$($config.podId)/stop"
    Write-Host "Stop requested. The website will go offline and GPU billing will stop."
    Write-Host "The 50 GB persistent Pod volume remains and is billed while stopped."
  }
}
