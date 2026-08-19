/**
 * The 1€ filter (Casiez, Roussel & Vogel, CHI 2012).
 *
 * Head tracking has to be simultaneously still when you hold your head steady
 * and snappy when you move — a fixed low-pass can only buy one at the cost of
 * the other. The 1€ filter adapts its cutoff to the observed speed, which is
 * exactly the trade-off we want: heavy smoothing at rest, almost none in motion.
 */

class LowPass {
  constructor() {
    this.hasPrev = false;
    this.state = 0;
  }

  filter(x, alpha) {
    this.state = this.hasPrev ? alpha * x + (1 - alpha) * this.state : x;
    this.hasPrev = true;
    return this.state;
  }

  reset() {
    this.hasPrev = false;
    this.state = 0;
  }
}

function alphaFor(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  /**
   * @param {number} minCutoff Cutoff (Hz) at zero speed — lower is smoother.
   * @param {number} beta      Speed coefficient — higher cuts lag on fast motion.
   * @param {number} dCutoff   Cutoff (Hz) for the derivative estimate.
   */
  constructor(minCutoff = 1.0, beta = 0.01, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPass();
    this.dxFilter = new LowPass();
    this.prev = null;
  }

  filter(x, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) dt = 1 / 60;
    const dx = this.prev === null ? 0 : (x - this.prev) / dt;
    const edx = this.dxFilter.filter(dx, alphaFor(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const out = this.xFilter.filter(x, alphaFor(cutoff, dt));
    this.prev = x;
    return out;
  }

  reset() {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.prev = null;
  }
}

/** Three independent 1€ filters, one per axis. */
export class Vec3Filter {
  constructor(minCutoff = 1.0, beta = 0.01) {
    this.axes = [
      new OneEuroFilter(minCutoff, beta),
      new OneEuroFilter(minCutoff, beta),
      new OneEuroFilter(minCutoff, beta),
    ];
  }

  setParams(minCutoff, beta) {
    for (const f of this.axes) { f.minCutoff = minCutoff; f.beta = beta; }
  }

  /** @param {{x:number,y:number,z:number}} v @param {number} dt seconds */
  filter(v, dt) {
    return {
      x: this.axes[0].filter(v.x, dt),
      y: this.axes[1].filter(v.y, dt),
      z: this.axes[2].filter(v.z, dt),
    };
  }

  reset() { for (const f of this.axes) f.reset(); }
}

/** Frame-rate independent exponential approach: reaches ~63% of the gap in `tau` seconds. */
export function damp(current, target, tau, dt) {
  if (tau <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
