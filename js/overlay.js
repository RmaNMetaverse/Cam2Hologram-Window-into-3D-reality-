/**
 * Face-mesh overlay drawn on top of the small camera preview.
 *
 * Drawn manually rather than via MediaPipe's `DrawingUtils` so the palette can
 * match the rest of the UI and so the expensive tesselation stays optional —
 * it is ~2600 line segments per frame, which is real time on a 260 px canvas.
 */

const COLORS = {
  tesselation: 'rgba(120, 190, 255, 0.16)',
  oval:        'rgba(79, 209, 255, 0.85)',
  contour:     'rgba(166, 123, 255, 0.75)',
  eye:         'rgba(79, 255, 200, 0.9)',
  iris:        '#ffcc5c',
  point:       'rgba(79, 209, 255, 0.55)',
};

export class MeshOverlay {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /** Match the backing store to the CSS box and the video aspect ratio. */
  resize(videoW, videoH) {
    const cssW = this.canvas.clientWidth || 260;
    if (!videoW || !videoH) return;
    const cssH = Math.round(cssW * videoH / videoW);
    this.canvas.style.height = `${cssH}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * @param {Array<{x:number,y:number}>} lm normalised landmarks
   * @param {object|null} connectors from HeadTracker
   * @param {{drawMesh:boolean, eyeMid?:{x:number,y:number}}} opts
   */
  draw(lm, connectors, opts = {}) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!lm || !lm.length) return;

    const px = (i) => lm[i].x * W;
    const py = (i) => lm[i].y * H;

    const strokeConnections = (list, color, width) => {
      if (!list) return;
      ctx.beginPath();
      for (const c of list) {
        const a = c.start ?? c[0];
        const b = c.end ?? c[1];
        if (lm[a] === undefined || lm[b] === undefined) continue;
        ctx.moveTo(px(a), py(a));
        ctx.lineTo(px(b), py(b));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };

    if (opts.drawMesh && connectors?.tesselation) {
      strokeConnections(connectors.tesselation, COLORS.tesselation, 0.6);
    } else {
      // Cheap default: a sparse point cloud that still reads as a face mesh.
      ctx.fillStyle = COLORS.point;
      for (let i = 0; i < lm.length; i += 3) {
        ctx.fillRect(lm[i].x * W - 0.6, lm[i].y * H - 0.6, 1.4, 1.4);
      }
    }

    if (connectors) {
      strokeConnections(connectors.oval, COLORS.oval, 1.4);
      strokeConnections(connectors.lips, COLORS.contour, 1.1);
      strokeConnections(connectors.leftEye, COLORS.eye, 1.2);
      strokeConnections(connectors.rightEye, COLORS.eye, 1.2);
      strokeConnections(connectors.leftIris, COLORS.iris, 1.4);
      strokeConnections(connectors.rightIris, COLORS.iris, 1.4);
    }

    // Iris centres — the two points the whole illusion actually depends on.
    for (const i of [468, 473]) {
      if (!lm[i]) continue;
      ctx.beginPath();
      ctx.arc(px(i), py(i), 2.6, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.iris;
      ctx.fill();
    }

    // The interpupillary baseline, whose pixel length gives us depth.
    if (lm[468] && lm[473]) {
      ctx.beginPath();
      ctx.moveTo(px(468), py(468));
      ctx.lineTo(px(473), py(473));
      ctx.strokeStyle = 'rgba(255, 204, 92, 0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
