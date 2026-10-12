# Gaea Web

Browser-based procedural terrain generator that reproduces the core workflow of
[QuadSpinner Gaea](https://quadspinner.com/): a **node graph** of primitives →
**erosion** → data masks → color, built on the GPU with WebGL2 and exported as
16-bit heightmaps. Target output is **4000 × 2500** within a **20 second** build budget.

## Features

| Category | Nodes |
| --- | --- |
| Primitive | Mountain (ridged, slope-damped detail for crisp ridges and planar flanks, range stretch with locally varying direction), Hills (rolling lowlands), Volcano (stratovolcano with crater, irregular outline, radial ridges, parasitic cones), Perlin (standard / billow / ridged fBm), Voronoi (F1, F2, F2−F1, cell id, edges), Gradient, Shape (island mask), Constant |
| Erosion | **Fluvial** — landscape-evolution erosion: implicit stream-power incision (drainage area × slope) with hillslope diffusion on a flow pyramid; fast, realistic ridge-and-valley ranges. **Erosion** — hydraulic erosion (virtual-pipes shallow water model with sediment transport, depth-limited capacity, optional talus slippage), progressive multi-resolution, outputs *Flow*, *Wear*, *Deposit* data maps. **Thermal** — angle-of-repose scree. **Rivers** — carves channels and valleys where a Flow map exceeds a threshold, outputs a river mask. Optional erodibility mask input on Erosion. |
| Modifier | **Zone Mix** (lowland / hills / mountain zones driven by a control map, per-zone relief and base), **Sea** (sea level, shore, water mask), Combine (add / subtract / multiply / max / min / blend / screen / overlay / difference, masked), Warp, Terrace, Blur, Levels, Autolevel, Clamp, Adjust, Invert |
| Data | **Flow** (depression filling + D8 flow accumulation on a resolution pyramid → flow map, lake mask, filled height), Slope, Height (altitude band), Curvature |
| Color | SatMap (altitude gradient library + slope rock + snow line + flow wetness + water input + variation), Mixer (mask blend of two color maps) |

- Presets include a **Game world** graph: continent shape → Zone Mix (plains / hills / ranges)
  → Erosion → Flow → Rivers → Sea → SatMap with lakes, rivers and sea as water. Every mask
  (rivers, lakes, sea, slope, flow, wear…) can be viewed and exported as a 16-bit PNG for splat maps.
- **World seed** in the toolbar re-rolls every node at once; node seeds act as offsets.
- Node editor: drag ports to connect, double-click the canvas to add nodes, right-click for
  options, `Delete` removes. Any output port can be viewed (masks are painted on the terrain).
- Live preview at 1024 px while editing; **Build** renders the chosen resolution.
- **Time budget**: the build is time-boxed. Erosion measures its own GPU cost and shortens the
  iteration count to finish inside the budget (default 20 s), reporting what it used.
- Only changed nodes are recomputed (per-node memoisation keyed on parameters + upstream).
- 2D hillshade view and 3D orbit view (1024-wide mesh, per-texel normals, fog).
- Export: **16-bit grayscale PNG**, **16-bit little-endian RAW (.r16)** of the viewed height /
  mask, and **8-bit RGBA PNG** of a color node. Graphs save / load as JSON and auto-persist.

## How erosion is kept under 20 s at 4000 × 2500

1. The simulation runs at a capped resolution (`Detail` parameter: 1K / 2K / 4K / full) on a
   pyramid of levels (e.g. 500 → 1000 → 2000). Large valleys form cheaply on coarse levels;
   finer levels refine channels. Water, sediment and data maps carry over between levels.
2. Each level carries only the *height delta* it produced; the final output is
   `input + bicubic(delta)`, so the full-resolution detail of the input primitive is preserved
   above the simulation resolution (Gaea-style "detail restoration").
3. Every batch of iterations is fenced (`fenceSync`) and timed; the remaining budget is shared
   across levels and heavy nodes, so the build ends on time on any GPU. The status bar reports
   how many iterations actually ran when the budget cut a build short.

Sediment capacity follows discharge (velocity × depth) rather than velocity alone, so thin sheet
flow barely erodes while converging channels deepen — the positive feedback that produces
dendritic drainage. Rain is jittered per pixel each iteration to break grid symmetry.

All float textures use manual bilinear / bicubic sampling, so only `EXT_color_buffer_float`
is required (Chrome, Edge, Firefox, Safari 16+).

## Running it

**Quickest — no install:** open **`gaea-web.html`** (at the repository root) in Chrome, Edge or
Firefox. It is a self-contained build; double-clicking the file is enough.

> Do not open `index.html` directly — it is the Vite source entry and only works through the
> dev server below.

**Development:**

```bash
npm install
npm run dev              # http://localhost:5173
npm run build            # static site in dist/ (needs a web server)
npm run build:standalone # regenerates gaea-web.html (single file, works from file://)
npm run typecheck
npm test                 # graph + PNG encoder unit tests (vitest)
```

The app is a static site; `dist/` can be served from any host (GitHub Pages, S3, …).

## Project layout

```
src/gl/        WebGL2 context, texture pool (R32F / RGBA32F / RGBA8), shader programs
src/shaders/   GLSL: hashing & noise, sampling helpers, erosion passes
src/engine/    graph model, builder (memoised + budgeted evaluation), export, node definitions
src/ui/        node editor, properties panel, 2D/3D viewport, presets
```
