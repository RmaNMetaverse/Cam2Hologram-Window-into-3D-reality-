/**
 * The maths that turns "pixels of a face" into "a window into 3D space".
 *
 * ── World convention ───────────────────────────────────────────────────────
 *   Origin  : the centre of the rendering canvas, on the physical glass.
 *   +X      : the viewer's RIGHT.
 *   +Y      : up.
 *   +Z      : out of the screen, towards the viewer.
 *   Units   : centimetres. Right-handed, matching three.js.
 *
 * ── Raw webcam image convention ────────────────────────────────────────────
 *   A webcam faces the viewer, so the image it produces is NOT mirrored: when
 *   you move to your own right, your face moves towards SMALLER image x. That
 *   is the single sign flip that makes everything else fall into place, and it
 *   is why `eyeFromLandmarks` negates the horizontal term.
 */

/* MediaPipe FaceLandmarker indices (the 478-point model with iris refinement). */
export const LM = {
  IRIS_A: 468,        // centre of one iris
  IRIS_B: 473,        // centre of the other
  EYE_CORNER_A: 33,   // outer corner, fallback when irises are unavailable
  EYE_CORNER_B: 263,
  NOSE_TIP: 1,
};

/** Outer-eye-corner separation of an average adult head, used only as a fallback. */
const OUTER_CORNER_CM = 9.1;

/**
 * Convert face landmarks into the viewer's eye position, expressed in
 * centimetres relative to the WEBCAM.
 *
 * Depth comes from the apparent size of a known real-world length. The
 * interpupillary distance is the best available choice: it is nearly constant
 * across adults (±4%), it is rigid (unlike face width, which changes with
 * expression), and it barely foreshortens for the modest head yaw angles this
 * app cares about.
 *
 *     z = f · IPD_real / IPD_pixels        with f = (W/2) / tan(hFov/2)
 *
 * @param {Array<{x:number,y:number,z:number}>} lm  normalised landmarks (0..1)
 * @param {number} vw video width in pixels
 * @param {number} vh video height in pixels
 * @param {{camFovDeg:number, ipdCm:number}} opts
 * @returns {{x:number,y:number,z:number,ipdPx:number,ok:boolean}|null}
 */
export function eyeFromLandmarks(lm, vw, vh, opts) {
  if (!lm || lm.length < 468 || !vw || !vh) return null;

  const hasIris = lm.length > LM.IRIS_B;
  const a = hasIris ? lm[LM.IRIS_A] : lm[LM.EYE_CORNER_A];
  const b = hasIris ? lm[LM.IRIS_B] : lm[LM.EYE_CORNER_B];
  if (!a || !b) return null;

  const realSepCm = hasIris ? opts.ipdCm : OUTER_CORNER_CM;

  // Landmark coordinates are normalised to the image; scale to pixels.
  const ax = a.x * vw, ay = a.y * vh;
  const bx = b.x * vw, by = b.y * vh;

  const sepPx = Math.hypot(bx - ax, by - ay);
  if (!(sepPx > 1)) return null;

  // Focal length in pixels, derived from the assumed field of view.
  //
  // Measured along the LONG image axis, not along width. A phone held upright
  // delivers a portrait stream (e.g. 720×1280) from the same sensor that gives
  // 1280×720 in landscape; the lens angle belongs to the sensor's wide axis, so
  // anchoring to width would halve the estimated focal length on rotation and
  // put the viewer at twice their real distance. For a landscape desktop stream
  // the long axis IS the width, so this is identical to the naive form.
  const longSide = Math.max(vw, vh);
  const f = (longSide / 2) / Math.tan((opts.camFovDeg * Math.PI / 180) / 2);

  const z = (f * realSepCm) / sepPx;               // distance from the camera, cm
  const mx = (ax + bx) / 2;                        // midpoint between the eyes, px
  const my = (ay + by) / 2;

  return {
    // Negated: the un-mirrored webcam image runs opposite to the viewer's X.
    x: -((mx - vw / 2) * z / f),
    // Negated: image Y grows downward, world Y grows upward.
    y: -((my - vh / 2) * z / f),
    z,
    ipdPx: sepPx,
    ok: true,
  };
}

/**
 * Re-express a camera-relative eye position in canvas-centred world coordinates.
 *
 * Chain of offsets:  eye←camera  +  camera←screenCentre  −  canvasCentre←screenCentre
 *
 * @param {{x,y,z}} eyeCam    eye relative to the webcam, cm
 * @param {object}  layout    from `measureLayout()`
 * @param {object}  cfg       live config
 */
export function eyeToCanvasSpace(eyeCam, layout, cfg) {
  // In auto mode the offset comes from `layout.cameraOffset`, which already
  // accounts for device rotation — on a phone in landscape the front camera is
  // at the SIDE of the display, not above it.
  const cam = cfg.camOffsetAuto
    ? layout.cameraOffset
    : { x: cfg.camOffsetXCm, y: cfg.camOffsetYCm };

  return {
    x: eyeCam.x + cam.x - layout.canvasCentreXCm - cfg.recenterX,
    y: eyeCam.y + cam.y - layout.canvasCentreYCm - cfg.recenterY,
    z: Math.max(eyeCam.z, 5),
  };
}

/**
 * Measure how big the drawing surface physically is, and where it sits on the
 * display. Both matter: the frustum is built from the canvas rectangle, and a
 * window that is not centred on the screen shifts the whole illusion.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} cfg
 */
