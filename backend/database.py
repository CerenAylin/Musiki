"""
Musiki — SQLite Cache Veritabanı
Ayrıştırılmış stem sonuçlarını önbelleğe alarak tekrar işlemeyi önler.
"""

import aiosqlite
import os
import time
import logging

logger = logging.getLogger(__name__)

DB_DIR = os.path.join(os.path.dirname(__file__), "data")
DB_PATH = os.path.join(DB_DIR, "musiki.db")


class Database:
    def __init__(self):
        self.db_path = DB_PATH

    async def initialize(self):
        """Veritabanını ve tabloları oluştur."""
        os.makedirs(DB_DIR, exist_ok=True)
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS separations (
                    video_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    duration REAL,
                    stems_path TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
            """)
            await db.commit()
        logger.info(f"Veritabanı hazır: {self.db_path}")

    async def get_cached(self, video_id: str) -> dict | None:
        """
        Video ID'ye göre önbellekten stem bilgilerini getir.
        Eğer stem dosyaları diskten silinmişse, cache kaydını da temizle.
        """
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM separations WHERE video_id = ?",
                (video_id,)
            )
            row = await cursor.fetchone()
            if row is None:
                return None

            # Stem dosyalarının hâlâ diskte var olduğunu doğrula
            stems_path = row["stems_path"]
            required_stems = ["vocals.wav", "drums.wav", "bass.wav", "other.wav"]
            all_exist = all(
                os.path.exists(os.path.join(stems_path, s)) for s in required_stems
            )

            if not all_exist:
                logger.warning(
                    f"Cache kaydı var ama stem dosyaları eksik: {video_id}. "
                    "Cache temizleniyor."
                )
                await db.execute(
                    "DELETE FROM separations WHERE video_id = ?", (video_id,)
                )
                await db.commit()
                return None

            return {
                "video_id": row["video_id"],
                "title": row["title"],
                "duration": row["duration"],
                "stems_path": row["stems_path"],
                "created_at": row["created_at"],
            }

    async def save_cache(
        self, video_id: str, title: str, duration: float, stems_path: str
    ):
        """Ayrıştırma sonucunu önbelleğe kaydet."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                INSERT OR REPLACE INTO separations
                    (video_id, title, duration, stems_path, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (video_id, title, duration, stems_path, time.time()),
            )
            await db.commit()
        logger.info(f"Cache kaydedildi: {video_id} — {title}")

    async def list_all(self) -> list[dict]:
        """Tüm önbellek kayıtlarını listele."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM separations ORDER BY created_at DESC"
            )
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

    async def delete_cache(self, video_id: str):
        """Belirli bir video'nun cache kaydını sil."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "DELETE FROM separations WHERE video_id = ?", (video_id,)
            )
            await db.commit()
        logger.info(f"Cache silindi: {video_id}")
