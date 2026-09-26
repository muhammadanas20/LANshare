/**
 * Smoothed transfer-rate meter.
 *
 * Raw byte deltas are extremely noisy on the first and last frames, so we keep a
 * short sliding window plus an exponential moving average. This yields the steady
 * "18.4 MB/s" readout instead of a jittering number.
 */
export class SpeedMeter {
  private samples: Array<{ at: number; bytes: number }> = [];
  private ema: number | null = null;
  private readonly windowMs: number;

  constructor(windowMs = 4000) {
    this.windowMs = windowMs;
  }

  reset(): void {
    this.samples = [];
    this.ema = null;
  }

  /** Feed the absolute number of bytes transferred so far. */
  update(totalBytes: number, at = performance.now()): number {
    this.samples.push({ at, bytes: totalBytes });
    const cutoff = at - this.windowMs;
    while (this.samples.length > 2 && (this.samples[1] as { at: number }).at < cutoff) {
      this.samples.shift();
    }
    if (this.samples.length > 120) this.samples.splice(0, this.samples.length - 120);

    const first = this.samples[0] as { at: number; bytes: number };
    const elapsed = (at - first.at) / 1000;
    if (elapsed < 0.02) return this.ema ?? 0;
    const inst = Math.max(0, (totalBytes - first.bytes) / elapsed);
    // A short transfer never reaches the smoothing window. Seed the average with
    // the measured rate rather than reporting nothing, so small files still show a
    // speed and an ETA.
    if (elapsed < 0.2) {
      this.ema = this.ema ?? inst;
      return this.ema;
    }
    this.ema = this.ema === null ? inst : this.ema * 0.7 + inst * 0.3;
    return this.ema;
  }

  get bytesPerSecond(): number {
    return this.ema ?? 0;
  }

  /** Remaining seconds or null while the estimate is still unstable. */
  eta(remainingBytes: number): number | null {
    if (this.ema === null || this.ema < 1024) return null;
    if (remainingBytes <= 0) return 0;
    return remainingBytes / this.ema;
  }
}
