/**
 * Persistent, observable configuration.
 *
 * Every physical quantity is in CENTIMETRES and every angle in RADIANS unless
 * the property name says otherwise (`*Deg`, `*Inches`). The 3D world uses the
 * same centimetre scale, which is what makes the off-axis projection in
 * `geometry.js` physically meaningful.
 */

const STORAGE_KEY = 'hologram3d.config.v1';

export const DEFAULTS = {
  /* ---- illusion ---- */
  mode: 'hybrid',          // 'window' | 'hybrid' | 'turntable'
  parallaxGain: 1.0,       // multiplies head translation before projection
  rotationGain: 1.0,       // extra counter-rotation applied to the model
  verticalGain: 1.0,       // scales the pitch component of both effects
  invert: false,           // flip the counter-rotation (breaks the illusion; for A/B)

  /* ---- model ---- */
  modelUrl: 'models/AngelSculpture/scene.gltf',
  modelLabel: 'Angel Sculpture',
  modelSizeCm: 22,
  modelDepthCm: -6,        // negative = behind the screen plane, positive = in front
  modelHeightCm: 0,
  modelBaseYawDeg: 0,
  autoSpin: false,
  playAnimations: true,

  /* ---- scene ---- */
  // AR passthrough. Not persisted as "on" across devices in any meaningful way,
  // but kept here so the whole config plumbing (sync, listeners) applies to it.
  arMode: false,
  showRoom: true,
  showFrame: true,
  showProps: true,
  shadows: true,
  roomDepthCm: 70,
  exposure: 1.05,

  /* ---- calibration ---- */
  screenDiagonalInches: 24,
  camOffsetAuto: true,     // derive webcam Y from the display height
  camOffsetXCm: 0,
  camOffsetYCm: 0,         // used when camOffsetAuto === false
  camFovDeg: 62,           // camera FOV across the LONG image axis (see geometry.js)
  ipdCm: 6.3,              // interpupillary distance
  recenterX: 0,            // calibration offsets captured by "Recentre"
  recenterY: 0,

  /* ---- tracking ---- */
  minCutoff: 1.2,          // 1€ filter: lower = smoother, more lag
  beta: 0.010,             // 1€ filter: higher = less lag on fast motion
  drawMesh: false,
  showPreview: true,
  showHud: true,
  useGpu: true,

  /* ---- device ---- */
  // Which class of device this stored profile was calibrated on. When it does
  // not match the current device the physical defaults are re-seeded, so the
  // same browser profile syncing between a laptop and a phone does not carry a
  // 24-inch diagonal onto a 6-inch screen.
  deviceClass: null,
};

/** Mode presets — modes are just shorthand for gain combinations. */
export const MODE_PRESETS = {
  window:    { parallaxGain: 1.0, rotationGain: 0.0 },
  hybrid:    { parallaxGain: 1.0, rotationGain: 1.0 },
  turntable: { parallaxGain: 0.0, rotationGain: 2.0 },
};

export const MODE_HINTS = {
  window:
    'Pure off-axis projection — exactly what a real object behind a window looks like. ' +
    'Subtle but geometrically truthful. Set your display size correctly for this one.',
  hybrid:
    'Physically correct parallax <em>plus</em> extra counter-rotation. The most convincing ' +
    '"it&rsquo;s floating there" result on a normal desktop monitor.',
  turntable:
    'Camera stays put; the model alone counter-rotates against your head. Exaggerated and ' +
    'great for inspecting a model, but the perspective is not physically exact.',
};

/**
 * Bounds for the numeric settings, mirroring the slider ranges in index.html.
 * Persisted state is untrusted input: it may come from an older build whose
 * ranges differed, or from a half-finished experiment. A single out-of-range
 * value (a zeroed gain, a nonsense screen size) breaks the illusion in a way
 * that looks like a bug rather than a setting, so anything that does not fit
 * is dropped back to its default instead of being carried forward.
 */
export const RANGES = {
  parallaxGain: [0, 3], rotationGain: [0, 3], verticalGain: [0, 2],
  modelSizeCm: [4, 80], modelDepthCm: [-60, 35], modelHeightCm: [-25, 25],
  modelBaseYawDeg: [-180, 180], roomDepthCm: [20, 160], exposure: [0.2, 3],
  // Phones start near 5", desktop monitors reach 49", so this must span far
  // wider than any single device class — a value rejected here silently reverts
  // to the desktop default on the NEXT load, long after calibration looked fine.
  screenDiagonalInches: [3, 90], camOffsetXCm: [-40, 40], camOffsetYCm: [-40, 40],
  camFovDeg: [35, 110], ipdCm: [5.0, 7.6], minCutoff: [0.05, 6], beta: [0, 0.08],
  recenterX: [-100, 100], recenterY: [-100, 100],
};

function load() {
  let obj;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== 'object') return {};

  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in DEFAULTS)) continue;                       // unknown/renamed key
    // `deviceClass` defaults to null, so a plain typeof comparison would always
    // reject the stored string. It is validated against the known classes.
    if (k === 'deviceClass') {
      if (['phone', 'tablet', 'desktop'].includes(v)) clean[k] = v;
      continue;
    }
    if (typeof v !== typeof DEFAULTS[k]) continue;        // type drift
    const range = RANGES[k];
    if (range && (!Number.isFinite(v) || v < range[0] || v > range[1])) continue;
    clean[k] = v;
  }
  return clean;
}

const listeners = new Set();

/** Live config object. Mutate through `set()` so listeners fire and state persists. */
export const config = Object.assign({}, DEFAULTS, load());

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      // Never persist an object-URL model — it dies with the page.
      const snapshot = { ...config };
      if (String(snapshot.modelUrl).startsWith('blob:')) {
        snapshot.modelUrl = DEFAULTS.modelUrl;
        snapshot.modelLabel = DEFAULTS.modelLabel;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch { /* private mode / quota — non-fatal */ }
  }, 220);
}

/** Update one or more keys; notifies subscribers with the list of changed keys. */
export function set(patch) {
  const changed = [];
  for (const [k, v] of Object.entries(patch)) {
    if (config[k] !== v) { config[k] = v; changed.push(k); }
  }
  if (!changed.length) return changed;
  persist();
  for (const fn of listeners) fn(changed, config);
  return changed;
}

/** Subscribe to config changes. Returns an unsubscribe function. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Restore factory defaults (keeps the currently loaded model if it is a blob). */
export function reset() {
  const keep = String(config.modelUrl).startsWith('blob:')
    ? { modelUrl: config.modelUrl, modelLabel: config.modelLabel }
    : {};
  set({ ...DEFAULTS, ...keep });
}

export function applyMode(mode) {
  const preset = MODE_PRESETS[mode];
  if (!preset) return;
  set({ mode, ...preset });
}
