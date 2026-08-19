/**
 * Device profiling.
 *
 * The illusion is built on physical measurements, and every one of the sensible
 * desktop defaults is wrong on a phone: a 24" diagonal, a webcam sitting above
 * a landscape panel, shadows the GPU can afford. Worse, two of them change while
 * the app is running, because a phone can be rotated — which physically moves
 * the front camera from the top of the display to its side.
 *
 * This module owns those facts so the rest of the app can stay device-agnostic.
 */

/** Typical display diagonals, in inches, used as the starting guess per class. */
const DIAGONAL_BY_CLASS = {
  phone: 6.1,
  tablet: 10.5,
  desktop: 24,
};

/** How far the front camera sits beyond the edge of the panel, in centimetres. */
const BEZEL_BY_CLASS = {
  phone: 0.5,     // notch / punch-hole, essentially at the edge
  tablet: 0.8,
  desktop: 1.0,   // laptop or monitor bezel
};

/**
 * Classify the device. Deliberately based on the display's short edge in CSS
 * pixels rather than on the user-agent string: it survives orientation changes,
 * desktop-mode requests and browsers that lie about who they are.
 */
export function detectDeviceClass() {
  const shortEdge = Math.min(screen.width, screen.height);
  const touch = (navigator.maxTouchPoints || 0) > 0;

  if (touch && shortEdge <= 500) return 'phone';
  if (touch && shortEdge <= 900) return 'tablet';
  return 'desktop';
}

export const isTouchDevice = () => (navigator.maxTouchPoints || 0) > 0;

/** iOS Safari on iPhone has no Element.requestFullscreen at all. */
export function supportsFullscreen() {
  return !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
}

/**
 * How far the viewport is rotated from the device's natural orientation, in
 * degrees. `screen.orientation` is the modern answer; `window.orientation` is
 * the iOS < 16.4 fallback.
 */
export function orientationAngle() {
  const a = screen.orientation?.angle;
  if (typeof a === 'number') return ((a % 360) + 360) % 360;
  const legacy = window.orientation;
  if (typeof legacy === 'number') return ((legacy % 360) + 360) % 360;
  return 0;
}

/**
 * Where the front camera sits relative to the centre of the display, in
 * centimetres, in the CURRENT viewport frame (+x right, +y up).
 *
 * The camera is bonded to the hardware at the top-centre of the display in its
 * natural orientation. Rotating the device leaves the camera where it is but
 * rotates the coordinate frame underneath it, so the offset vector rotates with
 * the viewport:
 *
 *     angle   0° (portrait)  → camera above  →  (0, +h/2)
 *     angle  90°             → camera left   →  (−w/2, 0)
 *     angle 180°             → camera below  →  (0, −h/2)
 *     angle 270°             → camera right  →  (+w/2, 0)
 *
 * On a desktop the angle is always 0, so this reduces exactly to the old
 * "webcam above the monitor" behaviour.
 *
 * @param {number} screenWidthCm  current viewport-frame display width
 * @param {number} screenHeightCm current viewport-frame display height
 * @param {number} bezelCm
 * @param {number} angleDeg
 */
export function cameraOffsetForOrientation(screenWidthCm, screenHeightCm, bezelCm, angleDeg) {
  const rad = angleDeg * Math.PI / 180;

  // Rotating (0, 1) counter-clockwise by `angle`.
  const ux = -Math.sin(rad);
  const uy = Math.cos(rad);

  // The camera lies half of the device's NATURAL height away from the centre.
  // In a rotated frame that natural height is measured along the current width.
  const quarterTurn = Math.abs(Math.round(angleDeg / 90)) % 2 === 1;
  const halfNativeHeight = (quarterTurn ? screenWidthCm : screenHeightCm) / 2;
  const distance = halfNativeHeight + bezelCm;

  return { x: ux * distance, y: uy * distance };
}

/**
 * How far the viewer's eye typically sits from the display, in centimetres.
 * A phone is held at arm's length; a monitor is a metre-ish away.
 */
const REST_DISTANCE_BY_CLASS = {
  phone: 35,
  tablet: 45,
  desktop: 60,
};

export function restDistanceForClass(deviceClass) {
  return REST_DISTANCE_BY_CLASS[deviceClass] ?? REST_DISTANCE_BY_CLASS.desktop;
}

/**
 * Scene proportions per class.
 *
 * These are physical sizes, and physical realism is the whole point — but a
 * 22 cm statue behind a 6.5 cm phone window is *correctly* rendered as a giant
 * object mostly outside the frame. Truthful, and a useless first impression.
 * The scene is therefore scaled to the aperture it is viewed through, which is
 * what a diorama builder would do anyway.
 */
const SCENE_BY_CLASS = {
  phone:   { modelSizeCm: 7,  modelDepthCm: -2, roomDepthCm: 25 },
  tablet:  { modelSizeCm: 13, modelDepthCm: -4, roomDepthCm: 42 },
  desktop: { modelSizeCm: 22, modelDepthCm: -6, roomDepthCm: 70 },
};

/** Per-class starting settings, applied when the app first meets a device. */
export function defaultsForClass(deviceClass) {
  const scene = SCENE_BY_CLASS[deviceClass] ?? SCENE_BY_CLASS.desktop;
  return {
    screenDiagonalInches: DIAGONAL_BY_CLASS[deviceClass] ?? DIAGONAL_BY_CLASS.desktop,
    ...scene,
    // A phone GPU running a 300k-triangle model cannot also afford soft shadows.
    shadows: deviceClass === 'desktop',
    // On a small screen the preview steals real estate the illusion needs.
    showPreview: deviceClass === 'desktop',
    showHud: deviceClass === 'desktop',
  };
}

export function bezelForClass(deviceClass) {
  return BEZEL_BY_CLASS[deviceClass] ?? BEZEL_BY_CLASS.desktop;
}

/**
 * Rendering budget. Phones have punishing fill-rate limits and a devicePixelRatio
 * of 3, which would mean shading nine times as many fragments as CSS pixels.
 */
export function renderBudgetForClass(deviceClass) {
  switch (deviceClass) {
    case 'phone':  return { maxPixelRatio: 1.75, shadowMapSize: 1024, targetFps: 45 };
    case 'tablet': return { maxPixelRatio: 2.0,  shadowMapSize: 1536, targetFps: 50 };
    default:       return { maxPixelRatio: 2.0,  shadowMapSize: 2048, targetFps: 55 };
  }
}
