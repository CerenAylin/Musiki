/**
 * Musiki — pitch-shifter-worklet.js
 * High-quality granular pitch shifter using COLA (Constant Overlap-Add).
 *
 * Technique: 4 overlapping grains at 25% stagger with Hann windowing.
 * The sum of 4 Hann windows at 25% offset = constant (COLA condition),
 * ensuring artifact-free crossfading.
 *
 * Quality improvements over basic 2-grain:
 *   - 4 grains → seamless crossfade, no periodic buzz
 *   - 2048 sample grains → preserves harmonic structure
 *   - Cubic interpolation → smooth sub-sample reading
 *   - Random jitter on grain reset → breaks periodicity artifacts
 *
 * Range: ±12 semitones (1 octave up/down)
 * Latency: ~46ms (2048 samples at 44.1kHz)
 * CPU: Very low per stem
 */
class PitchShifterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.grainSize = 2048;         // ~46ms at 44.1kHz — good harmonic preservation
    this.numGrains = 4;            // COLA with 75% overlap
    this.hopSize = this.grainSize / this.numGrains; // 512 samples between grains
    this.pitchRatio = 1.0;
    this.semitones = 0;

    // Circular buffer — generous size for safety
    this.bufferSize = this.grainSize * 8;

    // Per-channel state (lazily initialized)
    this.channels = [];

    // Precompute Hann window
    this.hannWindow = new Float32Array(this.grainSize);
    for (let i = 0; i < this.grainSize; i++) {
      this.hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.grainSize));
    }

    // Normalization: 4 Hann windows at 25% stagger sum to exactly 2.0
    // So each grain's contribution is scaled by 0.5
    this.normFactor = 2.0 / this.numGrains; // = 0.5

    // Listen for pitch changes from main thread
    this.port.onmessage = (event) => {
      if (event.data.semitones !== undefined) {
        this.semitones = event.data.semitones;
        this.pitchRatio = Math.pow(2, this.semitones / 12);
      }
    };
  }

  /**
   * Initialize per-channel state with staggered grains.
   */
  initChannel(ch) {
    if (!this.channels[ch]) {
      const grains = [];
      for (let g = 0; g < this.numGrains; g++) {
        grains.push({
          readPos: g * this.hopSize,
          phase: g * this.hopSize  // staggered start
        });
      }
      this.channels[ch] = {
        buffer: new Float32Array(this.bufferSize),
        writePos: this.grainSize * 2, // head start so grains have data
        grains
      };
    }
  }

  /**
   * Cubic (Catmull-Rom) interpolation for smooth sub-sample reading.
   * Significantly reduces aliasing compared to linear interpolation.
   */
  cubicInterp(buf, bs, pos) {
    const i = Math.floor(pos);
    const f = pos - i;

    const im1 = ((i - 1) % bs + bs) % bs;
    const i0  = ((i)     % bs + bs) % bs;
    const i1  = ((i + 1) % bs + bs) % bs;
    const i2  = ((i + 2) % bs + bs) % bs;

    const y0 = buf[im1];
    const y1 = buf[i0];
    const y2 = buf[i1];
    const y3 = buf[i2];

    // Catmull-Rom spline
    const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    const a1 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    const a2 = -0.5 * y0 + 0.5 * y2;
    const a3 = y1;

    return ((a0 * f + a1) * f + a2) * f + a3;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input.length || !output || !output.length) {
      return true;
    }

    const ratio = this.pitchRatio;
    const gs = this.grainSize;
    const bs = this.bufferSize;
    const hs = this.hopSize;
    const hann = this.hannWindow;
    const norm = this.normFactor;
    const nGrains = this.numGrains;
    const bypass = (ratio > 0.999 && ratio < 1.001);

    for (let ch = 0; ch < input.length; ch++) {
      this.initChannel(ch);

      const state = this.channels[ch];
      const buf = state.buffer;
      const inp = input[ch];
      const out = output[ch] || new Float32Array(inp.length);

      for (let i = 0; i < inp.length; i++) {
        // ── Write input to circular buffer ──
        buf[state.writePos % bs] = inp[i];
        state.writePos++;

        // ── Bypass when no pitch shift ──
        if (bypass) {
          out[i] = inp[i];
          // Keep grains tracking write position
          for (let g = 0; g < nGrains; g++) {
            state.grains[g].readPos = state.writePos - gs + g * hs;
            state.grains[g].phase = g * hs;
          }
          continue;
        }

        // ── Sum all grain contributions ──
        let sample = 0;

        for (let g = 0; g < nGrains; g++) {
          const grain = state.grains[g];

          // Hann window weight at current phase position
          const phaseInGrain = grain.phase % gs;
          const weight = hann[phaseInGrain] * norm;

          // Read with cubic interpolation
          const val = this.cubicInterp(buf, bs, grain.readPos);

          sample += val * weight;

          // Advance read position at pitch ratio speed
          grain.readPos += ratio;
          grain.phase++;

          // ── Grain reset when cycle completes ──
          if (grain.phase >= gs) {
            grain.phase = 0;

            // Reset read position near write head, offset back by grain size
            // Add small random jitter (±64 samples) to break periodicity artifacts
            // This is the key trick that eliminates the "robotic" sound
            const jitter = (Math.random() * 128 - 64) | 0;
            grain.readPos = state.writePos - gs + jitter;
          }
        }

        out[i] = sample;
      }

      // Ensure output is written
      if (output[ch] && output[ch] !== out) {
        output[ch].set(out);
      }
    }

    // Copy first channel to extra output channels
    if (output.length > input.length && input.length > 0) {
      for (let ch = input.length; ch < output.length; ch++) {
        if (output[ch] && output[0]) {
          output[ch].set(output[0]);
        }
      }
    }

    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifterProcessor);
