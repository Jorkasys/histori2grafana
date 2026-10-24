<#
.SYNOPSIS
    Собирает комплект historian2grafana для компьютера без интернета.

.DESCRIPTION
    Запускается на компьютере С интернетом. Скачивает Python (переносной, без
    установки), библиотеки приложения, PostgreSQL и Grafana для Windows и
    складывает всё вместе с приложением в одну папку и архив:

        dist\historian2grafana-offline.zip

    Архив переносится на компьютер без интернета, распаковывается, и там
    приложение запускается файлом start.bat. Docker не нужен.

    С ключом -Update собирает только обновление — файлы приложения без Python,
    PostgreSQL и Grafana (меньше мегабайта, интернет не нужен):

        dist\historian2grafana-update-<версия>.zip

    Его содержимое копируется поверх уже работающего комплекта; данные в папке
    data и настройки в .env остаются.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File offline\build-offline.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File offline\build-offline.ps1 -Update
#>
param(
    [string]$PythonVersion = '3.13.16',
    [string]$PostgresVersion = '16.15-1',
    [string]$GrafanaVersion = '11.6.0',
    [string]$OutDir = '',
    [switch]$Update
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # иначе Invoke-WebRequest качает в разы медленнее
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Project = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $Project 'dist' }
$Cache = Join-Path $OutDir 'downloads'
$Bundle = Join-Path $OutDir 'historian2grafana-offline'
$Zip = "$Bundle.zip"
$Unpack = Join-Path $OutDir 'unpack'

function Step([string]$Text) {
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Fetch([string]$Url, [string]$Name) {
    $file = Join-Path $Cache $Name
    if (Test-Path $file) {
        Write-Host "   уже скачан: $Name"
        return $file
    }
    Write-Host "   скачиваю $Url"
    $part = "$file.part"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $part -UseBasicParsing
    } catch {
        throw "не удалось скачать $Url : $($_.Exception.Message)"
    }
    Move-Item $part $file
    return $file
}

function Exists([string]$Path) {
    # Только что удалённая папка несколько секунд «удаляется», и Test-Path
    # отвечает «Access denied» — считаем, что она ещё есть
    try { return (Test-Path $Path) } catch { return $true }
}

