/**
 * Stage environments.
 *
 * Head-coupled perspective only reads as depth if the eye has something to
 * measure against. A model floating on black gives the visual system nothing:
 * move your head and it looks like the *model* rotated, not like you moved.
 * Every environment here exists to supply one or more depth cues —
 *
 *   • a receding surface whose texture compresses towards the horizon,
 *   • hard edges at known distances that slide past each other (parallax),
 *   • a continuous gradient that shifts as the view angle changes,
 *   • contact shadows that pin the model to a floor.
 *
 * Each preset also carries a `lighting` block. Selecting an environment applies
 * it to the live config, so the sliders move with it and stay editable — a
 * starting point, not a lock.
 */

import * as THREE from 'three';

/* -------------------------------------------------------------- shared bits */

/** Procedural grid texture — keeps the repo free of image assets. */
export function gridTexture({
  size = 512, cells = 8,
  line = 'rgba(120,190,255,0.5)',
  sub = 'rgba(120,190,255,0.13)',
  bg = '#0a0e18',
} = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  const stroke = (step, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i <= size / step; i++) {
      const p = Math.round(i * step) + 0.5;
      ctx.moveTo(p, 0); ctx.lineTo(p, size);
      ctx.moveTo(0, p); ctx.lineTo(size, p);
    }
    ctx.stroke();
  };

  stroke(size / cells / 4, sub, 1);
  stroke(size / cells, line, 1.5);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Vertical gradient texture, for backdrops that fade towards a horizon. */
function gradientTexture(stops, size = 256) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, size);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, size);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

const plane = (w, h) => new THREE.PlaneGeometry(w, h);

/**
 * How large a backdrop at `depth` must be to still fill the view when the
 * viewer's head is well off-axis.
 *
 * A backdrop merely "a bit wider than the window" looks correct head-on and
 * then tears open into a black wedge the moment you lean — which is precisely
 * the movement this whole app exists to encourage. The frustum widens with
 * distance, so coverage has to be derived from the geometry, not guessed:
 * sized for a head up to HEAD_REACH off-centre at the closest plausible
 * viewing distance.
 */
const HEAD_REACH = 35;   // cm of lateral head travel to stay covered for
const NEAR_EYE = 42;     // closest plausible eye distance, cm

export const coverWidth = (w, depth) => w + 2 * (HEAD_REACH + w / 2) * (depth / NEAR_EYE);
export const coverHeight = (h, depth) => h + 2 * (HEAD_REACH * 0.6 + h / 2) * (depth / NEAR_EYE);

/* ------------------------------------------------------------- environments */

/**
 * The original diorama: a five-sided box open towards the viewer, grid-lined so
 * every surface has high-frequency detail for parallax to act on.
 */
function buildGridRoom({ group, w, h, depth }) {
  const tex = gridTexture();
  const base = new THREE.MeshStandardMaterial({
    map: tex, emissiveMap: tex,
    // Emissive as well as lit: the ceiling never catches the key light and
    // would otherwise fall to black, reading as a hole rather than a surface.
    emissive: 0x243b57, emissiveIntensity: 0.9,
    color: 0x8fa8c8, roughness: 0.92, metalness: 0.03,
  });

  const face = (sx, sy, pos, rot, tint) => {
    const m = new THREE.Mesh(plane(1, 1), base.clone());
    m.scale.set(sx, sy, 1);
    m.position.copy(pos);
    m.rotation.copy(rot);
    m.receiveShadow = true;
    // Fixed ~7 cm grid pitch on every face, whatever that face's size.
    const map = tex.clone();
    map.needsUpdate = true;
    map.repeat.set(sx / 7, sy / 7);
    m.material.map = map;
    m.material.emissiveMap = map;
    if (tint) m.material.color.set(tint);
    group.add(m);
  };

  const E = () => new THREE.Euler();
  face(w, h, new THREE.Vector3(0, 0, -depth), E(), 0xa9bdd8);                                  // back
  face(depth, h, new THREE.Vector3(-w / 2, 0, -depth / 2), new THREE.Euler(0, Math.PI / 2, 0)); // left
  face(depth, h, new THREE.Vector3(w / 2, 0, -depth / 2), new THREE.Euler(0, -Math.PI / 2, 0)); // right
  face(w, depth, new THREE.Vector3(0, -h / 2, -depth / 2), new THREE.Euler(-Math.PI / 2, 0, 0));// floor
  face(w, depth, new THREE.Vector3(0, h / 2, -depth / 2), new THREE.Euler(Math.PI / 2, 0, 0));  // ceiling
}

/**
 * Studio cyclorama — a seamless sweep from floor into back wall.
 *
 * The photographer's trick for isolating a subject, and an unusually good depth
 * cue here: the coving has no corner line, so the only thing telling you where
 * the floor ends is the *shading gradient* across the curve. Move your head and
 * that gradient slides, which is exactly the signal stereo vision is missing.
 *
 * Built as a closed profile extruded sideways, rather than a floor plane plus a
 * wall plane, because a visible seam would defeat the entire point.
 */
