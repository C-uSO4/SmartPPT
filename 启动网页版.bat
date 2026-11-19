@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 此脚本仅启动旧本地开发兼容服务；在线静态版不需要运行本脚本。
where node >nul 2>nul
if not errorlevel 1 goto start_with_node
if exist "D:\Qoder CN\Qoder CN.exe" goto start_with_qoder
echo 未找到电脑已有的 Node.js 或 Qoder 运行时。
pause
exit /b 1

:start_with_qoder
set "ELECTRON_RUN_AS_NODE=1"
start "FORM 智能美化 PPT 本地开发服务" cmd /k ""D:\Qoder CN\Qoder CN.exe" src\web\server.js"
goto open_page

:start_with_node
start "FORM 智能美化 PPT 本地开发服务" cmd /k "node src\web\server.js"

:open_page
%SystemRoot%\System32\timeout.exe /t 1 /nobreak >nul
start "" "http://127.0.0.1:4173"
echo 网页版已打开。关闭“FORM 智能美化 PPT 本地开发服务”窗口即可停止服务。
pause
