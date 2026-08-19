/**
 * The set dressing around the model: the depth box, the window frame and the
 * parallax reference props.
 *
 * These are not decoration. Head-coupled perspective only reads as depth if the
 * eye has something to compare against — a receding grid, a hard frame at the
 * screen plane and a few objects at known distances give the visual system the
 * occlusion and motion-parallax cues it needs. With a bare model on black, the
 * same maths looks like a model that is merely wobbling.
 */

import * as THREE from 'three';

/**
 * Release GPU resources for everything under `group`, then empty it.
 * The set pieces are rebuilt whenever the window is resized, so without this
 * a slow drag of the browser window would leak a texture per frame.
 */
export function disposeChildren(group) {
  group.traverse((o) => {
    if (o === group) return;
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose?.();
    }
  });
  group.clear();
}

/** Procedural grid texture — avoids shipping any image assets. */
function gridTexture(size = 512, cells = 8, line = 'rgba(120,190,255,0.5)', bg = '#0a0e18') {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  const step = size / cells;
  ctx.strokeStyle = line;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i <= cells; i++) {
    const p = Math.round(i * step) + 0.5;
    ctx.moveTo(p, 0); ctx.lineTo(p, size);
    ctx.moveTo(0, p); ctx.lineTo(size, p);
  }
  ctx.stroke();

  // A brighter sub-grid adds high-frequency detail that parallax can act on.
  ctx.strokeStyle = 'rgba(120,190,255,0.13)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= cells * 4; i++) {
    const p = Math.round(i * step / 4) + 0.5;
    ctx.moveTo(p, 0); ctx.lineTo(p, size);
    ctx.moveTo(0, p); ctx.lineTo(size, p);
  }
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * A five-sided box open towards the viewer — a diorama sitting behind the glass.
 * Rebuilt whenever the window dimensions or depth change.
 */
export class DepthBox extends THREE.Group {
  constructor() {
    super();
    this.name = 'DepthBox';
    this.texture = gridTexture();
    this._built = null;

    // The grid is emissive as well as lit. Faces that the key light never
    // reaches — the ceiling especially — would otherwise fall to pure black and
    // read as a hole in the box rather than a surface, which destroys the very
    // depth cue the box exists to provide.
    this.material = new THREE.MeshStandardMaterial({
      map: this.texture,
      emissiveMap: this.texture,
      emissive: 0x243b57,
      emissiveIntensity: 0.9,
      color: 0x8fa8c8,
      roughness: 0.92,
      metalness: 0.03,
      side: THREE.FrontSide,
    });

    // Rim light strips along the opening make the aperture read as a real edge.
    // Kept dim: it sits exactly at the viewport border, so a saturated colour
    // here reads as UI chrome rather than as part of the scene.
    this.rimMaterial = new THREE.MeshBasicMaterial({ color: 0x1d5f7a, toneMapped: false });
  }

  /**
   * @param {number} w window width, cm
   * @param {number} h window height, cm
   * @param {number} depth how far back the box extends, cm
   */
  build(w, h, depth) {
    const key = `${w.toFixed(2)}|${h.toFixed(2)}|${depth.toFixed(2)}`;
    if (this._built === key) return;
    this._built = key;

    disposeChildren(this);

    const plane = new THREE.PlaneGeometry(1, 1);
    const add = (sx, sy, pos, rot) => {
      const m = new THREE.Mesh(plane, this.material.clone());
      m.scale.set(sx, sy, 1);
      m.position.copy(pos);
      m.rotation.copy(rot);
      m.receiveShadow = true;
      // Repeat the grid at a fixed ~7 cm pitch so cell size is consistent on
      // every face regardless of that face's dimensions.
      const map = this.texture.clone();
      map.needsUpdate = true;
      map.repeat.set(sx / 7, sy / 7);
      m.material.map = map;
      m.material.emissiveMap = map;
      this.add(m);
      return m;
    };

    const E = new THREE.Euler();
    const back  = add(w, h, new THREE.Vector3(0, 0, -depth), E.clone());
    back.material.color.set(0xa9bdd8);

    add(depth, h, new THREE.Vector3(-w / 2, 0, -depth / 2), new THREE.Euler(0,  Math.PI / 2, 0)); // left
    add(depth, h, new THREE.Vector3( w / 2, 0, -depth / 2), new THREE.Euler(0, -Math.PI / 2, 0)); // right
    add(w, depth, new THREE.Vector3(0, -h / 2, -depth / 2), new THREE.Euler(-Math.PI / 2, 0, 0)); // floor
    add(w, depth, new THREE.Vector3(0,  h / 2, -depth / 2), new THREE.Euler( Math.PI / 2, 0, 0)); // ceiling

    // Glowing rim around the aperture at z = 0.
    const t = Math.max(w, h) * 0.006;
    const strip = new THREE.BoxGeometry(1, 1, 1);
    const rim = (sx, sy, x, y) => {
      const m = new THREE.Mesh(strip, this.rimMaterial.clone());
      m.scale.set(sx, sy, t);
      m.position.set(x, y, 0);
      this.add(m);
    };
    rim(w, t, 0,  h / 2);
    rim(w, t, 0, -h / 2);
    rim(t, h, -w / 2, 0);
    rim(t, h,  w / 2, 0);
  }
}

