@echo off
title Musiki Backend Kurulumu
echo ===================================================
echo        MUSIKI BACKEND OTOMATIK KURULUM
echo ===================================================
echo.

cd /d "%~dp0\backend"

echo [1/3] Python sanal ortami (venv) kontrol ediliyor...
if not exist "venv" (
    echo Sanal ortam bulunamadi, olusturuluyor...
    python -m venv venv
    if errorlevel 1 (
        echo HATA: Sanal ortam olusturulamadi! Lutfen bilgisayarda Python'un yuklu oldugundan emin olun.
        pause
        exit /b 1
    )
) else (
    echo Sanal ortam zaten mevcut.
)
echo.

echo [2/3] Sanal ortam aktif ediliyor...
call venv\Scripts\activate.bat
if errorlevel 1 (
    echo HATA: Sanal ortam aktif edilemedi!
    pause
    exit /b 1
)
echo.

echo [3/3] Kutuphaneler yukleniyor (Bu islem internet hiziniza gore 10-15 dakika surebilir)...
echo Lutfen bekleyin, PyTorch gibi buyuk dosyalar indiriliyor...
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo ===================================================
    echo HATA: Kutuphaneler yuklenirken bir sorun olustu!
    echo Lutfen yukaridaki kirmizi hata mesajlarinin ekran goruntusunu alin.
    echo ===================================================
    pause
    exit /b 1
)

echo.
echo ===================================================
echo KURULUM BASARIYLA TAMAMLANDI!
echo Artik ana klasordeki "baslat.bat" dosyasina tiklayarak sunucuyu istediginiz zaman acabilirsiniz.
echo Bu pencereyi kapatabilirsiniz.
echo ===================================================
pause
