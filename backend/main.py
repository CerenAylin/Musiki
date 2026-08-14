"""
Musiki — FastAPI Backend
YouTube ses ayrıştırma sunucusu. Localhost üzerinde çalışır.
"""

import os
import sys
import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# pyrefly: ignore [missing-import]
from fastapi import FastAPI, HTTPException
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
# pyrefly: ignore [missing-import]
from fastapi.staticfiles import StaticFiles
# pyrefly: ignore [missing-import]
from fastapi.responses import FileResponse
# pyrefly: ignore [missing-import]
from pydantic import BaseModel

from database import Database
from downloader import AudioDownloader
from separator import AudioSeparator, STEMS_DIR, STEM_NAMES

# ─── Logging ────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s │ %(levelname)-7s │ %(name)s │ %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("musiki")

# ─── Global Instances ───────────────────────────────────────────────
db = Database()
downloader = AudioDownloader()
separator = AudioSeparator(model_name="htdemucs")

# İşlem durumu takibi (in-memory)
processing_status: dict[str, dict] = {}
processing_tasks: dict[str, asyncio.Task] = {}


# ─── Lifespan ────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Uygulama başlangıcında model ve DB'yi hazırla."""
    await db.initialize()
    separator.load_model()
    logger.info("🎶 Musiki sunucusu hazır!")
    yield
    logger.info("Musiki sunucusu kapanıyor.")


# ─── FastAPI App ─────────────────────────────────────────────────────
app = FastAPI(
    title="Musiki API",
    description="YouTube ses ayrıştırma servisi",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — Chrome eklentisi ve YouTube sayfası erişimi
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)

# Stems dizinini oluştur (StaticFiles mount'tan önce var olmalı)
os.makedirs(STEMS_DIR, exist_ok=True)

# Statik dosya servisi — stem WAV dosyaları
app.mount("/stems", StaticFiles(directory=STEMS_DIR), name="stems")


# ─── Models ──────────────────────────────────────────────────────────
class SeparateRequest(BaseModel):
    video_id: str


class SeparateResponse(BaseModel):
    status: str
    video_id: str
    title: str | None = None
    duration: float | None = None
    stems: dict[str, str] | None = None
    error: str | None = None


# ─── Helpers ─────────────────────────────────────────────────────────
def _build_stems_urls(video_id: str) -> dict[str, str]:
    """Stem dosyaları için URL'ler oluştur."""
    return {name: f"/stems/{video_id}/{name}.wav" for name in STEM_NAMES}


async def _process_video(video_id: str):
    """Arka planda video indirme ve ayrıştırma."""
    try:
        # 1. İndirme
        processing_status[video_id] = {
            "status": "downloading",
            "title": None,
            "duration": None,
            "stems": None,
            "error": None,
        }
        logger.info(f"📥 İndirme başlıyor: {video_id}")
        audio_path, title, duration = await downloader.download(video_id)

        # 2. Ayrıştırma
        processing_status[video_id]["status"] = "separating"
        processing_status[video_id]["title"] = title
        processing_status[video_id]["duration"] = duration
        logger.info(f"🔬 Ayrıştırma başlıyor: {title}")

        output_dir = os.path.join(STEMS_DIR, video_id)
        await separator.separate(audio_path, output_dir)

        # 3. Cache kaydet
        await db.save_cache(video_id, title, duration, output_dir)

        # 4. Geçici indirme dosyasını temizle
        downloader.cleanup(video_id)

        # 5. Durumu güncelle
        stems_urls = _build_stems_urls(video_id)
        processing_status[video_id] = {
            "status": "completed",
            "title": title,
            "duration": duration,
            "stems": stems_urls,
            "error": None,
        }
        logger.info(f"🎉 Tamamlandı: {title}")

    except asyncio.CancelledError:
        logger.warning(f"⚠️ İşlem iptal edildi: {video_id}")
        processing_status[video_id] = {
            "status": "error",
            "title": processing_status.get(video_id, {}).get("title"),
            "duration": None,
            "stems": None,
            "error": "İptal edildi",
        }
        downloader.cleanup(video_id)
        # Yarım kalan stems klasörünü temizle
        output_dir = Path(STEMS_DIR) / video_id
        if output_dir.exists():
            import shutil
            shutil.rmtree(output_dir, ignore_errors=True)
            
    except Exception as e:
        logger.error(f"❌ Hata ({video_id}): {e}", exc_info=True)
        processing_status[video_id] = {
            "status": "error",
            "title": processing_status.get(video_id, {}).get("title"),
            "duration": None,
            "stems": None,
            "error": str(e),
        }
    finally:
        # Task'i listeden çıkar
        processing_tasks.pop(video_id, None)


