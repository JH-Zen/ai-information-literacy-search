<# Install only the AI literacy skill and its private Playwright library runtime. #>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Legacy names select skill discovery directories, not a browser CLI.
    [ValidateSet('cli', 'app', 'both')][string] $Target = 'both',
    [switch] $Update
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$profileRoot = [Environment]::GetFolderPath('UserProfile')
if ([string]::IsNullOrWhiteSpace($profileRoot)) { throw 'Cannot locate the current user profile.' }
$skillSource = Join-Path $PSScriptRoot 'ai-literacy-search'
$installScript = Join-Path $skillSource 'scripts/install.ps1'
$runtimeSource = Join-Path $skillSource 'runtime'
$runtimeTemplateFiles = @('package.json', 'package-lock.json', 'repl/README.md', 'repl/snippets/bootstrap.js', 'repl/snippets/prepare.js')
foreach ($name in $runtimeTemplateFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeSource $name) -PathType Leaf)) {
        throw "Incomplete package: runtime/$name is missing."
    }
}
if (-not (Test-Path -LiteralPath $installScript -PathType Leaf)) { throw 'The skill installer is missing.' }

$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand -or -not $npmCommand) { throw 'Install Node.js 20+ with npm first.' }
$nodeVersion = & $nodeCommand.Source --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.') { throw 'Cannot determine the Node.js version.' }
if ([int]$Matches[1] -lt 20) { throw "Node.js 20+ is required; found $nodeVersion." }

$runtimeSetting = [Environment]::GetEnvironmentVariable('AI_LITERACY_RUNTIME_DIR')
$runtimeRoot = if ([string]::IsNullOrWhiteSpace($runtimeSetting)) {
    [IO.Path]::GetFullPath((Join-Path $profileRoot '.ailiteracy-runtime'))
} else { [IO.Path]::GetFullPath($runtimeSetting) }
$rootTrimmed = $runtimeRoot.TrimEnd([char[]]'\/')
if ($rootTrimmed -eq ([IO.Path]::GetPathRoot($runtimeRoot).TrimEnd([char[]]'\/')) -or
    $rootTrimmed -eq $profileRoot.TrimEnd([char[]]'\/') -or
    $rootTrimmed -eq [IO.Path]::GetFullPath($skillSource).TrimEnd([char[]]'\/')) {
    throw 'AI_LITERACY_RUNTIME_DIR must name a dedicated runtime directory.'
}
if (Test-Path -LiteralPath $runtimeRoot) {
    if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
        throw "Runtime destination is not a directory: $runtimeRoot"
    }
}

if ($PSCmdlet.ShouldProcess($runtimeRoot, 'Install pinned Playwright JavaScript dependencies with npm ci (no browser download)')) {
    [IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null
    foreach ($name in $runtimeTemplateFiles) {
        $runtimeTarget = Join-Path $runtimeRoot $name
        [IO.Directory]::CreateDirectory((Split-Path -Parent $runtimeTarget)) | Out-Null
        Copy-Item -LiteralPath (Join-Path $runtimeSource $name) -Destination $runtimeTarget -Force
    }
    $previousSkipDownload = [Environment]::GetEnvironmentVariable('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD', 'Process')
    Push-Location -LiteralPath $runtimeRoot
    try {
        [Environment]::SetEnvironmentVariable('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD', '1', 'Process')
        & $npmCommand.Source ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Private Playwright dependency installation failed.' }
        & $nodeCommand.Source -e "const {createRequire}=require('node:module'); const path=require('node:path'); const r=createRequire(path.resolve('package.json')); const p=r('playwright'); const installed=r('playwright/package.json').version; const expected=r('./package.json').dependencies.playwright; if(!p.chromium || installed!==expected) throw new Error('Playwright runtime version mismatch'); console.log('Playwright library ready: ' + installed);"
        if ($LASTEXITCODE -ne 0) { throw 'The private Playwright library could not be loaded.' }
    } finally {
        Pop-Location
        [Environment]::SetEnvironmentVariable('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD', $previousSkipDownload, 'Process')
    }
}

$scopes = if ($Target -eq 'both') { @('cli', 'app') } else { @($Target) }
foreach ($scope in $scopes) {
    $relativeRoot = if ($scope -eq 'cli') { '.agents/skills' } else { '.codex/skills' }
    $destination = Join-Path (Join-Path $profileRoot $relativeRoot) 'ai-literacy-search'
    if ((Test-Path -LiteralPath $destination -PathType Container) -and -not $Update) {
        Write-Output "Already installed: $destination. Use -Update for a managed update."
        continue
    }
    & $installScript -SkillSource $skillSource -Target $scope -Update:$Update -WhatIf:$WhatIfPreference
}
if ($WhatIfPreference) {
    Write-Output 'WhatIf complete: no runtime dependencies or skills were changed.'
} else {
    Write-Output "Private runtime: $runtimeRoot"
    Write-Output 'Ready: use $ai-literacy-search in Codex. Browser operations use the Playwright JavaScript library and local Google Chrome.'
}
