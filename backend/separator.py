"""
Musiki — Ses Ayrıştırma Motoru (Demucs)
htdemucs modeli ile 4 kanala ayrıştırma: vocals, drums, bass, other.
CUDA varsa GPU kullanır, model startup'ta belleğe yüklenir.
"""

import os
import asyncio
import logging
import torch
import torchaudio

logger = logging.getLogger(__name__)

STEMS_DIR = os.path.join(os.path.dirname(__file__), "stems")
STEM_NAMES = ["vocals", "drums", "bass", "other"]


class AudioSeparator:
    def __init__(self, model_name: str = "htdemucs"):
        self.model_name = model_name
        self.model = None
        self.device = None
        self._loaded = False

    def load_model(self):
        """
        Modeli belleğe yükle — uygulama başlangıcında çağrılır.
        CUDA varsa GPU'ya, yoksa CPU'ya yükler.
        """
        from demucs.pretrained import get_model

        # Cihaz seçimi
        if torch.cuda.is_available():
            self.device = torch.device("cuda")
            gpu_name = torch.cuda.get_device_name(0)
            vram = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            logger.info(f"🎯 GPU bulundu: {gpu_name} ({vram:.1f} GB VRAM)")
        else:
            self.device = torch.device("cpu")
            logger.info("⚠️  GPU bulunamadı, CPU kullanılacak (yavaş olabilir)")

        logger.info(f"📦 Demucs modeli yükleniyor: '{self.model_name}'...")
        self.model = get_model(self.model_name)
        self.model.to(self.device)
        self.model.eval()
        self._loaded = True

        logger.info(
            f"✅ Model yüklendi: {self.model_name} → {self.device} | "
            f"Kaynaklar: {self.model.sources}"
        )

    def _separate_sync(self, audio_path: str, output_dir: str) -> dict[str, str]:
        """
        Senkron ayrıştırma işlemi (thread pool'da çalıştırılacak).
        Returns: { "vocals": "/path/to/vocals.wav", ... }
        """
        from demucs.apply import apply_model

        if not self._loaded:
            raise RuntimeError("Model yüklenmemiş! load_model() çağırın.")

        os.makedirs(output_dir, exist_ok=True)

        logger.info(f"🎵 Ses yükleniyor: {audio_path}")
        wav, sr = torchaudio.load(audio_path)

        # Model'in beklediği sample rate'e resample
        if sr != self.model.samplerate:
            logger.info(
                f"🔄 Resampling: {sr} Hz → {self.model.samplerate} Hz"
            )
            resampler = torchaudio.transforms.Resample(
                orig_freq=sr, new_freq=self.model.samplerate
            )
            wav = resampler(wav)

        # Stereo'ya dönüştür (model stereo bekler)
        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)
        elif wav.shape[0] > 2:
            wav = wav[:2]

        # Normalize
        ref = wav.mean(0)
        wav_mean = ref.mean()
        wav_std = ref.std() + 1e-8
        wav_normalized = (wav - wav_mean) / wav_std

        logger.info(
            f"🔬 Ayrıştırma başlıyor... "
            f"({wav.shape[1] / self.model.samplerate:.1f} saniye ses)"
        )

        # Ayrıştırma — hız optimizasyonları
        with torch.no_grad():
            sources = apply_model(
                self.model,
                wav_normalized[None].to(self.device),
                device=self.device,
                shifts=0,        # Shift trick kapalı → hız
                overlap=0.1,     # Düşük overlap → hız
            )

        # Denormalize
        sources = sources * wav_std + wav_mean
        sources = sources[0]  # Batch boyutunu kaldır → (sources, channels, samples)

        # Her stem'i kaydet
        stem_paths = {}
        model_sources = list(self.model.sources)

        for i, name in enumerate(model_sources):
            stem_path = os.path.join(output_dir, f"{name}.wav")
            stem_audio = sources[i].cpu()

            # Clipping önleme
            max_val = stem_audio.abs().max()
            if max_val > 1.0:
                stem_audio = stem_audio / max_val

            torchaudio.save(stem_path, stem_audio, self.model.samplerate)
            stem_paths[name] = stem_path
            size_mb = os.path.getsize(stem_path) / (1024 * 1024)
            logger.info(f"  ✅ {name}.wav kaydedildi ({size_mb:.1f} MB)")

        logger.info("🎉 Ayrıştırma tamamlandı!")
        return stem_paths

    async def separate(self, audio_path: str, output_dir: str) -> dict[str, str]:
        """
        Asenkron ayrıştırma — CPU-bound işlemi thread pool'da çalıştırır.
        Returns: { "vocals": "/path/to/vocals.wav", ... }
        """
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, self._separate_sync, audio_path, output_dir
        )

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    @property
    def device_name(self) -> str:
        if self.device is None:
            return "not loaded"
        return str(self.device)
