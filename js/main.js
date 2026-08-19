/**
 * HeadTracking Hologram3D — application entry point.
 *
 * Per frame:
 *   webcam frame → MediaPipe face mesh → iris midpoint → eye position in cm
 *   → 1€ filter → off-axis frustum + model counter-rotation → render
 */

import * as THREE from 'three';

import { config, set, onChange, DEFAULTS } from './config.js';
import { Vec3Filter, damp } from './filters.js';
import { HeadTracker } from './tracker.js';
import { MeshOverlay } from './overlay.js';
import { HologramScene } from './scene.js';
import { UI } from './ui.js';
import {
  eyeFromLandmarks,
  eyeToCanvasSpace,
  measureLayout,
  headAnglesFromMatrix,
} from './geometry.js';
import {
  detectDeviceClass,
  orientationAngle,
  cameraOffsetForOrientation,
  defaultsForClass,
  bezelForClass,
  renderBudgetForClass,
  restDistanceForClass,
  supportsFullscreen,
  isTouchDevice,
} from './device.js';

const $ = (id) => document.getElementById(id);

/**
 * Where the eye drifts back to when tracking is lost — a neutral pose. The
 * distance is device-dependent: a phone is held at arm's length, a monitor sits
 * much further away, and starting at the wrong one makes the first second after
 * a lost face lurch.
 */
const restEye = (deviceClass) => ({ x: 0, y: 0, z: restDistanceForClass(deviceClass) });

class App {
  constructor() {
    this.canvas = $('stage');
    this.video = $('video');

    // Profile the device before anything reads config: the physical defaults
    // for a phone and a desktop have nothing in common.
    this.deviceClass = detectDeviceClass();
    this.budget = renderBudgetForClass(this.deviceClass);
    this.restEye = restEye(this.deviceClass);
    this.applyDeviceDefaults();

    this.scene = new HologramScene(this.canvas, config, this.budget,
                                   restDistanceForClass(this.deviceClass));
    this.tracker = new HeadTracker(this.video);
    this.overlay = new MeshOverlay($('overlay'));
    this.filter = new Vec3Filter(config.minCutoff, config.beta);

    this.eye = { ...this.restEye };
    this.angles = { yaw: 0, pitch: 0, roll: 0 };
    this.smoothAngles = { yaw: 0, pitch: 0, roll: 0 };
    this.layout = null;

    this.lastFrame = 0;
    this.renderFps = 0;
    this._fpsAccum = 0;
    this._fpsCount = 0;
    this.hudTimer = 0;

    this.ui = new UI({
      onLoadFile: (f) => this.loadFile(f),
      onLoadDefault: () => this.loadDefaultModel(),
      onRecenter: () => this.recenter(),
      onClearRecenter: () => this.clearRecenter(),
      onFullscreen: () => this.toggleFullscreen(),
      getAutoCameraOffset: () => this.layout?.cameraOffset,
      onFreeze: () => {
        const frozen = this.tracker.toggleFreeze();
        this.ui.toast(frozen ? 'Tracking frozen' : 'Tracking resumed');
      },
    });

    onChange((keys) => this.onConfigChange(keys));

    this.onResize = this.onResize.bind(this);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    // Rotating a phone physically moves the front camera from above the display
    // to beside it, so the whole offset chain has to be rebuilt.
    screen.orientation?.addEventListener?.('change', this.onResize);
    // iOS Safari resizes the visual viewport as the URL bar collapses without
    // ever firing `resize` on the window.
    window.visualViewport?.addEventListener?.('resize', this.onResize);
    // A moved window changes where the "hole in the wall" physically is.
    setInterval(() => this.measure(), 1000);

    this.onResize();
  }

  /**
   * Seed physical and quality settings from the device class — but only when
   * this device has not been seen before. A returning user's own calibration
   * always wins; re-deriving it on every load would silently undo their work.
   */
  applyDeviceDefaults() {
    if (config.deviceClass === this.deviceClass) return;
    set({ deviceClass: this.deviceClass, ...defaultsForClass(this.deviceClass) });
  }

  /* --------------------------------------------------------------- startup */