function buildCyclorama({ group, w, h, depth }) {
  const D = depth;
  const t = Math.max(w, h) * 0.03;                 // shell thickness
  const r = Math.min(D * 0.6, h * 0.75);           // coving radius
  const y0 = -h / 2;
  const y1 = coverHeight(h, depth) / 2;            // wall runs well above the window

  // Profile in shape-space: x = distance back from the window, y = height.
  const s = new THREE.Shape();
  s.moveTo(0, y0);
  s.lineTo(D - r, y0);
  s.absarc(D - r, y0 + r, r, -Math.PI / 2, 0, false);   // seamless coving
  s.lineTo(D, y1);
  s.lineTo(D + t, y1);
  s.lineTo(D + t, y0 + r);
  s.absarc(D - r, y0 + r, r + t, 0, -Math.PI / 2, true);
  s.lineTo(0, y0 - t);
  s.closePath();

  const span = coverWidth(w, depth);               // wide enough that leaning does
                                                   // not reveal the sweep's edge
  const geo = new THREE.ExtrudeGeometry(s, { depth: span, bevelEnabled: false, curveSegments: 48 });
  // Extrusion runs from local z = 0 to z = span. rotateY(90°) maps local z onto
  // world +X and local x onto world -Z, so afterwards the sweep spans
  // x ∈ [0, span] and must be shifted back by half its width to centre it.
  geo.rotateY(Math.PI / 2);
  geo.translate(-span / 2, 0, 0);
  geo.computeVertexNormals();

  const cyc = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0xe8ebf0,
    roughness: 0.94,
    metalness: 0.0,
    side: THREE.DoubleSide,
  }));
  cyc.receiveShadow = true;
  group.add(cyc);
}

/**
 * A receding corridor of lit frames.
 *
 * The strongest parallax cue of the set: each frame is a hard rectangle at a
 * known distance, so moving even slightly makes the near ones sweep visibly
 * across the far ones. Depth here is unmistakable rather than merely implied.
 */