/**
 * A thick frame straddling the screen plane. Because it is geometrically at
 * z = 0 it stays rock-steady while everything behind it slides — the strongest
 * single cue that the canvas is an aperture and not a picture.
 */
export class WindowFrame extends THREE.Group {
  constructor() {
    super();
    this.name = 'WindowFrame';
    this._built = null;
    this.material = new THREE.MeshStandardMaterial({
      color: 0x1a2130,
      roughness: 0.35,
      metalness: 0.75,
    });
  }

  build(w, h) {
    const key = `${w.toFixed(2)}|${h.toFixed(2)}`;
    if (this._built === key) return;
    this._built = key;
    disposeChildren(this);

    const thickness = Math.max(w, h) * 0.022;   // visual width of the moulding
    const depth = thickness * 1.6;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = this.material.clone();

    const bar = (sx, sy, x, y) => {
      const m = new THREE.Mesh(geo, mat);
      m.scale.set(sx, sy, depth);
      m.position.set(x, y, depth / 2 - thickness * 0.2);
      m.castShadow = true;
      this.add(m);
    };

    bar(w + thickness * 2, thickness, 0,  h / 2 + thickness / 2);
    bar(w + thickness * 2, thickness, 0, -h / 2 - thickness / 2);
    bar(thickness, h, -w / 2 - thickness / 2, 0);
    bar(thickness, h,  w / 2 + thickness / 2, 0);
  }
}

/**
 * Small objects at staggered depths. Their differential motion is what makes
 * the parallax legible — the near ones sweep across the view, the far ones
 * barely move.
 */
export class ParallaxProps extends THREE.Group {
  constructor() {
    super();
    this.name = 'ParallaxProps';
    this._built = null;
    this.spinners = [];
  }

  build(w, h, depth) {
    const key = `${w.toFixed(2)}|${h.toFixed(2)}|${depth.toFixed(2)}`;
    if (this._built === key) return;
    this._built = key;

    disposeChildren(this);
    this.spinners = [];

    const palette = [0x4fd1ff, 0xa67bff, 0x45e39a, 0xffcc5c, 0xff6b9d];
    const rand = mulberry32(0x5eed);

    // Prop sizes are proportional to the aperture, not absolute. Placement
    // already scales with w/h, so without this the props stay desktop-sized and
    // swamp a phone-sized window.
    const unit = Math.min(w, h) / 30;

    const count = 9;
    for (let i = 0; i < count; i++) {
      const kind = i % 3;
      const s = (0.9 + rand() * 1.5) * unit;
      let geo;
      if (kind === 0) geo = new THREE.IcosahedronGeometry(s, 0);
      else if (kind === 1) geo = new THREE.TorusGeometry(s, s * 0.32, 12, 28);
      else geo = new THREE.BoxGeometry(s * 1.5, s * 1.5, s * 1.5);

      const mat = new THREE.MeshStandardMaterial({
        color: palette[i % palette.length],
        roughness: 0.28,
        metalness: 0.55,
        emissive: palette[i % palette.length],
        emissiveIntensity: 0.16,
      });

      const mesh = new THREE.Mesh(geo, mat);
      // Keep props clear of the centre so they never fight with the model.
      const side = i % 2 === 0 ? -1 : 1;
      mesh.position.set(
        side * (w * 0.22 + rand() * w * 0.24),
        (rand() - 0.5) * h * 0.78,
        -depth * (0.12 + rand() * 0.78),
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.spin = new THREE.Vector3(
        (rand() - 0.5) * 0.5,
        (rand() - 0.5) * 0.5,
        (rand() - 0.5) * 0.3,
      );
      mesh.userData.bob = { phase: rand() * Math.PI * 2, amp: (0.4 + rand() * 0.9) * unit, y0: mesh.position.y };
      this.add(mesh);
      this.spinners.push(mesh);
    }
  }

  update(dt, elapsed) {
    for (const m of this.spinners) {
      const s = m.userData.spin;
      m.rotation.x += s.x * dt;
      m.rotation.y += s.y * dt;
      m.rotation.z += s.z * dt;
      const b = m.userData.bob;
      m.position.y = b.y0 + Math.sin(elapsed * 0.6 + b.phase) * b.amp;
    }
  }
}

/** Deterministic PRNG so the prop layout is identical on every reload. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A last-resort stand-in if no glTF can be loaded: a deliberately asymmetric
 * object, because a symmetric one would make the counter-rotation impossible
 * to see.
 */
export function buildFallbackModel() {
  const g = new THREE.Group();
  g.name = 'FallbackModel';

  const body = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1, 0.32, 160, 28),
    new THREE.MeshStandardMaterial({ color: 0xc9d6ea, roughness: 0.22, metalness: 0.85 }),
  );
  body.castShadow = body.receiveShadow = true;
  g.add(body);

  // Red on the model's right, blue on its left, so which side you are seeing is
  // never ambiguous.
  const tab = (color, x) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 0.9, 0.9),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4, roughness: 0.4 }),
    );
    m.position.set(x, 0, 0);
    m.castShadow = true;
    g.add(m);
  };
  tab(0xff5252, -1.55);   // model's right (viewer's left when it faces you)
  tab(0x4fa8ff,  1.55);   // model's left

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.28, 0.9, 16),
    new THREE.MeshStandardMaterial({ color: 0x45e39a, emissive: 0x45e39a, emissiveIntensity: 0.35 }),
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0, 1.5);
  g.add(nose);

  return g;
}
