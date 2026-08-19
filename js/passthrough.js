/**
 * Rear-camera passthrough for AR mode.
 *
 * ── The hard constraint ────────────────────────────────────────────────────
 * AR mode needs TWO camera streams at once: the front camera keeps tracking
 * your face (that is the whole app) while the rear camera supplies the
 * background. Whether a device allows that is not something you can feature-
 * detect up front — you have to ask for the second stream and see what happens.
 *
 *   • Most modern Android devices in Chrome: both streams coexist.
 *   • iOS Safari: opening a second camera generally STOPS the first one. The
 *     front track goes to readyState 'ended' or is silently muted, and face
 *     tracking dies without throwing anything.
 *
 * So this module acquires the rear stream and then *verifies the front stream
 * survived*, reporting `frontCameraSurvived: false` when it did not. The caller
 * decides what to tell the user; failing loudly beats a frozen model and no
 * explanation.
 */

/** Constraint sets tried in order, most specific first. */
function rearConstraints(deviceId) {
  const sets = [];

  // An explicitly enumerated back camera is the most reliable target on
  // multi-lens phones, where `facingMode` may land on an ultra-wide or macro.
  if (deviceId) {
    sets.push({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  }

  sets.push(
    { video: { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
    { video: { facingMode: 'environment' }, audio: false },
  );
  return sets;
}

/**
 * Find a rear-facing camera by enumeration.
 *
 * Labels are only populated once camera permission has been granted — which it
 * has by the time AR mode can be switched on, since face tracking is already
 * running. Returns null when nothing looks like a back camera.
 */
export async function findRearCameraId() {
  if (!navigator.mediaDevices?.enumerateDevices) return null;

  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return null;
  }

  const cameras = devices.filter((d) => d.kind === 'videoinput');
  if (cameras.length < 2) return null;   // single-camera device: nothing to switch to

  // `facingMode` in getCapabilities is the authoritative signal where supported.
  for (const cam of cameras) {
    try {
      const facing = cam.getCapabilities?.().facingMode;
      if (Array.isArray(facing) ? facing.includes('environment') : facing === 'environment') {
        return cam.deviceId;
      }
    } catch { /* getCapabilities is not universal */ }
  }

  // Fall back to the label. Deliberately avoids matching "wide"/"ultra"/"tele",
  // which on multi-lens phones are back cameras with awkward framing.
  const preferred = cameras.find((c) => /back|rear|environment/i.test(c.label) &&
                                        !/wide|ultra|tele|macro|depth/i.test(c.label));
  if (preferred) return preferred.deviceId;

  const anyBack = cameras.find((c) => /back|rear|environment/i.test(c.label));
  return anyBack?.deviceId ?? null;
}

/** True when a track is present and actually delivering frames. */
function trackIsLive(track) {
  return !!track && track.readyState === 'live' && !track.muted;
}

export class PassthroughCamera {
  /** @param {HTMLVideoElement} video the element painted behind the canvas */
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.active = false;
    /** Set false when acquiring the rear stream killed the front one. */
    this.frontCameraSurvived = true;
    this.label = '';
  }

  get width() { return this.video.videoWidth || 0; }
  get height() { return this.video.videoHeight || 0; }

  /**
   * Acquire the rear camera and start painting it.
   *
   * @param {{frontTrack?: MediaStreamTrack, onStatus?: (s: string) => void}} opts
   *   `frontTrack` is the face-tracking track; it is checked afterwards to see
   *   whether this device tolerates two simultaneous cameras.
   * @returns {Promise<{frontCameraSurvived: boolean, label: string}>}
   */
  async start({ frontTrack, onStatus } = {}) {
    if (this.active) return { frontCameraSurvived: this.frontCameraSurvived, label: this.label };

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('this browser cannot open a camera');
    }

    onStatus?.('looking for a rear camera…');
    const deviceId = await findRearCameraId();

    let lastErr;
    for (const constraints of rearConstraints(deviceId)) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!this.stream) {
      throw new Error(explainRearFailure(lastErr));
    }

    const track = this.stream.getVideoTracks()[0];
    this.label = friendlyLabel(track?.label);

    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch {
      // Autoplay can reject even when muted+playsinline; the frames still flow
      // once the element is visible, so this is not fatal.
    }

    // Give the platform a moment to tear the front camera down if it is going
    // to — the stop is not synchronous with our getUserMedia resolving.
    await new Promise((r) => setTimeout(r, 350));
    this.frontCameraSurvived = frontTrack ? trackIsLive(frontTrack) : true;

    this.active = true;
    return { frontCameraSurvived: this.frontCameraSurvived, label: this.label };
  }

  stop() {
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.active = false;
    this.frontCameraSurvived = true;
  }
}

/**
 * Turn a raw track label into something worth showing a user.
 *
 * Labels are not guaranteed to be human-readable: synthetic and virtual streams
 * often carry an opaque base64 identifier, and even real ones can be verbose
 * ("camera2 0, facing back"). Anything that does not read like a name is
 * replaced rather than dumped into the panel.
 */
export function friendlyLabel(raw) {
  const label = (raw || '').trim();
  if (!label) return 'rear camera';
  // Opaque identifier: long, unbroken, base64-ish.
  if (!/\s/.test(label) && /^[A-Za-z0-9+/=_-]{24,}$/.test(label)) return 'rear camera';
  return label.length > 36 ? `${label.slice(0, 35)}…` : label;
}

function explainRearFailure(err) {
  switch (err?.name) {
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'no rear-facing camera on this device';
    case 'NotAllowedError':
      return 'camera permission was refused';
    case 'NotReadableError':
      return 'the rear camera is busy — another app may be using it';
    default:
      return err?.message || 'could not open the rear camera';
  }
}
