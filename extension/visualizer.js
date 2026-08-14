/**
 * Musiki — visualizer.js
 * Kandinsky Composition VIII tarzı canvas görselleştirme motoru.
 * Her enstrüman kanalı benzersiz geometrik şekillerle temsil edilir
 * ve müziğin frekans verisine göre canlı tepki verir.
 */

class KandinskyVisualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.width = 0;
    this.height = 0;

    // Renkler
    this.colors = {
      canvas: '#f4efe6',
      ink: '#1d1b1a',
      red: '#d4462e',
      blue: '#2660a4',
      yellow: '#e8a13c',
      green: '#3f7d3a',
      inkLight: 'rgba(29,27,26,0.25)',
      inkFaint: 'rgba(29,27,26,0.08)'
    };

    // Frekans verisi (16 bin per kanal)
    this.freqData = {
      vocals: new Array(16).fill(0),
      drums: new Array(16).fill(0),
      bass: new Array(16).fill(0),
      other: new Array(16).fill(0)
    };

    // Smoothed veriler (daha akıcı animasyon)
    this.smoothed = {
      vocals: new Array(16).fill(0),
      drums: new Array(16).fill(0),
      bass: new Array(16).fill(0),
      other: new Array(16).fill(0)
    };

    // Kanal durumları
    this.channelStates = {
      vocals: { muted: false, solo: false, energy: 0 },
      drums: { muted: false, solo: false, energy: 0 },
      bass: { muted: false, solo: false, energy: 0 },
      other: { muted: false, solo: false, energy: 0 }
    };

    // Hit test bölgeleri (click detection)
    this.hitRegions = {};

    // Animasyon state
    this.time = 0;
    this.isActive = false;

    // Dekoratif elementler — rastgele ama sabit pozisyonlar
    this.decorElements = this._generateDecorElements();

    this._resize();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width * this.dpr;
    this.height = rect.height * this.dpr;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx.scale(this.dpr, this.dpr);
    this.displayWidth = rect.width;
    this.displayHeight = rect.height;
  }

  _generateDecorElements() {
    // Sabit dekoratif elementler — Kandinsky ruhu
    const elements = [];
    const seed = 42;
    const rng = (i) => ((seed * (i + 1) * 9301 + 49297) % 233280) / 233280;

    // İnce çizgiler
    for (let i = 0; i < 6; i++) {
      elements.push({
        type: 'line',
        x1: rng(i * 4) * 400,
        y1: rng(i * 4 + 1) * 240,
        x2: rng(i * 4 + 2) * 400,
        y2: rng(i * 4 + 3) * 240,
        width: rng(i) > 0.5 ? 1 : 0.5,
      });
    }

    // Küçük üçgenler
    for (let i = 0; i < 4; i++) {
      elements.push({
        type: 'triangle',
        x: 50 + rng(i * 3 + 30) * 300,
        y: 30 + rng(i * 3 + 31) * 180,
        size: 4 + rng(i * 3 + 32) * 8,
        rotation: rng(i * 3 + 33) * Math.PI * 2,
        filled: rng(i) > 0.5
      });
    }

    // Küçük daireler
    for (let i = 0; i < 5; i++) {
      elements.push({
        type: 'dot',
        x: rng(i * 2 + 50) * 400,
        y: rng(i * 2 + 51) * 240,
        r: 1.5 + rng(i + 52) * 3,
        filled: rng(i + 53) > 0.3
      });
    }

    return elements;
  }

  /**
   * Frekans verilerini güncelle (content script'ten gelir)
   */
  updateFrequencyData(data) {
    if (!data) return;
    for (const name of ['vocals', 'drums', 'bass', 'other']) {
      if (data[name]) {
        this.freqData[name] = data[name];
      }
    }
    this.isActive = true;
  }

  /**
   * Kanal durumlarını güncelle
   */
  updateChannelStates(muted, soloChannel) {
    for (const name of ['vocals', 'drums', 'bass', 'other']) {
      this.channelStates[name].muted = muted[name] || false;
      this.channelStates[name].solo = soloChannel === name;
    }
  }

  /**
   * Canvas üzerinde tıklanan bölgeyi tespit et
   * Returns: stem adı veya null
   */
  hitTest(x, y) {
    for (const [name, region] of Object.entries(this.hitRegions)) {
      if (region.type === 'circle') {
        const dx = x - region.cx;
        const dy = y - region.cy;
        if (dx * dx + dy * dy <= region.r * region.r) return name;
      } else if (region.type === 'rect') {
        if (x >= region.x && x <= region.x + region.w &&
            y >= region.y && y <= region.y + region.h) return name;
      }
    }
    return null;
  }

  /**
   * Ana render frame
   */
  render() {
    this.time += 0.016; // ~60fps
    const ctx = this.ctx;
    const W = this.displayWidth;
    const H = this.displayHeight;

    // Smooth frequency data
    for (const name of ['vocals', 'drums', 'bass', 'other']) {
      for (let i = 0; i < 16; i++) {
        // Daha hızlı tepki için 0.15'ten 0.25'e çıkarıldı
        const target = this.freqData[name][i] / 255;
        this.smoothed[name][i] += (target - this.smoothed[name][i]) * 0.25;
      }
      // Toplam enerji
      const avg = this.smoothed[name].reduce((a, b) => a + b, 0) / 16;
      this.channelStates[name].energy = avg;
    }

    // Clear
    ctx.fillStyle = this.colors.canvas;
    ctx.fillRect(0, 0, W, H);

    // Dekoratif grid çizgiler (çok ince)
    this._drawGrid(ctx, W, H);

    // Dekoratif elementler
    this._drawDecorElements(ctx);

    // ═══ Ana Şekiller ═══
    // Sıra önemli: arkadan öne

    // 1. OTHER — Döndürülmüş çizgi demetleri (sağ üst)
    this._drawOther(ctx, W, H);

    // 2. BASS — Konsantrik daireler (sol alt)
    this._drawBass(ctx, W, H);

    // 3. DRUMS — Dama tahtası şeridi (üst orta)
    this._drawDrums(ctx, W, H);

    // 4. VOCALS — Atımlı noktalar (merkezde dağılmış)
    this._drawVocals(ctx, W, H);

    // Etiketler
    this._drawLabels(ctx, W, H);
  }

  // ─── Grid ───────────────────────────────────────────────────
  _drawGrid(ctx, W, H) {
    ctx.strokeStyle = this.colors.inkFaint;
    ctx.lineWidth = 0.5;

    // Dikey çizgiler
    for (let x = 0; x < W; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    // Yatay çizgiler
    for (let y = 0; y < H; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
  }

  // ─── Decorative Elements ────────────────────────────────────
  _drawDecorElements(ctx) {
    ctx.strokeStyle = this.colors.inkLight;
    ctx.fillStyle = this.colors.inkLight;

    for (const el of this.decorElements) {
      switch (el.type) {
        case 'line':
          ctx.lineWidth = el.width;
          ctx.beginPath();
          ctx.moveTo(el.x1, el.y1);
          ctx.lineTo(el.x2, el.y2);
          ctx.stroke();
          break;

        case 'triangle':
          ctx.save();
          ctx.translate(el.x, el.y);
          ctx.rotate(el.rotation);
          ctx.beginPath();
          ctx.moveTo(0, -el.size);
          ctx.lineTo(-el.size * 0.87, el.size * 0.5);
          ctx.lineTo(el.size * 0.87, el.size * 0.5);
          ctx.closePath();
          if (el.filled) ctx.fill();
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
          break;

        case 'dot':
          ctx.beginPath();
          ctx.arc(el.x, el.y, el.r, 0, Math.PI * 2);
          if (el.filled) ctx.fill();
          ctx.lineWidth = 0.5;
          ctx.stroke();
          break;
      }
    }
  }

  // ─── BASS: Konsantrik Daireler ──────────────────────────────
  _drawBass(ctx, W, H) {
    const cx = 70;
    const cy = H - 55;
    const baseR = 40;
    const state = this.channelStates.bass;
    const energy = state.energy;
    const isSilent = state.muted || (this._hasSolo() && !state.solo);

    // Hit region
    this.hitRegions.bass = { type: 'circle', cx, cy, r: baseR + 15 };

    const alpha = isSilent ? 0.2 : 0.9;
    // Bass pulse'u çok daha agresif yap
    const pulse = isSilent ? 0 : energy * 45;
    const boom = !isSilent && energy > 0.4 ? (energy - 0.4) * 50 : 0; // Shockwave etkisi

    // Dış halka
    ctx.strokeStyle = this._alpha(this.colors.blue, alpha * 0.4);
    ctx.lineWidth = 1.5 + boom * 0.1;
    ctx.beginPath();
    ctx.arc(cx, cy, baseR + 12 + pulse * 0.8 + boom, 0, Math.PI * 2);
    ctx.stroke();

    // 3. halka
    ctx.strokeStyle = this._alpha(this.colors.blue, alpha * 0.6);
    ctx.lineWidth = 2 + boom * 0.2;
    ctx.beginPath();
    ctx.arc(cx, cy, baseR + 4 + pulse * 0.5 + boom * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // 2. halka (dolgulu, yarı saydam)
    ctx.fillStyle = this._alpha(this.colors.blue, alpha * 0.12 + boom * 0.01);
    ctx.strokeStyle = this._alpha(this.colors.blue, alpha * 0.8);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, baseR - 8 + pulse * 0.3), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Merkez daire
    const coreR = Math.max(1, 12 + pulse * 0.2);
    ctx.fillStyle = this._alpha(this.colors.blue, alpha);
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();

    // Merkez iç daire (canvas rengi)
    ctx.fillStyle = this.colors.canvas;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 0.35, 0, Math.PI * 2);
    ctx.fill();

    // Bas frekans çubukları (alt 4 bin)
    if (!isSilent) {
      for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * Math.PI * 2 - Math.PI / 2 + (this.time * 0.5); // Etrafında dönsün
        const len = 8 + this.smoothed.bass[i] * 60; // Uzunluğu çok artırıldı
        const startR = baseR + 15 + boom;
        ctx.strokeStyle = this._alpha(this.colors.blue, 0.7);
        ctx.lineWidth = 3 + this.smoothed.bass[i] * 4; // Kalınlığı sese göre artsın
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * startR, cy + Math.sin(angle) * startR);
        ctx.lineTo(cx + Math.cos(angle) * (startR + len), cy + Math.sin(angle) * (startR + len));
        ctx.stroke();
      }
    }
  }

  // ─── DRUMS: Dama Tahtası + Yarım Daireler ──────────────────
  _drawDrums(ctx, W, H) {
    const startX = 70;
    const startY = 15;
    const cellSize = 16;
    const cols = 14;
    const rows = 3;
    const state = this.channelStates.drums;
    const energy = state.energy;
    const isSilent = state.muted || (this._hasSolo() && !state.solo);

    // Hit region
    this.hitRegions.drums = {
      type: 'rect',
      x: startX, y: startY,
      w: cols * cellSize, h: rows * cellSize + 12
    };

    const alpha = isSilent ? 0.15 : 0.85;

    // Dama tahtası
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = startX + c * cellSize;
        const y = startY + r * cellSize;
        const isBlack = (r + c) % 2 === 0;

        // Kick sırasında kareler daha çılgınca titresin ve büyüsün
        let offsetX = 0, offsetY = 0;
        let scale = 1;
        if (!isSilent && isBlack && this.smoothed.drums[0] > 0.3) {
          const kick = this.smoothed.drums[0];
          offsetX = (Math.random() - 0.5) * 12 * kick;
          offsetY = (Math.random() - 0.5) * 12 * kick;
          scale = 1 + kick * 0.3;
        }

        if (isBlack) {
          // Kick'te renk değişimi
          const kickIntensity = isSilent ? 0 : this.smoothed.drums[0];
          const fillColor = kickIntensity > 0.3
            ? this._lerpColor(this.colors.yellow, this.colors.red, (kickIntensity - 0.3) * 1.8)
            : this.colors.yellow;
          ctx.fillStyle = this._alpha(fillColor, alpha);
          
          if (scale !== 1) {
             const cx = x + cellSize / 2;
             const cy = y + cellSize / 2;
             ctx.fillRect(cx - (cellSize * scale)/2 + offsetX, cy - (cellSize * scale)/2 + offsetY, cellSize * scale, cellSize * scale);
          } else {
             ctx.fillRect(x + offsetX, y + offsetY, cellSize - 1, cellSize - 1);
          }
        } else {
          ctx.strokeStyle = this._alpha(this.colors.yellow, alpha * 0.5);
          ctx.lineWidth = 0.5;
          ctx.strokeRect(x + 0.5, y + 0.5, cellSize - 1, cellSize - 1);
        }
      }
    }

    // Yarım daireler (alt kenarda) - kick'e göre daha sert tepki
    const semicircleY = startY + rows * cellSize;
    for (let i = 0; i < 7; i++) {
      const scX = startX + i * cellSize * 2 + cellSize;
      const scR = 6 + (isSilent ? 0 : this.smoothed.drums[i + 4] * 15);

      ctx.fillStyle = this._alpha(this.colors.yellow, alpha * 0.8);
      ctx.strokeStyle = this._alpha(this.colors.ink, alpha);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(scX, semicircleY, scR, 0, Math.PI);
      ctx.fill();
      ctx.stroke();
    }
  }

  // ─── VOCALS: Atımlı Noktalar ───────────────────────────────
  _drawVocals(ctx, W, H) {
    const state = this.channelStates.vocals;
    const energy = state.energy;
    const isSilent = state.muted || (this._hasSolo() && !state.solo);
    const alpha = isSilent ? 0.15 : 0.9;

    // Sabit nokta pozisyonları (Kandinsky dağılımı)
    const dots = [
      { x: 180, y: 90 },
      { x: 220, y: 130 },
      { x: 160, y: 140 },
      { x: 250, y: 100 },
      { x: 200, y: 170 },
      { x: 280, y: 140 },
      { x: 170, y: 110 },
      { x: 240, y: 165 },
      { x: 300, y: 110 },
      { x: 145, y: 165 },
      { x: 265, y: 80 },
      { x: 315, y: 155 },
    ];

    // Hit region (kapsayan dikdörtgen)
    this.hitRegions.vocals = {
      type: 'rect',
      x: 140, y: 70,
      w: 190, h: 115
    };

    dots.forEach((dot, i) => {
      const freqI = i % 16;
      const intensity = isSilent ? 0 : this.smoothed.vocals[freqI];
      const baseR = 3 + (i % 3) * 2;
      const r = baseR + intensity * 22; // Boyutu devasa şekilde artırıldı

      // Hafif sürüklenme (drift) efekti, vokaller "havada yüzüyor" gibi
      const driftX = Math.sin(this.time + i) * intensity * 15;
      const driftY = Math.cos(this.time + i * 1.5) * intensity * 15;
      const dX = dot.x + driftX;
      const dY = dot.y + driftY;

      // Renk kayması — yüksek frekanslarda kırmızıdan turuncuya
      const hue = intensity > 0.2
        ? this._lerpColor(this.colors.red, this.colors.yellow, (intensity - 0.2) * 1.5)
        : this.colors.red;

      // Dış glow - daha görünür
      if (!isSilent && intensity > 0.1) {
        ctx.fillStyle = this._alpha(this.colors.red, intensity * 0.25);
        ctx.beginPath();
        ctx.arc(dX, dY, r + 12 + intensity * 10, 0, Math.PI * 2);
        ctx.fill();
      }

      // Ana nokta
      ctx.fillStyle = this._alpha(hue, alpha);
      ctx.beginPath();
      ctx.arc(dX, dY, r, 0, Math.PI * 2);
      ctx.fill();

      // Kenar çizgisi
      ctx.strokeStyle = this._alpha(this.colors.ink, alpha * 0.8);
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // İç nokta (büyük noktalarda)
      if (r > 8) {
        ctx.fillStyle = this.colors.canvas;
        ctx.beginPath();
        ctx.arc(dX, dY, r * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  // ─── OTHER: Döndürülmüş Çizgi Demetleri ────────────────────
  _drawOther(ctx, W, H) {
    const cx = W - 60;
    const cy = H - 70;
    const state = this.channelStates.other;
    const energy = state.energy;
    const isSilent = state.muted || (this._hasSolo() && !state.solo);
    const alpha = isSilent ? 0.15 : 0.8;

    // Hit region
    this.hitRegions.other = { type: 'circle', cx, cy, r: 55 };

    const lineCount = 14;
    const baseLen = 35;

    for (let i = 0; i < lineCount; i++) {
      const freqI = i % 16;
      const intensity = isSilent ? 0 : this.smoothed.other[freqI];

      // Temel açı + harmoniye göre çılgın sapma
      const baseAngle = (i / lineCount) * Math.PI + 0.3;
      const angleDrift = isSilent ? 0 : intensity * 1.2 * Math.sin(this.time * 3 + i);
      const angle = baseAngle + angleDrift;

      // Uzunluk ve kalınlık iyice abartıldı
      const len = baseLen + intensity * 50;
      const thickness = 1.5 + intensity * 5;

      // Çizgi çizimi
      ctx.strokeStyle = this._alpha(this.colors.ink, alpha);
      ctx.lineWidth = thickness;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(
        cx + Math.cos(angle) * 12,
        cy + Math.sin(angle) * 12
      );
      ctx.lineTo(
        cx + Math.cos(angle) * len,
        cy + Math.sin(angle) * len
      );
      ctx.stroke();
    }

    // Merkez nokta
    ctx.fillStyle = this._alpha(this.colors.ink, alpha);
    ctx.beginPath();
    ctx.arc(cx, cy, 6 + energy * 10, 0, Math.PI * 2);
    ctx.fill();

    // Yeşil aksan halkası
    if (!isSilent && energy > 0.1) {
      ctx.strokeStyle = this._alpha(this.colors.green, energy * 0.8);
      ctx.lineWidth = 2 + energy * 3;
      ctx.beginPath();
      ctx.arc(cx, cy, 20 + energy * 40, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ─── Labels ─────────────────────────────────────────────────
  _drawLabels(ctx, W, H) {
    ctx.font = '9px "Space Mono", monospace';
    ctx.fillStyle = this.colors.ink;
    ctx.textBaseline = 'top';

    // Bass label
    ctx.fillText('bas', 48, H - 18);

    // Drums label
    ctx.fillText('davul', 72, 65);

    // Vocals label
    ctx.fillText('vokal', 195, 192);

    // Other label
    ctx.fillText('diğer', W - 82, H - 24);
  }

  // ─── Idle Animasyon (stems yüklenmemişken) ──────────────────
  renderIdle() {
    this.time += 0.016;
    const ctx = this.ctx;
    const W = this.displayWidth;
    const H = this.displayHeight;

    // Sakin frekans verisi simülasyonu
    for (const name of ['vocals', 'drums', 'bass', 'other']) {
      for (let i = 0; i < 16; i++) {
        const idle = 0.03 + 0.02 * Math.sin(this.time * 0.5 + i * 0.4);
        this.smoothed[name][i] += (idle - this.smoothed[name][i]) * 0.05;
      }
      this.channelStates[name].energy =
        this.smoothed[name].reduce((a, b) => a + b, 0) / 16;
    }

    // Clear
    ctx.fillStyle = this.colors.canvas;
    ctx.fillRect(0, 0, W, H);

    this._drawGrid(ctx, W, H);
    this._drawDecorElements(ctx);
    this._drawOther(ctx, W, H);
    this._drawBass(ctx, W, H);
    this._drawDrums(ctx, W, H);
    this._drawVocals(ctx, W, H);
    this._drawLabels(ctx, W, H);
  }

  // ─── Utility Fonksiyonları ──────────────────────────────────
  _alpha(color, a) {
    // Hex → rgba
    if (color.startsWith('#')) {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
    }
    return color;
  }

  _lerpColor(c1, c2, t) {
    t = Math.max(0, Math.min(1, t));
    const r1 = parseInt(c1.slice(1, 3), 16);
    const g1 = parseInt(c1.slice(3, 5), 16);
    const b1 = parseInt(c1.slice(5, 7), 16);
    const r2 = parseInt(c2.slice(1, 3), 16);
    const g2 = parseInt(c2.slice(3, 5), 16);
    const b2 = parseInt(c2.slice(5, 7), 16);
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  _hasSolo() {
    return Object.values(this.channelStates).some(s => s.solo);
  }
}
