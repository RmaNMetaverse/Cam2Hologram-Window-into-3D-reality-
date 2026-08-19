/**
 * Webcam capture + MediaPipe FaceLandmarker.
 *
 * Loading strategy: `@mediapipe/tasks-vision` is pulled as an ES module from a
 * CDN, with a fallback chain because a single pinned host/version is a single
 * point of failure for an app that is otherwise entirely local.
 */

const BUNDLE_SOURCES = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1',
  'https://unpkg.com/@mediapipe/tasks-vision@1.0.1',
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35',
  'https://unpkg.com/@mediapipe/tasks-vision@0.10.35',
];

const MODEL_SOURCES = [
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
];

/** Loaded lazily so the splash screen can render instantly. */
let visionModule = null;
let wasmBase = '';

async function loadVisionBundle(onStatus) {
  if (visionModule) return visionModule;
  let lastErr;
  for (const base of BUNDLE_SOURCES) {
    try {
      onStatus?.(`loading vision runtime… (${new URL(base).host})`);
      const mod = await import(/* @vite-ignore */ `${base}/vision_bundle.mjs`);
      if (!mod?.FaceLandmarker) throw new Error('bundle missing FaceLandmarker');
      visionModule = mod;
      wasmBase = `${base}/wasm`;
      return mod;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`could not load MediaPipe tasks-vision (${lastErr?.message || lastErr})`);
}

export class HeadTracker {
  /**
   * @param {HTMLVideoElement} video
   */
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.stream = null;

    this.running = false;
    this.frozen = false;

    /** Latest detection. */
    this.landmarks = null;
    this.matrixData = null;
    this.blendshapes = null;
    this.hasFace = false;
    this.lastFaceTime = 0;

    this.lastVideoTime = -1;
    this.trackFps = 0;
    this._fpsAccum = 0;
    this._fpsCount = 0;
    this._lastDetect = 0;

    /** Populated with `FACE_LANDMARKS_*` connector lists once the bundle loads. */
    this.connectors = null;
  }

  get videoWidth() { return this.video.videoWidth || 0; }
  get videoHeight() { return this.video.videoHeight || 0; }

  /**
   * Request the webcam and build the landmarker.
   * @param {{useGpu?:boolean, onStatus?:(s:string)=>void}} opts
   */
  async start({ useGpu = true, onStatus } = {}) {
    onStatus?.('requesting camera…');

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('getUserMedia is unavailable — serve the page over http://localhost or https://');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width:  { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
        facingMode: 'user',
      },
    });

    this.video.srcObject = this.stream;
    await this.video.play();
    await this._waitForMetadata();

    const vision = await loadVisionBundle(onStatus);
    const { FaceLandmarker, FilesetResolver } = vision;

    onStatus?.('loading wasm…');
    const fileset = await FilesetResolver.forVisionTasks(wasmBase);

    let lastErr;
    for (const modelAssetPath of MODEL_SOURCES) {
      try {
        onStatus?.('loading face landmark model…');
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath,
            delegate: useGpu ? 'GPU' : 'CPU',
          },
          runningMode: 'VIDEO',
          numFaces: 1,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputFaceBlendshapes: false,
          // The 4×4 head pose — used for the HUD readout and roll compensation.
          outputFacialTransformationMatrixes: true,
        });
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!this.landmarker) {
      throw new Error(`could not create FaceLandmarker (${lastErr?.message || lastErr})`);
    }

    this.connectors = {
      tesselation: FaceLandmarker.FACE_LANDMARKS_TESSELATION,
      contours:    FaceLandmarker.FACE_LANDMARKS_CONTOURS,
      leftEye:     FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
      rightEye:    FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
      leftIris:    FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS,
      rightIris:   FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS,
      lips:        FaceLandmarker.FACE_LANDMARKS_LIPS,
      oval:        FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
    };

    this.running = true;
    onStatus?.('tracking');
    return this;
  }

  _waitForMetadata() {
    if (this.video.readyState >= 2 && this.video.videoWidth) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('the camera stream failed to start')); };
      const cleanup = () => {
        this.video.removeEventListener('loadeddata', done);
        this.video.removeEventListener('error', fail);
        clearTimeout(timer);
      };
      const timer = setTimeout(fail, 10000);
      this.video.addEventListener('loadeddata', done, { once: true });
      this.video.addEventListener('error', fail, { once: true });
    });
  }

  /**
   * Run inference if a new camera frame is available. Cheap to call every rAF:
   * webcams typically deliver 30 fps while we render at 60+, and re-running the
   * network on an unchanged frame would waste half the GPU budget for nothing.
   *
   * @param {number} nowMs monotonic timestamp
   * @returns {boolean} true when a fresh detection was produced
   */
  poll(nowMs) {
    if (!this.running || !this.landmarker || this.frozen) return false;
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return false;
    if (v.currentTime === this.lastVideoTime) return false;
    this.lastVideoTime = v.currentTime;

    let res;
    try {
      res = this.landmarker.detectForVideo(v, nowMs);
    } catch {
      return false;   // transient GPU hiccups shouldn't kill the render loop
    }

    const faces = res?.faceLandmarks;
    if (faces && faces.length) {
      this.landmarks = faces[0];
      this.matrixData = res.facialTransformationMatrixes?.[0]?.data || null;
      this.hasFace = true;
      this.lastFaceTime = nowMs;
    } else {
      this.hasFace = false;
    }

    // Smoothed inference rate for the HUD.
    if (this._lastDetect) {
      this._fpsAccum += nowMs - this._lastDetect;
      if (++this._fpsCount >= 10) {
        this.trackFps = 1000 / (this._fpsAccum / this._fpsCount);
        this._fpsAccum = 0;
        this._fpsCount = 0;
      }
    }
    this._lastDetect = nowMs;
    return true;
  }

  toggleFreeze() {
    this.frozen = !this.frozen;
    return this.frozen;
  }

  stop() {
    this.running = false;
    try { this.landmarker?.close(); } catch { /* already gone */ }
    this.landmarker = null;
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }
}
