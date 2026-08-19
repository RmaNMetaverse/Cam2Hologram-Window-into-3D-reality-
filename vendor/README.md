# vendor/

Third-party dependencies, committed so the app runs with **no network access**.

Do not edit by hand. Regenerate with:

```bash
node tools/vendor.mjs           # repopulate
node tools/vendor.mjs --check   # verify completeness
```

## Provenance

| Package | Version | License |
|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | 0.170.0 | MIT |
| [@mediapipe/tasks-vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) | 1.0.1 | Apache-2.0 |
| [face_landmarker.task](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) | float16/1 | Apache-2.0 |

DRACO decoders and the Basis transcoder are redistributed from the three.js
package (Apache-2.0, Binomial LLC / Google).

## Contents

| File | Size | SHA-256 (first 16) |
|---|---|---|
| `three/build/three.module.js` | 1284 KB | `ce1fa418de16a194` |
| `three/examples/jsm/loaders/GLTFLoader.js` | 108 KB | `45139faddd5aaf48` |
| `three/examples/jsm/loaders/DRACOLoader.js` | 13 KB | `8a90b39b6c0d7faa` |
| `three/examples/jsm/loaders/KTX2Loader.js` | 27 KB | `fbf80e9b0237ffe2` |
| `three/examples/jsm/environments/RoomEnvironment.js` | 4 KB | `85869bdd22f7cf0b` |
| `three/examples/jsm/utils/BufferGeometryUtils.js` | 31 KB | `c25b7930e570e9ec` |
| `three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js` | 57 KB | `8bb2952d2ba7d67e` |
| `three/examples/jsm/libs/draco/gltf/draco_decoder.wasm` | 188 KB | `a680d927bed9cb86` |
| `three/examples/jsm/libs/basis/basis_transcoder.js` | 56 KB | `8478b5b6d6b74e7d` |
| `three/examples/jsm/libs/basis/basis_transcoder.wasm` | 515 KB | `6cf17dc889352c42` |
| `mediapipe/vision_bundle.js` | 152 KB | `d885630c297c0b20` |
| `mediapipe/wasm/vision_wasm_internal.js` | 316 KB | `e170ee67dd4e16c1` |
| `mediapipe/wasm/vision_wasm_internal.wasm` | 11481 KB | `8da277a733926eac` |
| `mediapipe/wasm/vision_wasm_nosimd_internal.js` | 316 KB | `e81d715a3d42cc33` |
| `mediapipe/wasm/vision_wasm_nosimd_internal.wasm` | 10703 KB | `a28483cd42e74e85` |
| `models/face_landmarker.task` | 3671 KB | `64184e229b263107` |

## Notes

- The three.js addon graph is resolved automatically; `BufferGeometryUtils.js`,
  `ktx-parse.module.js`, `zstddec.module.js`, `WorkerPool.js` and `ColorSpaces.js`
  are pulled in because the vendored loaders import them.
- Only the glTF-specialised DRACO **decoder** is shipped. The encoder is never
  loaded by a loader and would add ~1 MB.
- `vision_bundle.mjs` is stored as `vision_bundle.js`; some static hosts serve
  `.mjs` with a MIME type browsers reject for modules.
- MediaPipe's `_module_` wasm pair is omitted: `forVisionTasks` only requests it
  when explicitly asked for the module build, which this app never does. The
  `_nosimd_` pair is kept as the fallback for iOS Safari before 16.4.
