"""
Musiki — YouTube Ses İndirici
yt-dlp kullanarak YouTube videosunun sesini en hızlı şekilde indirir.
"""

import os
import asyncio
import logging
import yt_dlp

logger = logging.getLogger(__name__)

DOWNLOAD_DIR = os.path.join(os.path.dirname(__file__), "downloads")


class AudioDownloader:
    def __init__(self):
        os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    def _get_ydl_opts(self, output_path: str) -> dict:
        """yt-dlp konfigürasyonu — hız odaklı."""
        return {
            "format": "bestaudio/best",
            "outtmpl": output_path,
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "wav",
                    "preferredquality": "0",
                }
            ],
            "quiet": True,
            "no_warnings": True,
            "extract_flat": False,
            "socket_timeout": 30,
            "retries": 3,
            "extractor_args": {
                "youtube": ["player_client=default,-android_sdkless"]
            },
            # Hız optimizasyonları
            "concurrent_fragment_downloads": 4,
            "buffersize": 1024 * 64,
        }

    def _download_sync(self, video_id: str) -> tuple[str, str, float]:
        """
        Senkron indirme işlemi (thread pool'da çalıştırılacak).
        Returns: (wav_path, title, duration)
        """
        url = f"https://www.youtube.com/watch?v={video_id}"
        output_template = os.path.join(DOWNLOAD_DIR, f"{video_id}")
        opts = self._get_ydl_opts(output_template)

        logger.info(f"İndirme başlıyor: {video_id}")

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get("title", "Bilinmeyen")
            duration = info.get("duration", 0.0)

        # yt-dlp postprocessor .wav uzantısı ekler
        wav_path = output_template + ".wav"
        if not os.path.exists(wav_path):
            # Bazen farklı uzantıyla kaydedilir, kontrol et
            for ext in [".wav", ".mp3", ".m4a", ".webm", ".opus"]:
                candidate = output_template + ext
                if os.path.exists(candidate):
                    wav_path = candidate
                    break

        if not os.path.exists(wav_path):
            raise FileNotFoundError(
                f"İndirilen dosya bulunamadı: {output_template}.*"
            )

        file_size_mb = os.path.getsize(wav_path) / (1024 * 1024)
        logger.info(
            f"İndirme tamamlandı: {title} "
            f"({duration:.0f}s, {file_size_mb:.1f} MB)"
        )

        return wav_path, title, duration

    async def download(self, video_id: str) -> tuple[str, str, float]:
        """
        Asenkron indirme — CPU'yu bloklamadan thread pool'da çalıştırır.
        Returns: (wav_path, title, duration)
        """
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._download_sync, video_id)

    def cleanup(self, video_id: str):
        """İndirilen geçici dosyaları temizle."""
        for ext in [".wav", ".mp3", ".m4a", ".webm", ".opus", ".part"]:
            path = os.path.join(DOWNLOAD_DIR, f"{video_id}{ext}")
            if os.path.exists(path):
                try:
                    os.remove(path)
                    logger.debug(f"Temizlendi: {path}")
                except OSError:
                    pass
