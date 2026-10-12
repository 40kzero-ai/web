import './style.css';
import { GLContext } from './gl/context';
import { Engine } from './engine/engine';
import { Builder } from './engine/builder';
import { nodeDef } from './engine/nodes';
import { readHeight16, readColor, encodePNG, encodeRaw16, download } from './engine/export';
import { AppState } from './ui/state';
import { NodeEditor } from './ui/nodeEditor';
import { PropertiesPanel } from './ui/properties';
import { Viewport } from './ui/viewport';
import { PRESETS } from './ui/presets';
import type { Tex } from './gl/texture';

const RES_OPTIONS: [number, number, string][] = [
  [1024, 640, '1024 × 640 (draft)'],
  [2048, 1280, '2048 × 1280'],
  [4000, 2500, '4000 × 2500 (target)'],
  [4096, 4096, '4096 × 4096'],
];

const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="toolbar">
    <div class="brand">Gaea<span>Web</span></div>
    <label>Preset <select id="preset"></select></label>
    <label>Resolution <select id="res"></select></label>
    <label>Budget <input id="budget" type="number" min="2" max="120" step="1" style="width:52px"> s</label>
    <label title="Terrain height range as a fraction of map width">Height <input id="hratio" type="range" min="0.05" max="0.5" step="0.01" style="width:80px"><span id="hratioV"></span></label>
    <label title="Changes every seed in the graph at once">Seed <input id="seed" type="number" min="0" max="999999" step="1" style="width:70px"><button id="reseed" class="btn btn-small" title="Random world seed">🎲</button></label>
    <label><input id="autoprev" type="checkbox"> Live preview</label>
    <button id="build" class="btn btn-primary">Build</button>
    <button id="cancel" class="btn" disabled>Cancel</button>
    <span class="spacer"></span>
    <div class="seg"><button id="view2d" class="btn">2D</button><button id="view3d" class="btn active">3D</button><button id="resetcam" class="btn" title="Reset camera">⟲</button></div>
    <button id="expHeight" class="btn">Export Height PNG16</button>
    <button id="expRaw" class="btn">RAW16</button>
    <button id="expColor" class="btn">Color PNG</button>
    <button id="saveGraph" class="btn" title="Download graph JSON">Save</button>
    <button id="loadGraph" class="btn" title="Load graph JSON">Load</button>
  </header>
  <main class="main">
    <div class="viewport"><canvas id="gl"></canvas><div id="overlayInfo" class="overlay-info"></div></div>
    <aside class="props" id="props"></aside>
  </main>
  <section class="graph" id="graph"></section>
  <footer class="status">
    <div class="progress"><div id="progressBar"></div></div>
    <span id="statusText">Initialising…</span>
    <span class="spacer"></span>
    <span id="gpuInfo"></span>
  </footer>`;

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const statusText = document.getElementById('statusText')!;
const progressBar = document.getElementById('progressBar')!;
const overlayInfo = document.getElementById('overlayInfo')!;

let ctx: GLContext;
try {
  ctx = new GLContext(canvas);
} catch (e) {
  statusText.textContent = (e as Error).message;
  overlayInfo.textContent = 'WebGL2 with float render targets is required (Chrome, Edge, Firefox or Safari 16+).';
  throw e;
}
const engine = new Engine(ctx);
const builder = new Builder(engine);
const state = new AppState();
const viewport = new Viewport(ctx, engine, canvas);
document.getElementById('gpuInfo')!.textContent = `${ctx.caps.renderer} · max texture ${ctx.caps.maxTextureSize}`;

// ---- Settings UI ----
const presetSel = document.getElementById('preset') as HTMLSelectElement;
for (const [k, v] of Object.entries(PRESETS)) { const o = document.createElement('option'); o.value = k; o.textContent = v.label; presetSel.appendChild(o); }
const resSel = document.getElementById('res') as HTMLSelectElement;
for (const [w, h, label] of RES_OPTIONS) { const o = document.createElement('option'); o.value = `${w}x${h}`; o.textContent = label; resSel.appendChild(o); }
resSel.value = `${state.settings.width}x${state.settings.height}`;
const budgetInput = document.getElementById('budget') as HTMLInputElement;
budgetInput.value = String(state.settings.budgetSec);
const hratio = document.getElementById('hratio') as HTMLInputElement;
const hratioV = document.getElementById('hratioV')!;
hratio.value = String(state.settings.heightRatio);
hratioV.textContent = state.settings.heightRatio.toFixed(2);
const autoprev = document.getElementById('autoprev') as HTMLInputElement;
autoprev.checked = state.settings.autoPreview;
const seedInput = document.getElementById('seed') as HTMLInputElement;
seedInput.value = String(state.settings.worldSeed);
seedInput.addEventListener('change', () => state.updateSettings({ worldSeed: Math.max(0, Number(seedInput.value) | 0) }));
document.getElementById('reseed')!.addEventListener('click', () => { const v = Math.floor(Math.random() * 999999); seedInput.value = String(v); state.updateSettings({ worldSeed: v }); });

resSel.addEventListener('change', () => { const [w, h] = resSel.value.split('x').map(Number); state.updateSettings({ width: w, height: h }); });
budgetInput.addEventListener('change', () => state.updateSettings({ budgetSec: Math.max(2, Number(budgetInput.value) || 20) }));
hratio.addEventListener('input', () => { state.updateSettings({ heightRatio: Number(hratio.value) }); hratioV.textContent = Number(hratio.value).toFixed(2); });
autoprev.addEventListener('change', () => state.updateSettings({ autoPreview: autoprev.checked }));
presetSel.addEventListener('change', () => { state.loadGraph(PRESETS[presetSel.value].build()); editor.fit(); });

const view2d = document.getElementById('view2d')!, view3d = document.getElementById('view3d')!;
const setView = (v: '2d' | '3d') => { viewport.mode = v; view2d.classList.toggle('active', v === '2d'); view3d.classList.toggle('active', v === '3d'); viewport.invalidate(); };
view2d.addEventListener('click', () => setView('2d'));
view3d.addEventListener('click', () => setView('3d'));
document.getElementById('resetcam')!.addEventListener('click', () => viewport.resetCamera());

// ---- Panels ----
const editor = new NodeEditor(document.getElementById('graph')!, state);
new PropertiesPanel(document.getElementById('props')!, state);

// ---- Build scheduling ----
let lastBuild: { preview: boolean; width: number; height: number } | null = null;
let pending: 'preview' | 'full' | null = null;
let currentKind: 'preview' | 'full' | null = null;
let timer: number | undefined;

function previewSize(): [number, number] {
  const { width, height, previewWidth } = state.settings;
  const w = Math.min(width, previewWidth);
  return [w, Math.max(16, Math.round((height * w) / width))];
}

function setProgress(f: number, msg: string): void {
  progressBar.style.width = `${Math.min(100, Math.max(0, f * 100)).toFixed(1)}%`;
  statusText.textContent = msg;
}

async function runBuild(kind: 'preview' | 'full'): Promise<void> {
  if (builder.building) {
    // A preview never interrupts an explicit full build; anything else restarts with the latest graph.
    pending = pending === 'full' ? 'full' : kind;
    if (!(kind === 'preview' && currentKind === 'full')) builder.cancel();
    return;
  }
  currentKind = kind;
  const target = state.selected ?? state.graph.output;
  if (!target) { setProgress(0, 'Graph is empty — add a node.'); viewport.setContent({ geometry: null, overlay: null, color: null }); return; }
  const [w, h] = kind === 'preview' ? previewSize() : [state.settings.width, state.settings.height];
  if (Math.max(w, h) > ctx.caps.maxTextureSize) { setProgress(0, `Resolution exceeds GPU max texture size (${ctx.caps.maxTextureSize}).`); return; }
  const buildBtn = document.getElementById('build') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;
  buildBtn.disabled = true; cancelBtn.disabled = false;
  builder.onProgress = setProgress;
  try {
    const res = await builder.build(state.graph, {
      width: w, height: h, heightRatio: state.settings.heightRatio,
      budgetMs: kind === 'preview' ? Math.min(state.settings.budgetSec, 6) * 1000 : state.settings.budgetSec * 1000,
      preview: kind === 'preview',
      worldSeed: state.settings.worldSeed,
    }, target);
    lastBuild = { preview: kind === 'preview', width: w, height: h };
    const secs = (res.timeMs / 1000).toFixed(2);
    const note = res.notes.length ? ` · ${res.notes.join('; ')}` : '';
    setProgress(1, `${kind === 'preview' ? 'Preview' : 'Build'} ${w}×${h} done in ${secs} s (${res.evaluated.length} node${res.evaluated.length === 1 ? '' : 's'} recomputed)${note}`);
    engine.pool.trim();
    showSelected();
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === 'cancelled') setProgress(0, 'Build cancelled');
    else { setProgress(0, `Error: ${msg}`); console.error(e); }
  } finally {
    buildBtn.disabled = false; cancelBtn.disabled = true;
    currentKind = null;
    if (pending) { const k = pending; pending = null; void runBuild(k); }
  }
}

function schedulePreview(): void {
  if (!state.settings.autoPreview) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void runBuild('preview'), 120);
}

/** Resolve which textures to display for the selected node + port. */
function resolveView(): { geometry: Tex | null; overlay: Tex | null; color: Tex | null } | null {
  const n = state.node(state.selected);
  if (!n) return null;
  const outputs = builder.getOutputs(n.id);
  if (!outputs) return null;
  const def = nodeDef(n.type);
  const port = def.outputs.find((o) => o.key === state.viewPort) ?? def.outputs[0];
  const tex = outputs[port.key];
  if (!tex) return null;
  if (port.kind === 'color') return { geometry: outputs.height ?? null, overlay: null, color: tex };
  if (port.isMask) {
    // Paint the mask over this node's own terrain output, or over its height input.
    const own = def.outputs.find((o) => o.key === 'height' && !o.isMask) ? outputs.height : null;
    const ref = n.inputs.height;
    const geo = own ?? (ref ? builder.getOutputs(ref.node)?.[ref.port] ?? null : null);
    return { geometry: geo ?? tex, overlay: tex, color: null };
  }
  return { geometry: tex, overlay: null, color: null };
}

function showSelected(): void {
  const v = resolveView();
  if (!v) return;
  viewport.heightRatio = state.settings.heightRatio;
  viewport.setContent(v);
  const n = state.node(state.selected)!;
  const def = nodeDef(n.type);
  overlayInfo.textContent = `${def.title} · ${state.viewPort} · ${v.geometry?.width ?? 0}×${v.geometry?.height ?? 0}${lastBuild?.preview ? ' (preview)' : ''}`;
}

state.on('graph', schedulePreview);
state.on('settings', () => { viewport.heightRatio = state.settings.heightRatio; viewport.invalidate(); schedulePreview(); });
state.on('selection', () => {
  const v = resolveView();
  if (v) showSelected();
  else schedulePreview();
});
document.getElementById('build')!.addEventListener('click', () => void runBuild('full'));
document.getElementById('cancel')!.addEventListener('click', () => builder.cancel());

// ---- Export ----
async function ensureFullBuild(): Promise<boolean> {
  if (lastBuild && !lastBuild.preview && lastBuild.width === state.settings.width && lastBuild.height === state.settings.height && !builder.building) return true;
  await runBuild('full');
  return !!lastBuild && !lastBuild.preview;
}
async function exportHeight(fmt: 'png' | 'raw'): Promise<void> {
  if (!(await ensureFullBuild())) return;
  const v = resolveView();
  const tex = v?.overlay ?? v?.geometry;
  if (!tex) { setProgress(0, 'Nothing to export'); return; }
  setProgress(0.5, 'Reading back height…');
  await new Promise((r) => setTimeout(r, 10));
  const data = readHeight16(engine, tex);
  const name = `terrain_${tex.width}x${tex.height}`;
  if (fmt === 'png') download(await encodePNG(tex.width, tex.height, data, 1), `${name}.png`);
  else download(encodeRaw16(data), `${name}.r16`);
  setProgress(1, `Exported ${name}.${fmt === 'png' ? 'png (16-bit grayscale)' : 'r16 (16-bit little-endian RAW)'}`);
}
async function exportColor(): Promise<void> {
  if (!(await ensureFullBuild())) return;
  const v = resolveView();
  if (!v?.color) { setProgress(0, 'Select a Color node (SatMap / Mixer) to export a color map'); return; }
  setProgress(0.5, 'Reading back color…');
  await new Promise((r) => setTimeout(r, 10));
  const data = readColor(engine, v.color);
  download(await encodePNG(v.color.width, v.color.height, data, 4), `color_${v.color.width}x${v.color.height}.png`);
  setProgress(1, 'Exported color PNG');
}
document.getElementById('expHeight')!.addEventListener('click', () => void exportHeight('png'));
document.getElementById('expRaw')!.addEventListener('click', () => void exportHeight('raw'));
document.getElementById('expColor')!.addEventListener('click', () => void exportColor());

// ---- Save / load ----
document.getElementById('saveGraph')!.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 1, settings: state.settings, graph: state.graph }, null, 2)], { type: 'application/json' });
  download(blob, 'terrain-graph.json');
});
document.getElementById('loadGraph')!.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'application/json';
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (j.settings) state.updateSettings(j.settings);
      state.loadGraph(j.graph);
      editor.fit();
    } catch (e) { setProgress(0, `Could not load graph: ${(e as Error).message}`); }
  });
  input.click();
});

// Persist graph in localStorage.
window.addEventListener('beforeunload', () => {
  try { localStorage.setItem('gaea-web-graph', JSON.stringify({ settings: state.settings, graph: state.graph })); } catch { /* ignore */ }
});

// ---- Startup ----
let restored = false;
try {
  const saved = localStorage.getItem('gaea-web-graph');
  if (saved && !location.hash.includes('reset')) {
    const j = JSON.parse(saved);
    if (j.settings) state.updateSettings({ ...j.settings, view: '3d' });
    if (j.graph?.nodes?.length) { state.loadGraph(j.graph); restored = true; }
  }
} catch { /* ignore */ }
if (!restored) state.loadGraph(PRESETS.world.build());
resSel.value = `${state.settings.width}x${state.settings.height}`;
budgetInput.value = String(state.settings.budgetSec);
hratio.value = String(state.settings.heightRatio); hratioV.textContent = state.settings.heightRatio.toFixed(2);
autoprev.checked = state.settings.autoPreview;
seedInput.value = String(state.settings.worldSeed ?? 1337);
if (state.settings.worldSeed === undefined) state.settings.worldSeed = 1337;
requestAnimationFrame(() => { editor.fit(); if (!state.settings.autoPreview) void runBuild('preview'); });

// Expose for debugging / automated tests.
(window as unknown as { gaea: unknown }).gaea = { state, builder, engine, runBuild, viewport, editor, presets: PRESETS };
