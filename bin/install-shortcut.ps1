# 在开始菜单创建 ELENVA 快捷方式（带品牌图标）。
# 由同目录的 install-shortcut.cmd 调用；也可右键「使用 PowerShell 运行」。
# 必须在用户自己的机器上运行 —— 它只是新建一个 .lnk，不修改任何系统设置。

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$start = Join-Path $root "start.cmd"
$icon = Join-Path $root "elenva.ico"

if (-not (Test-Path $start)) {
    Write-Host ""
    Write-Host "  [错误] 找不到 start.cmd。" -ForegroundColor Red
    Write-Host "  请确认本脚本与 start.cmd 在同一个目录下。"
    Write-Host ""
    exit 1
}

$programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$lnkPath = Join-Path $programs "ELENVA 工作台.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $start
$shortcut.WorkingDirectory = $root
if (Test-Path $icon) { $shortcut.IconLocation = "$icon,0" }
$shortcut.Description = "ELENVA 工作台 — 本地 AI 工作站"
$shortcut.Save()

Write-Host ""
Write-Host "  完成：已把「ELENVA 工作台」添加到开始菜单。" -ForegroundColor Green
Write-Host "  之后在开始菜单搜索 ELENVA 即可启动。"
Write-Host ""