function Wipe([string]$Path) {
    # Remove-Item в Windows PowerShell 5.1 спотыкается о глубокие деревья папок
    for ($i = 0; $i -lt 15 -and (Exists $Path); $i++) {
        cmd /c "rmdir /s /q `"$Path`" 2>nul"
        if (Exists $Path) { Start-Sleep -Seconds 2 }
    }
    if (Exists $Path) { throw "не удалось удалить $Path — закройте программы, которые его используют" }
}

function Unzip([string]$Archive, [string]$Destination) {
    Wipe $Destination
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
}

function UnzipPostgres([string]$Archive, [string]$Destination) {
    # Из архива EDB берём только сервер (bin, lib, share) и лицензии:
    # pgAdmin, StackBuilder, документация и символы не нужны
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name.EndsWith('/')) { continue }
            if ($name -notmatch '^pgsql/((bin|lib|share)/.+|[^/]+\.txt)$') { continue }
            $target = Join-Path $Destination $name.Substring(6).Replace('/', '\')
            $dir = Split-Path $target
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
    } finally {
        $zip.Dispose()
    }
}

function Run([string]$Exe, [string[]]$Arguments) {
    # Предупреждения программ в stderr — не повод останавливать сборку: смотрим код выхода
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $Exe @Arguments
    $code = $LASTEXITCODE
    $ErrorActionPreference = $saved
    if ($code -ne 0) { throw "команда завершилась с ошибкой ($code): $Exe $($Arguments -join ' ')" }
}

function CopyApp([string]$Target) {
    # Файлы приложения — одинаковые в полном комплекте и в обновлении
    foreach ($dir in 'app', 'web', 'grafana', 'docker') {
        Copy-Item "$Project\$dir" "$Target\$dir" -Recurse
        Get-ChildItem "$Target\$dir" -Directory -Recurse -Filter '__pycache__' |
            ForEach-Object { Wipe $_.FullName }
    }
    Copy-Item "$Project\offline\launcher.py" $Target
    Copy-Item "$Project\offline\*.bat" $Target
    Copy-Item "$Project\README.md", "$Project\CHANGES.md", "$Project\LICENSE" $Target
    Copy-Item "$Project\.env.example" "$Target\.env.example"
}

if ($Update) {
    $version = [regex]::Match((Get-Content "$Project\app\__init__.py" -Raw -Encoding UTF8),
                              '__version__ = "([^"]+)"').Groups[1].Value
    $UpdateRoot = Join-Path $OutDir "historian2grafana-update-$version"
    $UpdateZip = "$UpdateRoot.zip"
    Step "Обновление ${version}: только файлы приложения"
    Wipe $UpdateRoot
    # Внутри — папка с тем же именем, что у комплекта: распакованное ложится поверх
    New-Item -ItemType Directory -Force "$UpdateRoot\historian2grafana-offline" | Out-Null
    CopyApp "$UpdateRoot\historian2grafana-offline"
    # Шаги установки — рядом с папкой, в корне архива: Блокнот, UTF-8 с BOM, CRLF
    $howto = (Get-Content "$Project\offline\update-howto.txt" -Raw -Encoding UTF8).Replace('{version}', $version)
    [IO.File]::WriteAllText("$UpdateRoot\Как обновить.txt", ($howto -replace "`r?`n", "`r`n"),
                            (New-Object Text.UTF8Encoding $true))
    if (Test-Path $UpdateZip) { Remove-Item $UpdateZip -Force }
    [IO.Compression.ZipFile]::CreateFromDirectory($UpdateRoot, $UpdateZip,
        [IO.Compression.CompressionLevel]::Optimal, $false)
    Wipe $UpdateRoot
    $size = [math]::Round((Get-Item $UpdateZip).Length / 1KB)
    Write-Host ''
    Write-Host "Готово: $UpdateZip ($size КБ)" -ForegroundColor Green
    Write-Host 'Как поставить — файл «Как обновить.txt» в архиве (то же — README.md, «Обновление комплекта»)'
    return
}

New-Item -ItemType Directory -Force $Cache | Out-Null
Wipe $Bundle
Wipe $Unpack
New-Item -ItemType Directory -Force "$Bundle\runtime" | Out-Null

# --------------------------------------------------------------- Python
Step "Python $PythonVersion (переносной, без установки)"
$pyZip = Fetch "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" `
               "python-$PythonVersion-embed-amd64.zip"
$PyDir = "$Bundle\runtime\python"
Unzip $pyZip $PyDir
# Переносной Python по умолчанию не видит библиотеки и папку приложения:
# разрешаем Lib\site-packages и корень комплекта (..\..)
$pth = Get-ChildItem $PyDir -Filter 'python*._pth' | Select-Object -First 1
$stdlib = (Get-Content $pth.FullName | Where-Object { $_ -match '\.zip$' }) -join "`r`n"
Set-Content $pth.FullName -Encoding ASCII -Value "$stdlib`r`n.`r`nLib\site-packages`r`n..\..`r`nimport site"

Step 'Библиотеки приложения'
$getPip = Fetch 'https://bootstrap.pypa.io/get-pip.py' 'get-pip.py'
$python = "$PyDir\python.exe"
Run $python @($getPip, '--no-warn-script-location', '--disable-pip-version-check', '--quiet')
Run $python @('-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check',
              '--quiet', '--no-cache-dir', '-r', "$Project\requirements.txt")
# Без интернета pip на целевом компьютере не пригодится
Run $python @('-m', 'pip', 'uninstall', '--yes', '--quiet', 'pip')

# ----------------------------------------------------------- PostgreSQL
Step "PostgreSQL $PostgresVersion"
$pgZip = Fetch "https://get.enterprisedb.com/postgresql/postgresql-$PostgresVersion-windows-x64-binaries.zip" `
               "postgresql-$PostgresVersion-windows-x64-binaries.zip"
UnzipPostgres $pgZip "$Bundle\runtime\pgsql"
if (-not (Test-Path "$Bundle\runtime\pgsql\bin\pg_ctl.exe")) {
    throw 'в архиве PostgreSQL не найден bin\pg_ctl.exe'
}
# PostgreSQL нужна библиотека Visual C++. На чистой Windows её может не быть —
# кладём рядом (так Microsoft разрешает распространять эти файлы)
foreach ($dll in 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll') {
    $source = "$env:WINDIR\System32\$dll"
    if (Test-Path $source) {
        Copy-Item $source "$Bundle\runtime\pgsql\bin\$dll" -Force
    } else {
        Write-Warning "$dll не найден на этом компьютере — на целевом нужен Visual C++ Redistributable"
    }
}

# --------------------------------------------------------------- Grafana
Step "Grafana $GrafanaVersion"
$gfZip = Fetch "https://dl.grafana.com/oss/release/grafana-$GrafanaVersion.windows-amd64.zip" `
               "grafana-$GrafanaVersion.windows-amd64.zip"
Unzip $gfZip $Unpack
$top = Get-ChildItem $Unpack -Directory | Select-Object -First 1
Move-Item $top.FullName "$Bundle\runtime\grafana"
Wipe $Unpack
# Документация, storybook и карты исходников для работы не нужны
foreach ($extra in 'docs', 'storybook', 'npm-artifacts', 'packaging', 'public\test') {
    Wipe "$Bundle\runtime\grafana\$extra"
}
Get-ChildItem "$Bundle\runtime\grafana\public" -Recurse -File -Filter '*.map' | Remove-Item -Force

# ------------------------------------------------------------ приложение
Step 'Приложение'
CopyApp $Bundle

Step 'Проверка: библиотеки импортируются'
Push-Location $Bundle
try {
    # Без кавычек внутри: Windows PowerShell 5.1 теряет их при передаче программе
    Run $python @('-c', 'import app.main, asyncpg, pyodbc, pymssql, uvicorn')
    Write-Host '   ok'
} finally {
    Pop-Location
}

# ----------------------------------------------------------------- архив
Step 'Архив'
if (Test-Path $Zip) { Remove-Item $Zip -Force }
[IO.Compression.ZipFile]::CreateFromDirectory($Bundle, $Zip,
    [IO.Compression.CompressionLevel]::Optimal, $true)
$size = [math]::Round((Get-Item $Zip).Length / 1MB)
Write-Host ''
Write-Host "Готово: $Zip ($size МБ)" -ForegroundColor Green
Write-Host 'Перенесите архив на компьютер без интернета, распакуйте в корень любого диска (C:\, D:\ ...)'
Write-Host 'и запустите start.bat из получившейся папки historian2grafana-offline'
