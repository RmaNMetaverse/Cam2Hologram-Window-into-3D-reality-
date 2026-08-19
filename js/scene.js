/**
 * The three.js side of the illusion: renderer, lighting, model loading, and the
 * two mechanisms that make the model appear to be a physical object sitting in
 * your room rather than a picture on a screen.
 *
 *   1. OFF-AXIS PROJECTION (`geometry.js`) — the camera is placed at your real
 *      eye position and the frustum is sheared so the canvas rectangle stays
 *      pinned to the world-space window. This is exactly what a hole in the
 *      wall does, and it is what produces true motion parallax.
 *
 *   2. COUNTER-ROTATION (`_counterRotation` below) — the model is additionally
 *      rotated by the inverse of your angular displacement, so moving left
 *      swings its right side towards you. Physically this is "cheating", but on
 *      a 24" monitor at 60 cm the honest parallax alone is small, and a little
 *      exaggeration is what sells the effect.
 *
 * Both are gains, so Window mode (1 only), Turntable mode (2 only) and Hybrid
 * mode (both) are the same code path with different numbers.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { applyOffAxisProjection } from './geometry.js';
import { DepthBox, WindowFrame, ParallaxProps, buildFallbackModel, disposeChildren } from './stagecraft.js';
import { damp, clamp } from './filters.js';

// Vendored decoders. These are fetched at runtime rather than imported, so they
// are plain URLs — and anchoring them to `import.meta.url` rather than to the
// document keeps them correct no matter which page loads this module or how
// deep it sits, including under a GitHub Pages sub-path.
const VENDOR = new URL('../vendor/', import.meta.url).href;
const DRACO_PATH = `${VENDOR}three/examples/jsm/libs/draco/gltf/`;
const KTX2_PATH = `${VENDOR}three/examples/jsm/libs/basis/`;

const NEAR_CM = 1;
const FAR_CM = 4000;
const FORWARD = new THREE.Vector3(0, 0, 1);

export class HologramScene {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} cfg live config object
   */
  constructor(canvas, cfg,
              budget = { maxPixelRatio: 2, shadowMapSize: 2048, targetFps: 55 },
              restDistanceCm = 60) {
    this.canvas = canvas;
    this.cfg = cfg;
    this.budget = budget;
    this.restDistanceCm = restDistanceCm;

    // Adaptive resolution state. Phones report devicePixelRatio 3, which would
    // mean shading nine fragments per CSS pixel — the single easiest way to
    // turn a 60 fps scene into a 15 fps one.
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, budget.maxPixelRatio);
    this._perfAccum = 0;
    this._perfFrames = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // Alpha is enabled unconditionally: AR passthrough needs to clear the
      // canvas to transparent so the rear-camera video shows through, and the
      // backing store's format cannot be changed after construction.
      alpha: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = cfg.exposure;
    this.renderer.shadowMap.enabled = cfg.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.opaqueBackground = new THREE.Color(0x05070c);
    this.scene.background = this.opaqueBackground;

    // A plain PerspectiveCamera whose projectionMatrix we overwrite each frame.
    // Never call `updateProjectionMatrix()` on it — that would rebuild a
    // symmetric frustum and destroy the effect.
    this.camera = new THREE.PerspectiveCamera(50, 1, NEAR_CM, FAR_CM);
    this.camera.matrixAutoUpdate = true;
    this.scene.add(this.camera);

    /** Physical size of the window (the canvas), in cm. Set by `setWindowSize`. */
    this.windowW = 52;
    this.windowH = 30;

    /** Smoothed eye position in world cm; starts on-axis at a plausible distance. */
    this.eye = new THREE.Vector3(0, 0, restDistanceCm);
    this.rawEye = new THREE.Vector3(0, 0, restDistanceCm);

    this._buildEnvironment();
    this._buildStage();

    this.modelGroup = new THREE.Group();      // receives the counter-rotation
    this.modelGroup.name = 'ModelGroup';
    this.scene.add(this.modelGroup);

    this.modelRoot = null;                    // the loaded/normalised content
    this.mixer = null;
    this.actions = [];
    this.clock = new THREE.Clock();
    this.elapsed = 0;

    this._baseQuat = new THREE.Quaternion();
    this._targetQuat = new THREE.Quaternion();
    this._spin = 0;

    this._loader = this._makeLoader();
    this._loadToken = 0;
  }

  /* ------------------------------------------------------------------ setup */

  _buildEnvironment() {
    // A generated room environment gives PBR materials something to reflect,
    // which matters a lot for the metallic/marble look of typical glTF assets.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new RoomEnvironment();
    this.envMap = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environment = this.envMap;
    pmrem.dispose();
    envScene.traverse?.((o) => o.geometry?.dispose?.());
  }

  _buildStage() {
    this.depthBox = new DepthBox();
    this.windowFrame = new WindowFrame();
    this.props = new ParallaxProps();
    this.scene.add(this.depthBox, this.windowFrame, this.props);

    this.scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x141a26, 0.75));

    const key = new THREE.DirectionalLight(0xfff3e0, 2.1);
    key.position.set(38, 46, 60);
    key.castShadow = true;
    key.shadow.mapSize.set(this.budget.shadowMapSize, this.budget.shadowMapSize);
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.35;
    const cam = key.shadow.camera;
    cam.near = 5; cam.far = 300;
    cam.left = -70; cam.right = 70; cam.top = 70; cam.bottom = -70;
    cam.updateProjectionMatrix();
    this.scene.add(key, key.target);
    this.keyLight = key;

    const fill = new THREE.DirectionalLight(0x6fb4ff, 0.75);
    fill.position.set(-52, 10, 34);
    this.scene.add(fill);

    const rimA = new THREE.PointLight(0x4fd1ff, 320, 220, 2);
    rimA.position.set(-34, 16, -22);
    const rimB = new THREE.PointLight(0xa67bff, 260, 220, 2);
    rimB.position.set(36, -12, -30);
    this.scene.add(rimA, rimB);
  }

  _makeLoader() {
    const loader = new GLTFLoader();

    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_PATH);
    loader.setDRACOLoader(draco);

    try {
      const ktx2 = new KTX2Loader().setTranscoderPath(KTX2_PATH).detectSupport(this.renderer);
      loader.setKTX2Loader(ktx2);
    } catch { /* Basis transcoder unavailable — uncompressed textures still work */ }

    this._draco = draco;
    return loader;
  }

  /* ------------------------------------------------------------- dimensions */

  /** Tell the scene how physically large the canvas is; rebuilds the set pieces. */
  setWindowSize(widthCm, heightCm) {
    this.windowW = Math.max(widthCm, 1);
    this.windowH = Math.max(heightCm, 1);
    this._rebuildStage();
  }

  _rebuildStage() {
    const d = this.cfg.roomDepthCm;
    this.depthBox.build(this.windowW, this.windowH, d);
    this.windowFrame.build(this.windowW, this.windowH);
    this.props.build(this.windowW, this.windowH, d);
    this.applyVisibility();
  }

  /**
   * AR mode hides all set dressing, but as an OVERRIDE rather than by rewriting
   * the user's settings — switching AR off must restore exactly what they had.
   */
  applyVisibility() {
    const ar = this.cfg.arMode;
    this.depthBox.visible = !ar && this.cfg.showRoom;
    this.windowFrame.visible = !ar && this.cfg.showFrame;
    this.props.visible = !ar && this.cfg.showProps;
  }

  /**
   * Switch between the diorama and AR passthrough.
   *
   * In AR the canvas is cleared to full transparency and the scene background
   * is dropped, so the rear-camera <video> sitting behind the canvas shows
   * through. Shadows are also switched off: the only shadow receivers were the
   * depth box and the floor, both of which are now hidden, so every shadow-map
   * pass would be spent rendering a shadow nothing can catch.
   */
  setTransparent(on) {
    this.scene.background = on ? null : this.opaqueBackground;
    this.renderer.setClearColor(0x000000, on ? 0 : 1);
    this.renderer.shadowMap.enabled = this.cfg.shadows && !on;
    this.applyVisibility();
    this.scene.traverse((o) => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
  }

  /** Resize the drawing buffer to the CSS box. */
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
  }

  /**
   * Adaptive resolution.
   *
   * Head tracking is a latency-critical illusion: a low, steady frame rate
   * reads as the object lagging behind your head, which breaks it far more
   * visibly than a slightly softer image does. So when the renderer cannot hold
   * the target rate, resolution is what gives way — first, and automatically.
   *
   * Only ever scales DOWN, and stops at half density. Scaling back up on a
   * recovered average would oscillate, because the recovery was caused by the
   * scale-down itself.
   */
  _adaptResolution(dt) {
    this._perfAccum += dt;
    if (++this._perfFrames < 45) return;

    const fps = this._perfFrames / this._perfAccum;
    this._perfFrames = 0;
    this._perfAccum = 0;

    const floor = Math.min(1, this.budget.maxPixelRatio * 0.5);
    if (fps < this.budget.targetFps * 0.75 && this.pixelRatio > floor) {
      this.pixelRatio = Math.max(floor, this.pixelRatio * 0.8);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.renderer.setSize(
        this.canvas.clientWidth || window.innerWidth,
        this.canvas.clientHeight || window.innerHeight,
        false,
      );
    }
  }

  /** React to config keys that need scene-level work. */
  onConfigChange(keys) {
    const has = (...k) => k.some((x) => keys.includes(x));
    if (has('exposure')) this.renderer.toneMappingExposure = this.cfg.exposure;
    if (has('shadows', 'arMode')) {
      this.renderer.shadowMap.enabled = this.cfg.shadows && !this.cfg.arMode;
      this.scene.traverse((o) => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
    }
    if (has('arMode')) this.setTransparent(this.cfg.arMode);
    if (has('roomDepthCm')) this._rebuildStage();
    if (has('showRoom', 'showFrame', 'showProps')) this.applyVisibility();
    if (has('modelSizeCm', 'modelDepthCm', 'modelHeightCm')) this._placeModel();
    if (has('modelBaseYawDeg')) this._updateBaseQuat();
    if (has('playAnimations') && this.mixer) {
      for (const a of this.actions || []) this.cfg.playAnimations ? a.play() : a.stop();
    }
  }

  /* ------------------------------------------------------------ model loading */

  /**
   * @param {string} url
   * @param {{label?:string, onProgress?:(f:number)=>void}} opts
   */
  async loadModel(url, { label, onProgress } = {}) {
    const token = ++this._loadToken;

    const gltf = await new Promise((resolve, reject) => {
      this._loader.load(
        url,
        resolve,
        (e) => { if (e.lengthComputable && e.total) onProgress?.(e.loaded / e.total); },
        (err) => reject(new Error(err?.message || `failed to load ${label || url}`)),
      );
    });

    if (token !== this._loadToken) return null;   // superseded by a newer load

    this._setModelRoot(gltf.scene || gltf.scenes?.[0], gltf.animations);
    return { label: label || url, animations: gltf.animations?.length || 0 };
  }

  /** Swap in the built-in procedural stand-in. */
  useFallbackModel() {
    this._loadToken++;
    this._setModelRoot(buildFallbackModel(), []);
  }

  _setModelRoot(root, animations) {
    if (!root) throw new Error('the file contained no scene');

    if (this.modelRoot) {
      disposeChildren(this.modelGroup);
      this.modelRoot = null;
    }
    this.mixer?.stopAllAction();
    this.mixer = null;

    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && 'envMapIntensity' in m) m.envMapIntensity = 1.0;
      }
    });

    this.modelGroup.add(root);
    this.modelRoot = root;

    this.actions = [];
    if (animations?.length) {
      this.mixer = new THREE.AnimationMixer(root);
      this.actions = animations.map((clip) => {
        const a = this.mixer.clipAction(clip);
        if (this.cfg.playAnimations) a.play();
        return a;
      });
    }

    this._placeModel();
    this._updateBaseQuat();
  }

  /**
   * Normalise whatever the file happened to contain: recentre it on its own
   * bounding box, scale the longest axis to the requested size, and park it at
   * the requested depth. Author units in glTF are metres by convention but in
   * practice range over six orders of magnitude, so this is not optional.
   */
  _placeModel() {
    const root = this.modelRoot;
    if (!root) return;

    root.position.set(0, 0, 0);
    root.scale.set(1, 1, 1);
    root.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z) || 1;

    const scale = this.cfg.modelSizeCm / longest;
    root.scale.setScalar(scale);
    root.position.copy(centre).multiplyScalar(-scale);

    this.modelGroup.position.set(0, this.cfg.modelHeightCm, this.cfg.modelDepthCm);
    this.modelBoundingRadius = 0.5 * size.length() * scale;
  }

  _updateBaseQuat() {
    this._baseQuat.setFromEuler(new THREE.Euler(0, this.cfg.modelBaseYawDeg * Math.PI / 180, 0));
  }

  /* ------------------------------------------------------------- the illusion */

  /**
   * Rotation that brings the surface currently facing the viewer's *actual*
   * direction round to face +Z, scaled by `gain`.
   *
   * Derivation: the eye sits along unit vector `e`. The rotation q with
   * q·e = +Z is exactly the inverse of the viewer's angular displacement, so
   * applying q to the model reproduces — with a fixed camera — the view you
   * would get by walking round a stationary object. Scaling the axis-angle by
   * `gain` exaggerates or attenuates that, with gain = 1 being truthful.
   *
   * @param {THREE.Vector3} eye eye position relative to the model
   * @param {number} gain
   * @param {number} verticalGain scales only the pitch contribution
   * @param {THREE.Quaternion} out
   */
  _counterRotation(eye, gain, verticalGain, out) {
    out.identity();
    if (gain === 0) return out;

    // Attenuate the vertical component before normalising, so `verticalGain`
    // controls how much up/down motion contributes without touching yaw.
    const dir = _v1.set(eye.x, eye.y * verticalGain, Math.max(eye.z, 1e-3));
    if (dir.lengthSq() < 1e-9) return out;
    dir.normalize();

    _q1.setFromUnitVectors(dir, FORWARD);

    // Scale the rotation by re-deriving its axis and angle.
    const w = clamp(_q1.w, -1, 1);
    const sinHalf = Math.sqrt(Math.max(1 - w * w, 0));
    if (sinHalf < 1e-6) return out;                     // essentially no rotation
    const angle = 2 * Math.acos(w);
    _v2.set(_q1.x / sinHalf, _q1.y / sinHalf, _q1.z / sinHalf);
    out.setFromAxisAngle(_v2, angle * gain);
    return out;
  }

  /**
   * Feed a new (already smoothed) eye position, in canvas-centred world cm.
   * @param {{x:number,y:number,z:number}} eye
   */
  setEye(eye) {
    this.rawEye.set(eye.x, eye.y, eye.z);
  }

  /** Advance and draw one frame. */
  render() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;
    const cfg = this.cfg;

    // A short extra damping pass on top of the 1€ filter. The filter kills
    // sensor jitter; this kills the residual stair-stepping from the webcam
    // running at half the render rate.
    const tau = 0.035;
    this.eye.x = damp(this.eye.x, this.rawEye.x, tau, dt);
    this.eye.y = damp(this.eye.y, this.rawEye.y, tau, dt);
    this.eye.z = damp(this.eye.z, this.rawEye.z, tau, dt);

    // --- 1. off-axis projection -------------------------------------------
    const pg = cfg.parallaxGain;
    const vg = cfg.verticalGain;
    _eyeProj.set(
      this.eye.x * pg,
      this.eye.y * pg * vg,
      // Depth is never scaled to zero: the frustum divides by it. The blend is
      // anchored at the device's typical viewing distance, so gain 1 is exactly
      // the true eye depth and gain 0 holds a fixed, sensible distance.
      Math.max(
        this.restDistanceCm + (this.eye.z - this.restDistanceCm) * Math.max(pg, 0.15),
        12,
      ),
    );
    applyOffAxisProjection(this.camera, _eyeProj, this.windowW, this.windowH, NEAR_CM, FAR_CM);

    // --- 2. counter-rotation ----------------------------------------------
    const sign = cfg.invert ? -1 : 1;
    _rel.copy(this.eye).sub(this.modelGroup.position);
    this._counterRotation(_rel, cfg.rotationGain * sign, vg, this._targetQuat);

    if (cfg.autoSpin) this._spin += dt * 0.35;
    _q2.setFromEuler(_e1.set(0, this._spin, 0));

    // World-space counter-rotation first, then the model's own base orientation.
    this.modelGroup.quaternion.copy(this._baseQuat).multiply(_q2).premultiply(this._targetQuat);

    // --- 3. everything else -----------------------------------------------
    if (this.mixer && cfg.playAnimations) this.mixer.update(dt);
    if (this.props.visible) this.props.update(dt, this.elapsed);

    // Keep the key light roughly over the viewer's shoulder so shading responds
    // to head motion too — a subtle but effective extra depth cue.
    this.keyLight.position.set(
      this.eye.x * 0.6 + 30,
      this.eye.y * 0.6 + 45,
      Math.max(this.eye.z, 30),
    );

    this.renderer.render(this.scene, this.camera);
    this._adaptResolution(dt);
    return dt;
  }

  dispose() {
    disposeChildren(this.modelGroup);
    disposeChildren(this.depthBox);
    disposeChildren(this.windowFrame);
    disposeChildren(this.props);
    this._draco?.dispose?.();
    this.envMap?.dispose?.();
    this.renderer.dispose();
  }
}

/* Scratch objects — reused every frame so the render loop allocates nothing. */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _eyeProj = new THREE.Vector3();
const _rel = new THREE.Vector3();
