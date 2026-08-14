@echo off
title Musiki Sunucusu
echo ===================================================
echo             MUSIKI SUNUCUSU BASLATICI
echo ===================================================
echo.

cd /d "%~dp0"

:: Sanal ortam var mi diye kontrol et, yoksa once kurulumu calistir
if not exist "backend\venv\Scripts\activate.bat" (
    echo Kurulum yapilmamis! Ilk kurulum otomatik olarak baslatiliyor...
    echo.
    call kurulum.bat
    :: Kurulumda hata olduysa calistirmayi iptal et
    if errorlevel 1 exit /b 1
)

cd /d "%~dp0\backend"

echo Sunucu baslatiliyor...
echo Arkada bu siyah pencere acik kaldigi surece eklenti calisacaktir.
echo Isiniz bitince bu pencereyi (X) kapatabilirsiniz.
echo.
echo Loglar asagida goruntulenecektir:
echo ---------------------------------------------------

call venv\Scripts\activate.bat
python main.py

if errorlevel 1 (
    echo.
    echo ---------------------------------------------------
    echo ===================================================
    echo HATA: Sunucu calisirken bir hata olustu veya kapandi!
    echo Lutfen yukaridaki hata mesajlarinin ekran goruntusunu alin.
    echo ===================================================
    pause
)
