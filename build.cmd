@echo off
setlocal
title Stock Widget - Build Release
echo ============================================
echo   Stock Widget one-click build
echo   (portable dir + Inno Setup installer + zip)
echo ============================================
echo.

cd /d "%~dp0"

echo [1/3] Packaging app files + icon + zip...
node tools\make-package.js
if errorlevel 1 goto fail

echo.
echo [2/3] Compiling Inno Setup installer...
"D:\Program Files\Inno Setup 7\ISCC.exe" "installer.iss" >nul
if errorlevel 1 goto fail
echo       installer compiled

echo.
echo [3/3] DONE! Artifacts in release folder:
dir /b release\*.exe release\*.zip
echo.
echo Send to QQ group: the Setup-*.exe (installer) or *-win64.zip (portable)
echo.
pause
exit /b 0

:fail
echo.
echo [ERROR] Build failed. Send the error above to your dev assistant.
pause
exit /b 1
