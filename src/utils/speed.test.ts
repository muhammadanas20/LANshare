import { describe, expect, it } from 'vitest';
import { SpeedMeter } from './speed';

describe('SpeedMeter', () => {
  it('returns zero until there is enough signal', () => {
    const meter = new SpeedMeter();
    expect(meter.update(1000, 0)).toBe(0);
    expect(meter.eta(5000)).toBeNull();
  });

  it('smooths towards the steady rate instead of reporting spikes', () => {
    const meter = new SpeedMeter();
    let bytes = 0;
    // 1 MB per 100 ms = ~10 MB/s
    for (let index = 0; index < 40; index += 1) {
      bytes += 1024 * 1024;
      meter.update(bytes, index * 100);
    }
    const speed = meter.bytesPerSecond;
    expect(speed).toBeGreaterThan(8 * 1024 * 1024);
    expect(speed).toBeLessThan(12 * 1024 * 1024);
  });

  it('computes a plausible ETA', () => {
    const meter = new SpeedMeter();
    let bytes = 0;
    for (let index = 0; index < 40; index += 1) {
      bytes += 1024 * 1024;
      meter.update(bytes, index * 100);
    }
    const eta = meter.eta(10 * 1024 * 1024);
    expect(eta).not.toBeNull();
    expect(eta as number).toBeGreaterThan(0.5);
    expect(eta as number).toBeLessThan(2.5);
  });

  it('reports a measured rate for transfers shorter than the smoothing window', () => {
    const meter = new SpeedMeter();
    meter.update(0, 1000);
    // 512 KB in 100 ms = ~5 MB/s, well inside the 0.2 s smoothing window.
    const speed = meter.update(512 * 1024, 1100);
    expect(speed).toBeGreaterThan(4 * 1024 * 1024);
    expect(speed).toBeLessThan(6 * 1024 * 1024);
  });

  it('resets cleanly', () => {
    const meter = new SpeedMeter();
    meter.update(1024, 0);
    meter.update(2048, 1000);
    meter.reset();
    expect(meter.bytesPerSecond).toBe(0);
    expect(meter.eta(1000)).toBeNull();
  });

  it('never reports negative rates', () => {
    const meter = new SpeedMeter();
    meter.update(1000, 0);
    const value = meter.update(0, 500);
    expect(value).toBeGreaterThanOrEqual(0);
  });
});
