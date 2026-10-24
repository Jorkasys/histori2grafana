<#
.SYNOPSIS
    Заполняет оглавление в руководствах Word после сборки (node docs/source/build.js).

.DESCRIPTION
    Пакет docx записывает оглавление пустым полем: заполнить его может только сам
    Word. Сценарий открывает docs\Инструкция.docx и docs\Скрипты.docx в Word без
    окна, обновляет поля и сохраняет. Затем убирает из свойств файла имя
    пользователя Windows, которое Word вписывает при сохранении.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File docs\source\toc.ps1
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$Docs = Split-Path -Parent $PSScriptRoot
$Files = @('Инструкция.docx', 'Скрипты.docx') | ForEach-Object { Join-Path $Docs $_ }

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    foreach ($file in $Files) {
        $doc = $word.Documents.Open($file, $false, $false)
        foreach ($toc in $doc.TablesOfContents) { $toc.Update() }
        $doc.Fields.Update() | Out-Null
        $doc.Save()
        Write-Host ("{0}: страниц {1}" -f (Split-Path -Leaf $file), $doc.ComputeStatistics(2))
        $doc.Close($false)
    }
} finally {
    $word.Quit()
}

foreach ($file in $Files) {
    $zip = [IO.Compression.ZipFile]::Open($file, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = $zip.GetEntry('docProps/core.xml')
        $reader = New-Object IO.StreamReader($entry.Open())
        $xml = $reader.ReadToEnd()
        $reader.Close()
        $xml = $xml -replace '<cp:lastModifiedBy>[^<]*</cp:lastModifiedBy>',
                             '<cp:lastModifiedBy>historian2grafana</cp:lastModifiedBy>'
        $entry.Delete()
        $writer = New-Object IO.StreamWriter($zip.CreateEntry('docProps/core.xml').Open(),
                                             (New-Object Text.UTF8Encoding $false))
        $writer.Write($xml)
        $writer.Close()
    } finally {
        $zip.Dispose()
    }
}
Write-Host 'Готово: оглавления заполнены'
