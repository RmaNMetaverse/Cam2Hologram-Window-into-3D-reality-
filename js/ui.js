/**
 * Control panel wiring.
 *
 * Every widget is declared once in `BINDINGS` and bound generically, so adding a
 * setting means adding one row here plus one row in `config.js` — the two-way
 * sync, formatting and persistence come for free.
 */

import { config, set, onChange, reset, applyMode, MODE_HINTS } from './config.js';
import { isTouchDevice, supportsFullscreen } from './device.js';

const $ = (id) => document.getElementById(id);

/**
 * [ element id, config key, kind, value-label id, formatter ]
 * kind: 'range' → number, 'check' → boolean
 */
const BINDINGS = [
  ['s-parallax',  'parallaxGain',         'range', 'v-parallax',  (v) => v.toFixed(2)],
  ['s-rotation',  'rotationGain',         'range', 'v-rotation',  (v) => v.toFixed(2)],
  ['s-vertical',  'verticalGain',         'range', 'v-vertical',  (v) => v.toFixed(2)],
  ['c-invert',    'invert',               'check'],

  ['s-size',      'modelSizeCm',          'range', 'v-size',      (v) => v.toFixed(0)],
  ['s-depth',     'modelDepthCm',         'range', 'v-depth',     (v) => v.toFixed(0)],
  ['s-height',    'modelHeightCm',        'range', 'v-height',    (v) => v.toFixed(0)],
  ['s-baseyaw',   'modelBaseYawDeg',      'range', 'v-baseyaw',   (v) => v.toFixed(0)],
  ['c-spin',      'autoSpin',             'check'],
  ['c-anim',      'playAnimations',       'check'],

  ['c-ar',        'arMode',               'check'],
  ['c-room',      'showRoom',             'check'],
  ['c-frame',     'showFrame',            'check'],
  ['c-props',     'showProps',            'check'],
  ['c-shadow',    'shadows',              'check'],
  ['s-roomdepth', 'roomDepthCm',          'range', 'v-roomdepth', (v) => v.toFixed(0)],
  ['s-exposure',  'exposure',             'range', 'v-exposure',  (v) => v.toFixed(2)],

  ['s-diag',      'screenDiagonalInches', 'range', 'v-diag',      (v) => v.toFixed(1)],
  ['c-camy-auto', 'camOffsetAuto',        'check'],
  ['s-camy',      'camOffsetYCm',         'range', 'v-camy',      (v) => v.toFixed(1)],
  ['s-camx',      'camOffsetXCm',         'range', 'v-camx',      (v) => v.toFixed(1)],
  ['s-fov',       'camFovDeg',            'range', 'v-fov',       (v) => v.toFixed(0)],
  ['s-ipd',       'ipdCm',                'range', 'v-ipd',       (v) => v.toFixed(2)],

  ['s-mincut',    'minCutoff',            'range', 'v-mincut',    (v) => v.toFixed(2)],
  ['s-beta',      'beta',                 'range', 'v-beta',      (v) => v.toFixed(3)],
  ['c-mesh',      'drawMesh',             'check'],
  ['c-preview',   'showPreview',          'check'],
  ['c-hud',       'showHud',              'check'],
  ['c-gpu',       'useGpu',               'check'],
];

export class UI {
  /**
   * @param {{
   *   onLoadFile:(file:File)=>void,
   *   onLoadDefault:()=>void,
   *   onRecenter:()=>void,
   *   onClearRecenter:()=>void,
   *   onFullscreen:()=>void,
   *   onFreeze:()=>void,
   * }} handlers
   */
  constructor(handlers) {
    this.h = handlers;
    this.panel = $('panel');
    this.reopen = $('panel-reopen');
    this.preview = $('preview');
    this.hud = $('hud');
    this.arFab = $('ar-fab');
    this._arBusy = false;
    this.toastEl = $('toast');
    this.toastTimer = 0;

    this._bindWidgets();
    this._bindButtons();
    this._bindModeSegment();
    this._bindDragDrop();
    this._bindKeys();

    onChange((keys) => {
      this.syncFromConfig(keys);
      if (keys.includes('showPreview') || keys.includes('showHud')) this.applyChrome();
      if (keys.includes('mode')) this._paintModeSegment();
    });

    this.syncFromConfig();
    this._paintModeSegment();
    this.applyChrome();

    // On a phone the panel covers the entire viewport, so opening it by default
    // would hide the very thing the app exists to show.
    if (this.isCompact()) this.togglePanel(false);
  }