export function measureLayout(canvas, cfg, device = {}) {
  // `screen.width/height` follow the current orientation on mobile, which is
  // what we want: every quantity below lives in the viewport frame.
  const sw = Math.max(screen.width, 1);
  const sh = Math.max(screen.height, 1);

  // CSS pixels per centimetre, from the stated diagonal.
  const diagPx = Math.hypot(sw, sh);
  const pxPerCm = diagPx / Math.max(cfg.screenDiagonalInches * 2.54, 1);

  const rect = canvas.getBoundingClientRect();

  // A canvas cannot be physically larger than the display it is drawn on. It can
  // however be *measured* that way, if the stated diagonal is far too small or
  // the page is zoomed. Left unclamped that yields a window wider than the world,
  // and the frustum degenerates. Clamping turns a bad calibration into a merely
  // imprecise one instead of a broken render.
  const canvasWidthCm = Math.min(Math.max(rect.width / pxPerCm, 1), sw / pxPerCm);
  const canvasHeightCm = Math.min(Math.max(rect.height / pxPerCm, 1), sh / pxPerCm);

  // Where is the canvas centre relative to the display centre? `screenX/Y` give
  // the window's outer position; the difference between outer and inner height
  // approximates the browser chrome above the viewport.
  // On mobile there is no movable window: the page fills the screen, `screenX/Y`
  // are 0 and the "chrome" is browser UI that the visual viewport already
  // excludes. The desktop correction below is harmless there but pointless, so
  // it is skipped to avoid double-counting a collapsing URL bar.
  const mobile = device.deviceClass === 'phone' || device.deviceClass === 'tablet';
  const chromeTop = mobile ? 0 : Math.max((window.outerHeight || 0) - (window.innerHeight || 0), 0);
  const canvasCentreScreenX = (window.screenX || 0) + rect.left + rect.width / 2;
  const canvasCentreScreenY = (window.screenY || 0) + chromeTop + rect.top + rect.height / 2;

  const screenWidthCm = sw / pxPerCm;
  const screenHeightCm = sh / pxPerCm;

  return {
    pxPerCm,
    screenWidthCm,
    screenHeightCm,
    canvasWidthCm,
    canvasHeightCm,
    canvasCentreXCm: (canvasCentreScreenX - sw / 2) / pxPerCm,
    // Screen Y grows downward, world Y grows upward.
    canvasCentreYCm: -(canvasCentreScreenY - sh / 2) / pxPerCm,
    // Front-camera position relative to the display centre, already rotated
    // into the current viewport frame. Supplied by the caller so this module
    // stays free of device sniffing.
    cameraOffset: device.cameraOffset || { x: 0, y: screenHeightCm / 2 + 1.0 },
    orientationAngle: device.orientationAngle || 0,
  };
}

/**
 * Build the asymmetric ("off-axis") frustum that makes the canvas behave like a
 * hole cut in the wall.
 *
 * A normal perspective camera assumes the viewer is on the optical axis, so the
 * frustum is symmetric. Here the window is fixed in the world (the z = 0 plane,
 * `w × h` centred on the origin) and the eye may be anywhere in front of it, so
 * the frustum must be sheared to keep the window's four corners pinned to the
 * viewport corners. That shear is the whole illusion: everything else —
 * apparent counter-rotation, sides coming into view, objects appearing to sit
 * in front of the glass — is a consequence of it.
 *
 * @param {import('three').PerspectiveCamera} camera
 * @param {{x,y,z}} eye  eye position in world cm (z must be > 0)
 * @param {number} w     window width in cm
 * @param {number} h     window height in cm
 * @param {number} near
 * @param {number} far
 */
export function applyOffAxisProjection(camera, eye, w, h, near, far) {
  const ez = Math.max(eye.z, 1e-3);
  const s = near / ez;                       // similar-triangles scale to the near plane

  const left   = (-w / 2 - eye.x) * s;
  const right  = ( w / 2 - eye.x) * s;
  const bottom = (-h / 2 - eye.y) * s;
  const top    = ( h / 2 - eye.y) * s;

  camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far, camera.coordinateSystem);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

  // The camera itself never rotates — the shear does all the work. Rotating it
  // would tilt the window plane and shear the image instead of revealing sides.
  camera.position.set(eye.x, eye.y, eye.z);
  camera.quaternion.identity();
  camera.updateMatrixWorld(true);

  // Keep the reported FOV roughly honest for anything that reads it (helpers, LOD).
  camera.fov = 2 * Math.atan((h / 2) / ez) * 180 / Math.PI;
  camera.aspect = w / h;
  camera.near = near;
  camera.far = far;
}

/** Extract intuitive yaw / pitch / roll (degrees) from MediaPipe's 4×4 head pose. */
export function headAnglesFromMatrix(THREE, data, out = {}) {
  if (!data || data.length < 16) return null;
  const m = new THREE.Matrix4().fromArray(data);          // column-major, as supplied
  const e = new THREE.Euler().setFromRotationMatrix(m, 'YXZ');
  const deg = 180 / Math.PI;
  // MediaPipe's head space is mirrored relative to the viewer's own left/right.
  out.yaw = -e.y * deg;
  out.pitch = e.x * deg;
  out.roll = -e.z * deg;
  return out;
}
