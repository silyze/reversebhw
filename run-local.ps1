[CmdletBinding()]
param(
  [ValidateSet("test", "check", "build", "all")]
  [string]$Task = "test"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bun = Join-Path $projectRoot ".tools\bun-windows-x64\bun.exe"

if (-not (Test-Path -LiteralPath $bun -PathType Leaf)) {
  throw "Project-local Bun was not found at $bun. Restore reversebhw/.tools before running this script."
}

function Invoke-Bun([string[]]$BunArguments) {
  & $bun @BunArguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

Push-Location $projectRoot
try {
  switch ($Task) {
    "test" { Invoke-Bun @("test") }
    "check" { Invoke-Bun @("run", "check") }
    "build" { Invoke-Bun @("run", "build") }
    "all" {
      Invoke-Bun @("test")
      Invoke-Bun @("run", "check")
      Invoke-Bun @("run", "build")
    }
  }
}
finally {
  Pop-Location
}
