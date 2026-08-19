#!/usr/bin/env node
/**
 * Vendor every third-party dependency into `vendor/`, so the app runs with no
 * network at all.
 *
 *     node tools/vendor.mjs            # populate vendor/
 *     node tools/vendor.mjs --check    # verify vendor/ is complete, exit 1 if not
 *
 * Why a script instead of committed-and-forgotten files: the three.js addons
 * import each other by relative path, and that graph changes between releases.
 * Hand-copying "the files you think you need" produces a vendor tree that works
 * until the day it silently doesn't. This resolves the graph from the real
 * package and fails loudly if anything is missing.
 *
 * Everything lands under paths that mirror the upstream layout, so the import
 * map in index.html is a one-line change from the CDN version.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor');

/* ------------------------------------------------------------------ manifest */

/** Single source of truth for versions. Keep in sync with index.html's comment. */
export const VERSIONS = {
  three: '0.170.0',
  tasksVision: '1.0.1',
};

/** ES-module entry points whose relative import graph is followed recursively. */
const THREE_ENTRIES = [
  'examples/jsm/loaders/GLTFLoader.js',
  'examples/jsm/loaders/DRACOLoader.js',
  'examples/jsm/loaders/KTX2Loader.js',
  'examples/jsm/environments/RoomEnvironment.js',
];

/** Non-module assets: decoders and transcoders fetched at runtime, not imported. */
const THREE_ASSETS = [
  'build/three.module.js',
  // The glTF-specialised DRACO build — smaller than the general one, and the
  // only one a loader ever touches. The encoder is deliberately excluded.
  'examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js',
  'examples/jsm/libs/draco/gltf/draco_decoder.wasm',
  'examples/jsm/libs/draco/gltf/draco_decoder.js',
  'examples/jsm/libs/basis/basis_transcoder.js',
  'examples/jsm/libs/basis/basis_transcoder.wasm',
];

/**
 * MediaPipe runtime files.
 *
 * `FilesetResolver.forVisionTasks(base)` builds the filename as
 *     vision_wasm{_module?}{_nosimd?}_internal.{js,wasm}
 * and we never pass the `module` flag, so the 12 MB `_module_` pair is dead
 * weight. Both SIMD and no-SIMD are kept: no-SIMD is the fallback for iOS
 * Safari before 16.4, which is exactly the "old phone" case this app targets.
 */
const MEDIAPIPE_FILES = [
  // Renamed to .js on the way in: a few static hosts serve .mjs with a
  // non-JavaScript MIME type, and the browser then refuses the module outright.
  // The content is identical; only the extension changes.
  ['vision_bundle.mjs', 'vision_bundle.js'],
  'wasm/vision_wasm_internal.js',
  'wasm/vision_wasm_internal.wasm',
  'wasm/vision_wasm_nosimd_internal.js',
  'wasm/vision_wasm_nosimd_internal.wasm',
];

/** The face landmark model. Google serves it; there is no npm package for it. */
const MODEL = {
  url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  dest: 'models/face_landmarker.task',
  minBytes: 1_000_000,
};

/* ------------------------------------------------------------------- helpers */

const say = (...a) => console.log('  ', ...a);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function copy(from, to) {
  ensureDir(to);
  fs.copyFileSync(from, to);
  return fs.statSync(to).size;
}

/**
 * Extract relative module specifiers from an ES module.
 *
 * Only `./` and `../` specifiers are followed. Bare specifiers ('three') are
 * handled by the import map, and absolute URLs appear only inside GLTFLoader's
 * documentation comments — following those would try to vendor an example URL.
 */
function relativeImports(source) {
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) {
      if (m[1].startsWith('./') || m[1].startsWith('../')) specifiers.add(m[1]);
    }
  }
  return [...specifiers];
}

/** Copy `entry` and everything it transitively imports by relative path. */
function copyModuleGraph(pkgRoot, destRoot, entry, seen) {
  if (seen.has(entry)) return;
  seen.add(entry);

  const src = path.join(pkgRoot, entry);
  if (!fs.existsSync(src)) throw new Error(`missing in package: ${entry}`);

  copy(src, path.join(destRoot, entry));

  for (const spec of relativeImports(fs.readFileSync(src, 'utf8'))) {
    const next = path.posix.normalize(path.posix.join(path.posix.dirname(entry), spec));
    copyModuleGraph(pkgRoot, destRoot, next, seen);
  }
}

function installPackages(tmp) {
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"vendor-tmp","private":true}\n');
  const specs = [`three@${VERSIONS.three}`, `@mediapipe/tasks-vision@${VERSIONS.tasksVision}`];
  say(`npm install ${specs.join(' ')}`);
  // Windows needs a shell to run npm's .cmd shim, and modern Node refuses to
  // spawn .cmd directly. DEP0190 warns that shell:true does not escape args —
  // harmless here, since every argument is a compile-time constant from
  // VERSIONS, never user input.
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', ...specs], {
    cwd: tmp,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}

