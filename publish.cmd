@echo off
rem 双击即可发布到 GitHub。想自动建仓库 + 设 topics 的话，先设置一个 token：
rem     set GITHUB_TOKEN=ghp_xxxxxxxx
rem 再双击本文件。
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" %*
echo.
pause