function buildCorridor({ group, w, h, depth }) {
  const count = 9;
  const bar = Math.max(w, h) * 0.012;
  const palette = [0x4fd1ff, 0x6fa8ff, 0xa67bff, 0xff6b9d];

  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    const z = -depth * (0.08 + f * 0.95);
    // Frames widen with distance so the corridor reads as parallel, not conical.
    const scale = 1 + f * 0.55;
    const fw = w * scale, fh = h * scale;

    const colour = palette[i % palette.length];
    const mat = new THREE.MeshBasicMaterial({
      color: colour,
      toneMapped: false,
      transparent: true,
      opacity: 0.35 + 0.65 * (1 - f),      // fade with distance for aerial perspective
    });

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const add = (sx, sy, x, y) => {
      const m = new THREE.Mesh(geo, mat);
      m.scale.set(sx, sy, bar);
      m.position.set(x, y, z);
      group.add(m);
    };
    add(fw, bar, 0, fh / 2);
    add(fw, bar, 0, -fh / 2);
    add(bar, fh, -fw / 2, 0);
    add(bar, fh, fw / 2, 0);
  }

  // A dark reflective floor grounds the frames and doubles the cue count.
  // Its front edge sits exactly on the window plane: anything past z = 0 would
  // render in front of the glass, poking out of the screen at the viewer.
  const floorDepth = depth * 2.4;
  const floor = new THREE.Mesh(plane(coverWidth(w, depth), floorDepth), new THREE.MeshStandardMaterial({
    color: 0x080b12, roughness: 0.28, metalness: 0.65,
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -h / 2, -floorDepth / 2);
  floor.receiveShadow = true;
  group.add(floor);
}

/**
 * Museum plinth: the model stands on a physical object of known size, in front
 * of a graded backdrop. The plinth is the cue — its top face is an ellipse that
 * visibly opens and closes as your eye rises and falls.
 */
function buildPedestal({ group, w, h, depth }) {
  const radius = Math.min(w, h) * 0.34;
  const height = h * 0.3;

  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 1.06, height, 56),
    new THREE.MeshStandardMaterial({ color: 0x11151f, roughness: 0.35, metalness: 0.5 }),
  );
  plinth.position.set(0, -h / 2 + height / 2, -depth * 0.22);
  plinth.castShadow = plinth.receiveShadow = true;
  group.add(plinth);

  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 1.02, radius * 0.02, 10, 64),
    new THREE.MeshBasicMaterial({ color: 0x4fd1ff, toneMapped: false }),
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.set(0, -h / 2 + height, -depth * 0.22);
  group.add(trim);

  const backdropTex = gradientTexture([
    [0, '#2b3447'], [0.55, '#161c27'], [1, '#080a10'],
  ]);
  const backdrop = new THREE.Mesh(
    plane(coverWidth(w, depth), coverHeight(h, depth)),
    new THREE.MeshBasicMaterial({ map: backdropTex }));
  backdrop.position.set(0, 0, -depth);
  group.add(backdrop);

  const floorDepth = depth * 2;
  const floor = new THREE.Mesh(plane(coverWidth(w, depth), floorDepth), new THREE.MeshStandardMaterial({
    color: 0x0d1017, roughness: 0.5, metalness: 0.3,
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -h / 2, -floorDepth / 2);   // front edge on the window plane
  floor.receiveShadow = true;
  group.add(floor);
}

/**
 * An infinite horizon: one large ground plane fading into a matching sky.
 * The horizon line itself is the cue — it rises and falls with your eye height,
 * which is a very legible signal even with nothing else in the scene.
 */
function buildHorizon({ group, w, h, depth }) {
  const skyTex = gradientTexture([
    [0, '#0b1220'], [0.62, '#1d2c45'], [0.78, '#41607f'], [1, '#0a0d14'],
  ]);
  // The floor runs from the window plane out to just past the sky, so the two
  // meet at the horizon and nothing protrudes towards the viewer.
  const floorDepth = depth * 13;
  const skyZ = floorDepth * 0.96;
  const sky = new THREE.Mesh(
    plane(coverWidth(w, skyZ), coverHeight(h, skyZ)),
    new THREE.MeshBasicMaterial({ map: skyTex }));
  sky.position.set(0, 0, -skyZ);
  group.add(sky);

  const tex = gridTexture({ line: 'rgba(150,200,255,0.35)', sub: 'rgba(150,200,255,0.10)', bg: '#070a11' });
  tex.repeat.set(60, 60);
  const floor = new THREE.Mesh(plane(coverWidth(w, floorDepth), floorDepth), new THREE.MeshStandardMaterial({
    map: tex, color: 0x9fb6d4, roughness: 0.75, metalness: 0.15,
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -h / 2, -floorDepth / 2);
  floor.receiveShadow = true;
  group.add(floor);
}

/** Nothing at all — the model alone, for silhouettes and AR-style framing. */
function buildVoid() { /* intentionally empty */ }

/* ------------------------------------------------------------------ registry */

/**
 * `lighting` values are applied to config when an environment is selected, so
 * the sliders follow along and remain editable.
 *   azimuth   — degrees, 0 = behind the viewer, + swings to the viewer's right
 *   elevation — degrees above the horizon
 */
export const ENVIRONMENTS = {
  grid: {
    label: 'Grid room',
    hint: 'The original diorama — a lined box behind the glass. Dense detail on every surface for parallax to bite into.',
    build: buildGridRoom,
    lighting: { azimuth: 32, elevation: 33, intensity: 2.1, color: '#fff3e0', ambient: 0.75, fill: 0.75 },
  },
  cyclorama: {
    label: 'Studio cyclorama',
    hint: 'A seamless floor-to-wall sweep. With no corner line, the shading gradient across the curve is what tells you where the floor ends — and it shifts as you move.',
    build: buildCyclorama,
    lighting: { azimuth: 24, elevation: 42, intensity: 2.6, color: '#ffffff', ambient: 1.15, fill: 1.0 },
  },
  corridor: {
    label: 'Neon corridor',
    hint: 'Lit frames at known distances. The strongest side-to-side parallax of the set — near frames sweep across far ones on the slightest movement.',
    build: buildCorridor,
    lighting: { azimuth: 18, elevation: 28, intensity: 1.5, color: '#cfe4ff', ambient: 0.5, fill: 0.6 },
  },
  pedestal: {
    label: 'Museum plinth',
    hint: 'The model on a plinth of known size. Its elliptical top opens and closes as your eye rises and falls.',
    build: buildPedestal,
    lighting: { azimuth: -28, elevation: 52, intensity: 3.0, color: '#fff6ea', ambient: 0.45, fill: 0.4 },
  },
  horizon: {
    label: 'Infinite horizon',
    hint: 'A ground plane running to a far horizon. The horizon line rises and falls with your eye height — legible even with nothing else around.',
    build: buildHorizon,
    lighting: { azimuth: 40, elevation: 18, intensity: 2.3, color: '#ffe3c4', ambient: 0.7, fill: 0.85 },
  },
  void: {
    label: 'Void',
    hint: 'Nothing but the model and the lights. Useful for silhouettes — and a reminder of how much the other presets are doing.',
    build: buildVoid,
    lighting: { azimuth: 35, elevation: 30, intensity: 2.4, color: '#ffffff', ambient: 0.5, fill: 0.6 },
  },
};

export const ENVIRONMENT_KEYS = Object.keys(ENVIRONMENTS);

/**
 * Convert azimuth/elevation into a world-space light position.
 *
 * Angles rather than raw XYZ because they are what a person actually reasons
 * about ("move the key light up and to the left"), and because they keep the
 * light at a constant distance so intensity does not change as it swings.
 */
export function lightPosition(azimuthDeg, elevationDeg, distance) {
  const az = azimuthDeg * Math.PI / 180;
  const el = elevationDeg * Math.PI / 180;
  const horizontal = Math.cos(el);
  return new THREE.Vector3(
    horizontal * Math.sin(az) * distance,
    Math.sin(el) * distance,
    horizontal * Math.cos(az) * distance,
  );
}