async function download(url, dest, minBytes) {
  say(`fetch ${url.split('/').slice(-1)[0]}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) throw new Error(`${url} returned only ${buf.length} bytes`);
  ensureDir(dest);
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/* ------------------------------------------------------- the expected outcome */

/**
 * Everything `vendor/` must contain for the app to run offline. Used both to
 * write the manifest and, with --check, to verify a clone is complete.
 */
export function expectedFiles() {
  return [
    'three/build/three.module.js',
    'three/examples/jsm/loaders/GLTFLoader.js',
    'three/examples/jsm/loaders/DRACOLoader.js',
    'three/examples/jsm/loaders/KTX2Loader.js',
    'three/examples/jsm/environments/RoomEnvironment.js',
    'three/examples/jsm/utils/BufferGeometryUtils.js',
    'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js',
    'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm',
    'three/examples/jsm/libs/basis/basis_transcoder.js',
    'three/examples/jsm/libs/basis/basis_transcoder.wasm',
    'mediapipe/vision_bundle.js',
    'mediapipe/wasm/vision_wasm_internal.js',
    'mediapipe/wasm/vision_wasm_internal.wasm',
    'mediapipe/wasm/vision_wasm_nosimd_internal.js',
    'mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
    'models/face_landmarker.task',
  ];
}

function check() {
  const missing = expectedFiles().filter(
    (f) => !fs.existsSync(path.join(VENDOR, f)) || fs.statSync(path.join(VENDOR, f)).size === 0,
  );
  if (missing.length) {
    console.error('\n  vendor/ is incomplete — the app will fall back to CDNs.\n');
    for (const m of missing) console.error(`    missing  vendor/${m}`);
    console.error('\n  Run:  node tools/vendor.mjs\n');
    process.exit(1);
  }
  const total = expectedFiles().reduce((n, f) => n + fs.statSync(path.join(VENDOR, f)).size, 0);
  console.log(`\n  vendor/ complete — ${expectedFiles().length} files, ${(total / 1024 / 1024).toFixed(1)} MB\n`);
}

/* ---------------------------------------------------------------------- main */

async function main() {
  if (process.argv.includes('--check')) return check();

  console.log('\n  Vendoring dependencies for offline use\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hologram-vendor-'));

  try {
    installPackages(tmp);

    const threePkg = path.join(tmp, 'node_modules', 'three');
    const mpPkg = path.join(tmp, 'node_modules', '@mediapipe', 'tasks-vision');
    const threeDest = path.join(VENDOR, 'three');

    fs.rmSync(VENDOR, { recursive: true, force: true });

    let bytes = 0;
    const seen = new Set();
    for (const entry of THREE_ENTRIES) copyModuleGraph(threePkg, threeDest, entry, seen);
    say(`three module graph: ${seen.size} files`);

    for (const asset of THREE_ASSETS) {
      bytes += copy(path.join(threePkg, asset), path.join(threeDest, asset));
    }

    for (const f of MEDIAPIPE_FILES) {
      const [from, to] = Array.isArray(f) ? f : [f, f];
      bytes += copy(path.join(mpPkg, from), path.join(VENDOR, 'mediapipe', to));
    }
    say(`mediapipe: ${MEDIAPIPE_FILES.length} files`);

    bytes += await download(MODEL.url, path.join(VENDOR, MODEL.dest), MODEL.minBytes);

    writeManifest();
    check();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeManifest() {
  const rows = expectedFiles().map((f) => {
    const abs = path.join(VENDOR, f);
    const buf = fs.readFileSync(abs);
    const sha = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    return `| \`${f}\` | ${(buf.length / 1024).toFixed(0)} KB | \`${sha}\` |`;
  });

  const doc = `# vendor/

Third-party dependencies, committed so the app runs with **no network access**.

Do not edit by hand. Regenerate with:

\`\`\`bash
node tools/vendor.mjs           # repopulate
node tools/vendor.mjs --check   # verify completeness
\`\`\`

## Provenance

| Package | Version | License |
|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | ${VERSIONS.three} | MIT |
| [@mediapipe/tasks-vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) | ${VERSIONS.tasksVision} | Apache-2.0 |
| [face_landmarker.task](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) | float16/1 | Apache-2.0 |

DRACO decoders and the Basis transcoder are redistributed from the three.js
package (Apache-2.0, Binomial LLC / Google).

## Contents

| File | Size | SHA-256 (first 16) |
|---|---|---|
${rows.join('\n')}

## Notes

- The three.js addon graph is resolved automatically; \`BufferGeometryUtils.js\`,
  \`ktx-parse.module.js\`, \`zstddec.module.js\`, \`WorkerPool.js\` and \`ColorSpaces.js\`
  are pulled in because the vendored loaders import them.
- Only the glTF-specialised DRACO **decoder** is shipped. The encoder is never
  loaded by a loader and would add ~1 MB.
- \`vision_bundle.mjs\` is stored as \`vision_bundle.js\`; some static hosts serve
  \`.mjs\` with a MIME type browsers reject for modules.
- MediaPipe's \`_module_\` wasm pair is omitted: \`forVisionTasks\` only requests it
  when explicitly asked for the module build, which this app never does. The
  \`_nosimd_\` pair is kept as the fallback for iOS Safari before 16.4.
`;

  fs.writeFileSync(path.join(VENDOR, 'README.md'), doc);
  say('wrote vendor/README.md');
}

main().catch((err) => {
  console.error(`\n  vendoring failed: ${err.message}\n`);
  process.exit(1);
});
