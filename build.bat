@echo off
echo Building Compelem DevTools...

:: Clean dist
if exist dist rmdir /s /q dist
mkdir dist

:: Build with vite
call npx vite build

:: Copy static files
echo Copying static files...
copy /y manifest.json dist\manifest.json >nul
xcopy /s /e /y public dist\public >nul
xcopy /s /e /y src\panel\styles dist\panel\styles >nul
copy /y src\panel\index.html dist\panel\index.html >nul
copy /y src\devtools\index.html dist\devtools\index.html >nul

echo Build complete!