  /**
   * Toggle AR passthrough on behalf of either control.
   *
   * Opening a camera is slow and can fail, so both controls are locked for the
   * duration and then resynced from config — which reflects what actually
   * happened, not what was asked for.
   */
  async _requestAr(wanted) {
    if (this._arBusy) return;
    this._arBusy = true;
    $('c-ar').disabled = true;
    this.arFab.classList.add('busy');
    try {
      await this.h.onToggleAr(wanted);
    } finally {
      this._arBusy = false;
      $('c-ar').disabled = false;
      this.arFab.classList.remove('busy');
      this.syncFromConfig(['arMode']);
    }
  }

  /** Show the AR passthrough controls. Desktops have no rear camera. */
  enableArControl(show) {
    $('group-ar').classList.toggle('hidden', !show);
    this.arFab.classList.toggle('hidden', !show);
  }

  /** Persistent line under the AR toggle; pass null to clear. */
  setArStatus(text, kind = '') {
    const el = $('ar-status');
    el.classList.toggle('hidden', !text);
    el.textContent = text || '';
    el.style.color = kind === 'warn' ? 'var(--warn)'
                   : kind === 'bad' ? 'var(--bad)'
                   : 'var(--muted)';
  }

  /** True when the panel occupies the whole viewport rather than sitting beside it. */
  isCompact() {
    return window.matchMedia('(max-width: 760px)').matches || isTouchDevice();
  }

  /* ------------------------------------------------------------- widgets */

  _bindWidgets() {
    this.widgets = [];
    for (const [id, key, kind, labelId, fmt] of BINDINGS) {
      const el = $(id);
      if (!el) continue;
      const label = labelId ? $(labelId) : null;
      const entry = { el, key, kind, label, fmt };
      this.widgets.push(entry);

      // AR mode owns its own handler in _bindButtons: it must open a camera,
      // may fail, and only then may config change.
      if (key === 'arMode') continue;

      el.addEventListener('input', () => {
        const value = kind === 'check' ? el.checked : parseFloat(el.value);
        // Leaving auto mode should not teleport the camera: seed the manual
        // sliders from whatever auto had computed, so the handoff is invisible.
        if (key === 'camOffsetAuto' && value === false) {
          const measured = this.h.getAutoCameraOffset?.();
          if (measured) {
            set({ camOffsetXCm: round1(measured.x), camOffsetYCm: round1(measured.y) });
          }
        }
        set({ [key]: value });
        // Nudging a gain by hand means the user has left the preset behind.
        if (key === 'parallaxGain' || key === 'rotationGain') set({ mode: 'custom' });
      });
    }
  }

  /** Push config values into the widgets. Pass `keys` to update only what changed. */
  syncFromConfig(keys = null) {
    for (const w of this.widgets) {
      if (keys && !keys.includes(w.key)) continue;
      const v = config[w.key];
      if (w.kind === 'check') {
        w.el.checked = !!v;
      } else {
        if (parseFloat(w.el.value) !== v) w.el.value = String(v);
        if (w.label) w.label.textContent = w.fmt ? w.fmt(v) : String(v);
      }
    }
    // AR passthrough overrides all set dressing, so those toggles are inert.
    if (!keys || keys.includes('arMode')) {
      const ar = config.arMode;
      for (const id of ['c-room', 'c-frame', 'c-props']) {
        const el = $(id);
        if (!el) continue;
        el.disabled = ar;
        el.closest('.check').style.opacity = ar ? 0.4 : 1;
      }
      this.arFab?.classList.toggle('active', ar);
      this.arFab?.setAttribute('aria-pressed', String(ar));
    }

    // Both camera-offset sliders are meaningless while "auto" is on: the
    // position is derived from the display size and the device orientation.
    if (!keys || keys.includes('camOffsetAuto') ||
        keys.includes('camOffsetXCm') || keys.includes('camOffsetYCm')) {
      const auto = config.camOffsetAuto;
      for (const [sid, lid, key] of [['s-camy', 'v-camy', 'camOffsetYCm'],
                                     ['s-camx', 'v-camx', 'camOffsetXCm']]) {
        const slider = $(sid), label = $(lid);
        if (!slider || !label) continue;
        slider.disabled = auto;
        slider.style.opacity = auto ? 0.4 : 1;
        label.textContent = auto ? 'auto' : config[key].toFixed(1);
      }
    }
  }

  /* ------------------------------------------------------------- buttons */