  async start(status) {
    status('starting camera…');
    await this.tracker.start({
      useGpu: config.useGpu,
      onStatus: status,
    });

    this.overlay.resize(this.tracker.videoWidth, this.tracker.videoHeight);
    $('preview-label').textContent = `${this.tracker.videoWidth}×${this.tracker.videoHeight}`;

    status('loading model…');
    await this.loadInitialModel();

    this.measure();
    this.ui.revealChrome();
    $('hud').classList.toggle('hidden', !config.showHud);

    this.lastFrame = performance.now();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  async loadInitialModel() {
    // A stored blob: URL from a previous session is dead; fall back cleanly.
    const url = String(config.modelUrl).startsWith('blob:') ? DEFAULTS.modelUrl : config.modelUrl;
    try {
      await this.scene.loadModel(url, {
        label: config.modelLabel,
        onProgress: (f) => this.ui.setProgress(f),
      });
      this.ui.setProgress(null);
      this.ui.setModelName(config.modelLabel);
    } catch (err) {
      console.warn('[Hologram3D] falling back to the built-in model:', err);
      this.scene.useFallbackModel();
      this.ui.setProgress(null);
      this.ui.setModelName('Built-in test object');
    }
  }

  /* ---------------------------------------------------------------- layout */

  onResize() {
    this.scene.resize();
    this.overlay.resize(this.tracker.videoWidth, this.tracker.videoHeight);
    this.measure();
  }

  /**
   * Re-derive the physical geometry of the drawing surface. Doing this on a
   * timer as well as on resize catches window drags between monitors and OS
   * scale changes, both of which silently invalidate the calibration.
   */
  measure() {
    const angle = orientationAngle();
    const pxPerCm = Math.hypot(screen.width, screen.height) /
                    Math.max(config.screenDiagonalInches * 2.54, 1);

    const device = {
      deviceClass: this.deviceClass,
      orientationAngle: angle,
      cameraOffset: cameraOffsetForOrientation(
        screen.width / pxPerCm,
        screen.height / pxPerCm,
        bezelForClass(this.deviceClass),
        angle,
      ),
    };

    const layout = measureLayout(this.canvas, config, device);
    this.layout = layout;
    this.scene.setWindowSize(layout.canvasWidthCm, layout.canvasHeightCm);

    const cam = layout.cameraOffset;
    this.ui.setScreenReadout(
      `canvas ${layout.canvasWidthCm.toFixed(1)} × ${layout.canvasHeightCm.toFixed(1)} cm` +
      `  ·  display ${layout.screenWidthCm.toFixed(0)} × ${layout.screenHeightCm.toFixed(0)} cm\n` +
      `camera at (${cam.x.toFixed(1)}, ${cam.y.toFixed(1)}) cm` +
      (angle ? `  ·  rotated ${angle}°` : '')
    );
  }

  /* ----------------------------------------------------------------- model */

  async loadFile(file) {
    const name = file.name || 'model';
    if (!/\.(glb|gltf)$/i.test(name)) {
      this.ui.toast('Only .glb and .gltf files are supported');
      return;
    }
    // A .gltf referencing external .bin/textures cannot resolve them from a
    // blob URL — only self-contained .glb (or embedded .gltf) will work here.
    if (/\.gltf$/i.test(name)) {
      this.ui.toast('Loading .gltf — external .bin/textures may not resolve', 3200);
    }

    const url = URL.createObjectURL(file);
    this.ui.setProgress(0);
    try {
      const res = await this.scene.loadModel(url, {
        label: name,
        onProgress: (f) => this.ui.setProgress(f),
      });
      set({ modelUrl: url, modelLabel: name });
      this.ui.setModelName(name);
      this.ui.toast(res?.animations ? `${name} — ${res.animations} animation(s)` : name);
    } catch (err) {
      console.error(err);
      this.ui.toast(`Could not load ${name}`, 3000);
      URL.revokeObjectURL(url);
    } finally {
      this.ui.setProgress(null);
    }
  }

  async loadDefaultModel() {
    this.ui.setProgress(0);
    try {
      await this.scene.loadModel(DEFAULTS.modelUrl, {
        label: DEFAULTS.modelLabel,
        onProgress: (f) => this.ui.setProgress(f),
      });
      set({ modelUrl: DEFAULTS.modelUrl, modelLabel: DEFAULTS.modelLabel });
      this.ui.setModelName(DEFAULTS.modelLabel);
    } catch {
      this.scene.useFallbackModel();
      this.ui.setModelName('Built-in test object');
      this.ui.toast('Default model unavailable — using the built-in object', 3000);
    } finally {
      this.ui.setProgress(null);
    }
  }

  /* ----------------------------------------------------------- calibration */

  recenter() {
    if (!this.tracker.hasFace) {
      this.ui.toast('No face detected — cannot recentre');
      return;
    }
    // Fold the current lateral offset into the calibration so "where you are
    // sitting now" becomes the on-axis position.
    set({
      recenterX: config.recenterX + this.eye.x,
      recenterY: config.recenterY + this.eye.y,
    });
    this.ui.toast('Recentred on your current position');
  }

  clearRecenter() {
    set({ recenterX: 0, recenterY: 0 });
    this.ui.toast('Calibration offset cleared');
  }

  toggleFullscreen() {
    if (!supportsFullscreen()) {
      this.ui.toast('This browser has no fullscreen API — add the page to your home screen', 4200);
      return;
    }
    const el = document.documentElement;
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    if (active) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      return;
    }
    const request = el.requestFullscreen || el.webkitRequestFullscreen;
    Promise.resolve(request?.call(el)).catch(() => {});
    // Landscape is the right shape for a window into a room, and locking it
    // also stops the illusion breaking every time the phone is tilted.
    screen.orientation?.lock?.('landscape').catch(() => {});
  }

  onConfigChange(keys) {
    this.scene.onConfigChange(keys);
    // "Reset settings" clears the device profile too; re-seed it so a phone
    // does not end up holding a 24-inch diagonal.
    if (keys.includes('deviceClass') && config.deviceClass === null) {
      this.applyDeviceDefaults();
    }
    if (keys.includes('minCutoff') || keys.includes('beta')) {
      this.filter.setParams(config.minCutoff, config.beta);
    }
    if (keys.includes('screenDiagonalInches') || keys.includes('camOffsetAuto')) this.measure();
    if (keys.includes('useGpu')) this.ui.toast('Reload the page to switch inference backend', 2600);
  }