# ─── Endpoints ───────────────────────────────────────────────────────
@app.post("/api/separate", response_model=SeparateResponse)
async def separate(request: SeparateRequest):
    """
    Ses ayrıştırma başlat veya cache'ten dön.
    Non-blocking: işlemi arka planda başlatır, status endpoint ile takip edilir.
    """
    video_id = request.video_id.strip()
    if not video_id:
        raise HTTPException(status_code=400, detail="video_id boş olamaz")

    # 1. Cache kontrolü
    cached = await db.get_cached(video_id)
    if cached:
        logger.info(f"💾 Cache bulundu: {cached['title']}")
        return SeparateResponse(
            status="cached",
            video_id=video_id,
            title=cached["title"],
            duration=cached["duration"],
            stems=_build_stems_urls(video_id),
        )

    # 2. Zaten işleniyor mu?
    current = processing_status.get(video_id)
    if current and current["status"] in ("downloading", "separating"):
        return SeparateResponse(
            status=current["status"],
            video_id=video_id,
            title=current.get("title"),
        )

    # 3. Yeni işlem başlat
    task = asyncio.create_task(_process_video(video_id))
    processing_tasks[video_id] = task

    return SeparateResponse(
        status="processing",
        video_id=video_id,
    )


@app.get("/api/status/{video_id}", response_model=SeparateResponse)
async def get_status(video_id: str):
    """İşlem durumu sorgula."""
    # In-memory durumu kontrol
    current = processing_status.get(video_id)
    if current:
        return SeparateResponse(video_id=video_id, **current)

    # Cache kontrolü
    cached = await db.get_cached(video_id)
    if cached:
        return SeparateResponse(
            status="cached",
            video_id=video_id,
            title=cached["title"],
            duration=cached["duration"],
            stems=_build_stems_urls(video_id),
        )

    return SeparateResponse(status="not_found", video_id=video_id)


@app.get("/api/download/{video_id}/{stem_name}")
async def download_stem(video_id: str, stem_name: str):
    """Tek bir stem dosyasını indir."""
    if stem_name not in STEM_NAMES:
        raise HTTPException(
            status_code=400,
            detail=f"Geçersiz stem: {stem_name}. "
            f"Geçerli: {', '.join(STEM_NAMES)}",
        )

    stem_path = Path(STEMS_DIR) / video_id / f"{stem_name}.wav"
    if not stem_path.exists():
        raise HTTPException(status_code=404, detail="Stem dosyası bulunamadı")

    return FileResponse(
        path=str(stem_path),
        filename=f"{video_id}_{stem_name}.wav",
        media_type="audio/wav",
    )


@app.get("/api/cache")
async def list_cache():
    """Tüm önbellek kayıtlarını listele."""
    items = await db.list_all()
    return {"items": items, "count": len(items)}


@app.delete("/api/cache/{video_id}")
async def delete_cache(video_id: str):
    """Belirli bir video'nun cache kaydını ve dosyalarını sil."""
    import shutil

    stems_path = Path(STEMS_DIR) / video_id
    if stems_path.exists():
        shutil.rmtree(stems_path)

    await db.delete_cache(video_id)
    processing_status.pop(video_id, None)

    return {"status": "deleted", "video_id": video_id}


@app.post("/api/cancel/{video_id}")
async def cancel_process(video_id: str):
    """Devam eden ayrıştırma işlemini iptal et."""
    task = processing_tasks.get(video_id)
    if task and not task.done():
        task.cancel()
        return {"status": "canceled", "video_id": video_id}
    
    return {"status": "not_running", "video_id": video_id}


@app.get("/api/health")
async def health():
    """Sunucu sağlık kontrolü."""
    return {
        "status": "ok",
        "model": separator.model_name,
        "device": separator.device_name,
        "model_loaded": separator.is_loaded,
    }


# ─── Run ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # pyrefly: ignore [missing-import]
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8765,
        reload=False,
        log_level="info",
    )
