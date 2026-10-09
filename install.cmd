@echo off
rem 双击或命令行运行都行；等价于 pwsh -File install-profile.ps1 %*
rem 用 -ExecutionPolicy Bypass 是因为很多机器默认禁止运行 .ps1。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-profile.ps1" %*
pause