  /* ------------------------------------------------------------------ loop */

  loop(now) {
    requestAnimationFrame(this.loop);

    const dt = Math.min((now - this.lastFrame) / 1000, 0.1) || 1 / 60;
    this.lastFrame = now;

    // 1. New camera frame? Run the face mesh.
    if (this.tracker.poll(now)) this.updateEyeFromTracking(dt);

    // 2. Tracking lost for a moment — ease back to the neutral pose rather than
    //    snapping, which would look like a glitch rather than a lost face.
    if (!this.tracker.hasFace && !this.tracker.frozen) {
      const stale = (now - this.tracker.lastFaceTime) > 400;
      if (stale) {
        this.eye.x = damp(this.eye.x, this.restEye.x, 0.5, dt);
        this.eye.y = damp(this.eye.y, this.restEye.y, 0.5, dt);
        this.eye.z = damp(this.eye.z, this.restEye.z, 0.5, dt);
        this.filter.reset();
      }
    }

    // 3. Draw.
    this.scene.setEye(this.eye);
    this.scene.render();

    // 4. Chrome.
    this.drawOverlay();
    this.updateHud(now, dt);
  }

  updateEyeFromTracking(dt) {
    const lm = this.tracker.landmarks;
    if (!this.tracker.hasFace || !lm || !this.layout) return;

    const raw = eyeFromLandmarks(lm, this.tracker.videoWidth, this.tracker.videoHeight, config);
    if (!raw) return;

    const world = eyeToCanvasSpace(raw, this.layout, config);
    const smoothed = this.filter.filter(world, dt);

    this.eye.x = smoothed.x;
    this.eye.y = smoothed.y;
    this.eye.z = smoothed.z;

    if (this.tracker.matrixData) {
      headAnglesFromMatrix(THREE, this.tracker.matrixData, this.angles);
    }
  }

  drawOverlay() {
    const box = $('preview');
    if (!config.showPreview || box.classList.contains('collapsed')) return;
    if (this.tracker.hasFace && this.tracker.landmarks) {
      this.overlay.draw(this.tracker.landmarks, this.tracker.connectors, {
        drawMesh: config.drawMesh,
      });
    } else {
      this.overlay.clear();
    }
  }

  updateHud(now, dt) {
    // Smooth the render rate over ~15 frames so the number is readable.
    this._fpsAccum += dt;
    if (++this._fpsCount >= 15) {
      this.renderFps = this._fpsCount / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsCount = 0;
    }

    if (!config.showHud || now - this.hudTimer < 120) return;
    this.hudTimer = now;

    const tau = 0.15;
    for (const k of ['yaw', 'pitch', 'roll']) {
      this.smoothAngles[k] = damp(this.smoothAngles[k], this.angles[k], tau, 0.12);
    }

    $('hud-fps').textContent = this.renderFps.toFixed(0);
    $('hud-tfps').textContent = this.tracker.trackFps.toFixed(0);

    const state = $('hud-state');
    if (this.tracker.frozen) {
      state.textContent = 'frozen';
      state.className = 'warn';
    } else if (this.tracker.hasFace) {
      state.textContent = 'locked';
      state.className = 'good';
    } else {
      state.textContent = 'no face';
      state.className = 'bad';
    }

    $('hud-x').textContent = this.eye.x.toFixed(1);
    $('hud-y').textContent = this.eye.y.toFixed(1);
    $('hud-z').textContent = this.eye.z.toFixed(1);
    $('hud-yaw').textContent = this.smoothAngles.yaw.toFixed(0);
    $('hud-pitch').textContent = this.smoothAngles.pitch.toFixed(0);
    $('hud-roll').textContent = this.smoothAngles.roll.toFixed(0);
  }
}

/* ------------------------------------------------------------------ bootstrap */

const splash = $('splash');
const statusEl = $('splash-status');
const startBtn = $('btn-start');

const setStatus = (msg, kind = '') => {
  statusEl.textContent = msg;
  statusEl.className = `splash-status ${kind}`;
};

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    const app = new App();
    window.hologram = app;               // handy for tinkering from the console
    await app.start(setStatus);

    setStatus('tracking', 'ok');
    splash.classList.add('leaving');
    setTimeout(() => splash.classList.add('hidden'), 500);
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    startBtn.textContent = 'Try again';
    setStatus(explain(err), 'err');
  }
});

function explain(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError') return 'Camera permission denied — allow it in the address bar, then retry.';
  if (name === 'NotFoundError')   return 'No camera found. Connect a webcam and retry.';
  if (name === 'NotReadableError') return 'The camera is in use by another application.';
  return err?.message || String(err);
}

// A file:// page cannot use getUserMedia or ES modules from disk — say so up front.
if (location.protocol === 'file:') {
  setStatus('Open this page over http://localhost — run start.bat or `python serve.py`.', 'err');
  startBtn.disabled = true;
}