  _bindButtons() {
    $('btn-panel-toggle').onclick = () => this.togglePanel(false);
    this.reopen.onclick = () => this.togglePanel(true);

    $('btn-preview-collapse').onclick = () =>
      this.preview.classList.toggle('collapsed');

    const fileInput = $('file-input');
    $('btn-load').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const f = fileInput.files?.[0];
      if (f) this.h.onLoadFile(f);
      fileInput.value = '';
    };

    // Two controls, one path: the on-stage button and the panel checkbox both
    // route through _requestAr so they can never race or drift out of step.
    $('c-ar').addEventListener('change', (e) => this._requestAr(e.target.checked));
    this.arFab.addEventListener('click', () => this._requestAr(!config.arMode));

    $('btn-default').onclick = () => this.h.onLoadDefault();
    $('btn-recenter').onclick = () => this.h.onRecenter();
    $('btn-clear-recenter').onclick = () => this.h.onClearRecenter();
    const fs = $('btn-fullscreen');
    if (supportsFullscreen()) {
      fs.onclick = () => this.h.onFullscreen();
    } else {
      // iPhone Safari has no Fullscreen API at all. Saying so beats a dead button.
      fs.textContent = 'Add to Home Screen';
      fs.title = 'iOS has no fullscreen API — install the page for a fullscreen shell';
      fs.onclick = () => this.toast('On iOS: Share → Add to Home Screen, then open it from there', 4200);
    }
    $('btn-reset').onclick = () => {
      reset();
      this.toast('Settings restored to defaults');
    };
  }

  _bindModeSegment() {
    this.seg = $('mode-seg');
    for (const btn of this.seg.querySelectorAll('button')) {
      btn.onclick = () => {
        applyMode(btn.dataset.mode);
        this.toast(`${btn.textContent} mode`);
      };
    }
  }

  _paintModeSegment() {
    for (const btn of this.seg.querySelectorAll('button')) {
      btn.classList.toggle('active', btn.dataset.mode === config.mode);
    }
    $('mode-hint').innerHTML = MODE_HINTS[config.mode] ||
      'Custom gains. Use the mode buttons above to jump back to a preset.';
  }

  /* ------------------------------------------------------------ drag & drop */

  _bindDragDrop() {
    const zone = $('dropzone');
    let depth = 0;

    const isModelDrag = (e) =>
      Array.from(e.dataTransfer?.items || []).some((i) => i.kind === 'file');

    window.addEventListener('dragenter', (e) => {
      if (!isModelDrag(e)) return;
      e.preventDefault();
      if (++depth === 1) zone.classList.add('show');
    });
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('dragleave', () => {
      if (--depth <= 0) { depth = 0; zone.classList.remove('show'); }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      zone.classList.remove('show');
      const f = e.dataTransfer?.files?.[0];
      if (f) this.h.onLoadFile(f);
    });
  }

  /* ------------------------------------------------------------- keyboard */

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case 'h': this.togglePanel(); break;
        case 'c': this.h.onRecenter(); break;
        case 'f': this.h.onFullscreen(); break;
        case 'p': set({ showPreview: !config.showPreview }); break;
        case '1': applyMode('window'); this.toast('Window mode'); break;
        case '2': applyMode('hybrid'); this.toast('Hybrid mode'); break;
        case '3': applyMode('turntable'); this.toast('Turntable mode'); break;
        case ' ': e.preventDefault(); this.h.onFreeze(); break;
        default: return;
      }
    });
  }

  /* --------------------------------------------------------------- chrome */

  togglePanel(open) {
    const willOpen = open ?? this.panel.classList.contains('collapsed');
    this.panel.classList.toggle('collapsed', !willOpen);
    this.reopen.classList.toggle('hidden', willOpen);
  }

  applyChrome() {
    this.preview.classList.toggle('hidden', !config.showPreview);
    this.hud.classList.toggle('hidden', !config.showHud);
  }

  /** Reveal the in-app chrome once the camera is live. */
  revealChrome() {
    this.panel.classList.remove('hidden');
    this.applyChrome();
  }

  toast(msg, ms = 1900) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  setModelName(name) { $('model-name').textContent = name; }

  setProgress(fraction) {
    const bar = $('model-progress');
    if (fraction === null) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.firstElementChild.style.width = `${Math.round(fraction * 100)}%`;
  }

  setScreenReadout(text) { $('readout-screen').textContent = text; }
}

const round1 = (v) => Math.round(v * 10) / 10;
