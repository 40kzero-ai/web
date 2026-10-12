import type { AppState } from './state';
import type { NodeInstance, PortKind } from '../engine/graph';
import { wouldCycle } from '../engine/graph';
import { ALL_NODES, nodeDef } from '../engine/nodes';

const NODE_W = 170;
const HEADER_H = 26;
const PORT_H = 20;

const CATEGORY_COLORS: Record<string, string> = {
  Primitive: '#3b82f6', Erosion: '#d97706', Modifier: '#8b5cf6', Data: '#10b981', Color: '#ec4899', Utility: '#64748b',
};

function nodeHeight(n: NodeInstance): number {
  const def = nodeDef(n.type);
  return HEADER_H + Math.max(def.inputs.length, def.outputs.length) * PORT_H + 8;
}
function inputPos(n: NodeInstance, idx: number): [number, number] {
  return [n.x, n.y + HEADER_H + 10 + idx * PORT_H];
}
function outputPos(n: NodeInstance, idx: number): [number, number] {
  return [n.x + NODE_W, n.y + HEADER_H + 10 + idx * PORT_H];
}

interface DragLink { from: { node: string; port: string; kind: PortKind }; x: number; y: number; }

/** Pannable / zoomable node graph editor (DOM nodes + SVG links). */
export class NodeEditor {
  private root: HTMLElement;
  private world: HTMLElement;
  private svg: SVGSVGElement;
  private nodesLayer: HTMLElement;
  private pan = { x: 20, y: 20 };
  private zoom = 1;
  private dragLink: DragLink | null = null;
  private menu: HTMLElement | null = null;
  private nodeEls = new Map<string, HTMLElement>();

  constructor(container: HTMLElement, private state: AppState) {
    this.root = container;
    this.root.classList.add('graph-root');
    this.root.innerHTML = `
      <div class="graph-toolbar">
        <button class="btn" data-action="add">+ Add node</button>
        <button class="btn" data-action="fit">Fit</button>
        <span class="hint">Drag ports to connect · Double-click canvas to add · Del removes · Right-click node for options</span>
      </div>
      <div class="graph-world"><svg class="graph-links"></svg><div class="graph-nodes"></div></div>`;
    this.world = this.root.querySelector('.graph-world')!;
    this.svg = this.root.querySelector('.graph-links')!;
    this.nodesLayer = this.root.querySelector('.graph-nodes')!;
    this.root.querySelector('[data-action="add"]')!.addEventListener('click', (e) => this.showAddMenu(e as MouseEvent));
    this.root.querySelector('[data-action="fit"]')!.addEventListener('click', () => this.fit());
    this.bindCanvas();
    state.on('graph', () => this.render());
    state.on('selection', () => this.updateSelection());
    this.render();
  }

  private toWorld(clientX: number, clientY: number): [number, number] {
    const r = this.world.getBoundingClientRect();
    return [(clientX - r.left - this.pan.x) / this.zoom, (clientY - r.top - this.pan.y) / this.zoom];
  }

  private applyTransform(): void {
    const t = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
    this.nodesLayer.style.transform = t;
    this.svg.style.transform = t;
  }

  fit(): void {
    const nodes = this.state.graph.nodes;
    if (!nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_W); maxY = Math.max(maxY, n.y + nodeHeight(n));
    }
    const r = this.world.getBoundingClientRect();
    const pad = 30;
    this.zoom = Math.min(1.25, Math.max(0.3, Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY))));
    this.pan.x = (r.width - (maxX - minX) * this.zoom) / 2 - minX * this.zoom;
    this.pan.y = (r.height - (maxY - minY) * this.zoom) / 2 - minY * this.zoom;
    this.applyTransform();
  }

  private bindCanvas(): void {
    let panning: { sx: number; sy: number; px: number; py: number } | null = null;
    this.world.addEventListener('pointerdown', (e) => {
      if (e.target !== this.world && e.target !== this.svg && e.target !== this.nodesLayer) return;
      this.closeMenu();
      if (e.button === 0 || e.button === 1) {
        panning = { sx: e.clientX, sy: e.clientY, px: this.pan.x, py: this.pan.y };
        this.world.setPointerCapture(e.pointerId);
      }
    });
    this.world.addEventListener('pointermove', (e) => {
      if (panning) {
        this.pan.x = panning.px + (e.clientX - panning.sx);
        this.pan.y = panning.py + (e.clientY - panning.sy);
        this.applyTransform();
      }
      if (this.dragLink) {
        const [x, y] = this.toWorld(e.clientX, e.clientY);
        this.dragLink.x = x; this.dragLink.y = y;
        this.renderLinks();
      }
    });
    const endDrag = () => {
      panning = null;
      if (this.dragLink) { this.dragLink = null; this.renderLinks(); }
    };
    this.world.addEventListener('pointerup', endDrag);
    this.world.addEventListener('pointercancel', endDrag);
    this.world.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.world.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const nz = Math.min(2, Math.max(0.25, this.zoom * factor));
      this.pan.x = mx - (mx - this.pan.x) * (nz / this.zoom);
      this.pan.y = my - (my - this.pan.y) * (nz / this.zoom);
      this.zoom = nz;
      this.applyTransform();
    }, { passive: false });
    this.world.addEventListener('dblclick', (e) => {
      if (e.target !== this.world && e.target !== this.svg && e.target !== this.nodesLayer) return;
      this.showAddMenu(e, this.toWorld(e.clientX, e.clientY));
    });
    this.world.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.state.selected && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) {
        this.state.removeNode(this.state.selected);
      }
    });
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  private showAddMenu(e: MouseEvent, at?: [number, number]): void {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    const r = this.root.getBoundingClientRect();
    menu.style.left = `${e.clientX - r.left}px`;
    menu.style.top = `${e.clientY - r.top}px`;
    const cats = [...new Set(ALL_NODES.map((d) => d.category))];
    for (const cat of cats) {
      const h = document.createElement('div');
      h.className = 'ctx-cat';
      h.textContent = cat;
      h.style.color = CATEGORY_COLORS[cat];
      menu.appendChild(h);
      for (const d of ALL_NODES.filter((d) => d.category === cat)) {
        const item = document.createElement('div');
        item.className = 'ctx-item';
        item.textContent = d.title;
        item.title = d.description;
        item.addEventListener('click', () => {
          const pos = at ?? this.toWorld(e.clientX, e.clientY);
          const n = this.state.addNode(d.type, pos[0], pos[1]);
          this.state.select(n.id);
          this.closeMenu();
        });
        menu.appendChild(item);
      }
    }
    this.root.appendChild(menu);
    this.menu = menu;
    const close = (ev: Event) => { if (!menu.contains(ev.target as Node)) { this.closeMenu(); window.removeEventListener('pointerdown', close); } };
    setTimeout(() => window.addEventListener('pointerdown', close), 0);
  }

  private showNodeMenu(e: MouseEvent, n: NodeInstance): void {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    const r = this.root.getBoundingClientRect();
    menu.style.left = `${e.clientX - r.left}px`;
    menu.style.top = `${e.clientY - r.top}px`;
    const items: [string, () => void][] = [
      ['Set as output', () => this.state.setOutput(n.id)],
      ['Duplicate', () => {
        const c = this.state.addNode(n.type, n.x + 30, n.y + 30);
        c.params = { ...n.params };
        c.inputs = { ...n.inputs };
        this.state.emit('graph');
        this.state.select(c.id);
      }],
      ['Delete', () => this.state.removeNode(n.id)],
    ];
    for (const [label, fn] of items) {
      const item = document.createElement('div');
      item.className = 'ctx-item';
      item.textContent = label;
      item.addEventListener('click', () => { fn(); this.closeMenu(); });
      menu.appendChild(item);
    }
    this.root.appendChild(menu);
    this.menu = menu;
    const close = (ev: Event) => { if (!menu.contains(ev.target as Node)) { this.closeMenu(); window.removeEventListener('pointerdown', close); } };
    setTimeout(() => window.addEventListener('pointerdown', close), 0);
  }

  render(): void {
    const g = this.state.graph;
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const [id, el] of this.nodeEls) if (!ids.has(id)) { el.remove(); this.nodeEls.delete(id); }
    for (const n of g.nodes) {
      let el = this.nodeEls.get(n.id);
      if (!el) {
        el = this.createNodeEl(n);
        this.nodeEls.set(n.id, el);
        this.nodesLayer.appendChild(el);
      }
      el.style.left = `${n.x}px`;
      el.style.top = `${n.y}px`;
      el.classList.toggle('is-output', g.output === n.id);
      // Connected input markers
      const def = nodeDef(n.type);
      def.inputs.forEach((p, i) => {
        const dot = el!.querySelectorAll('.port-in .dot')[i] as HTMLElement | undefined;
        dot?.classList.toggle('connected', !!n.inputs[p.key]);
      });
    }
    this.updateSelection();
    this.renderLinks();
    this.applyTransform();
  }

  private updateSelection(): void {
    for (const [id, el] of this.nodeEls) el.classList.toggle('selected', id === this.state.selected);
    const n = this.state.node(this.state.selected);
    for (const [id, el] of this.nodeEls) {
      el.querySelectorAll('.port-out .dot').forEach((d, i) => {
        const def = nodeDef(this.state.node(id)!.type);
        d.classList.toggle('viewing', !!n && id === n.id && def.outputs[i].key === this.state.viewPort);
      });
    }
  }

  private createNodeEl(n: NodeInstance): HTMLElement {
    const def = nodeDef(n.type);
    const el = document.createElement('div');
    el.className = 'node';
    el.style.width = `${NODE_W}px`;
    el.innerHTML = `
      <div class="node-header" style="background:${CATEGORY_COLORS[def.category]}"><span class="node-title">${def.title}</span><span class="out-badge">OUT</span></div>
      <div class="node-body">
        <div class="ports port-in">${def.inputs.map((p) => `<div class="port" data-port="${p.key}" data-kind="${p.kind}"><span class="dot kind-${p.kind}"></span><span class="label">${p.label}</span></div>`).join('')}</div>
        <div class="ports port-out">${def.outputs.map((p) => `<div class="port" data-port="${p.key}" data-kind="${p.kind}"><span class="label">${p.label}</span><span class="dot kind-${p.kind}"></span></div>`).join('')}</div>
      </div>`;
    el.style.height = `${nodeHeight(n)}px`;
    el.title = def.description;
    const header = el.querySelector('.node-header') as HTMLElement;
    // Drag node
    header.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.closeMenu();
      this.state.select(n.id, this.state.selected === n.id ? this.state.viewPort : undefined);
      const [sx, sy] = this.toWorld(e.clientX, e.clientY);
      const ox = n.x - sx, oy = n.y - sy;
      const move = (ev: PointerEvent) => {
        const [wx, wy] = this.toWorld(ev.clientX, ev.clientY);
        n.x = Math.round(wx + ox); n.y = Math.round(wy + oy);
        el.style.left = `${n.x}px`; el.style.top = `${n.y}px`;
        this.renderLinks();
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && !(e.target as HTMLElement).closest('.dot')) { e.stopPropagation(); this.state.select(n.id, this.state.selected === n.id ? this.state.viewPort : undefined); }
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.showNodeMenu(e, n); });
    // Output port: start link drag or select for viewing
    el.querySelectorAll('.port-out .port').forEach((portEl) => {
      const key = (portEl as HTMLElement).dataset.port!;
      const kind = (portEl as HTMLElement).dataset.kind as PortKind;
      portEl.querySelector('.dot')!.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const ev = e as PointerEvent;
        if (ev.button !== 0) return;
        this.state.select(n.id, key);
        const [x, y] = this.toWorld(ev.clientX, ev.clientY);
        this.dragLink = { from: { node: n.id, port: key, kind }, x, y };
        const move = (m: PointerEvent) => { if (this.dragLink) { const [wx, wy] = this.toWorld(m.clientX, m.clientY); this.dragLink.x = wx; this.dragLink.y = wy; this.renderLinks(); } };
        const up = (m: PointerEvent) => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
          const target = document.elementFromPoint(m.clientX, m.clientY)?.closest('.port-in .port') as HTMLElement | null;
          if (target && this.dragLink) {
            const toNodeEl = target.closest('.node') as HTMLElement;
            const toId = [...this.nodeEls.entries()].find(([, v]) => v === toNodeEl)?.[0];
            const toPort = target.dataset.port!;
            const toKind = target.dataset.kind;
            if (toId && toKind === kind && !wouldCycle(this.state.graph, n.id, toId)) this.state.connect({ node: n.id, port: key }, toId, toPort);
          }
          this.dragLink = null;
          this.renderLinks();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });
    // Input port: disconnect (and re-drag from source)
    el.querySelectorAll('.port-in .port').forEach((portEl) => {
      const key = (portEl as HTMLElement).dataset.port!;
      portEl.querySelector('.dot')!.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const ref = n.inputs[key];
        if (!ref) return;
        this.state.disconnect(n.id, key);
        const src = this.state.node(ref.node);
        if (!src) return;
        const kind = nodeDef(src.type).outputs.find((o) => o.key === ref.port)?.kind ?? 'height';
        const ev = e as PointerEvent;
        const [x, y] = this.toWorld(ev.clientX, ev.clientY);
        this.dragLink = { from: { node: ref.node, port: ref.port, kind }, x, y };
        const move = (m: PointerEvent) => { if (this.dragLink) { const [wx, wy] = this.toWorld(m.clientX, m.clientY); this.dragLink.x = wx; this.dragLink.y = wy; this.renderLinks(); } };
        const up = (m: PointerEvent) => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
          const target = document.elementFromPoint(m.clientX, m.clientY)?.closest('.port-in .port') as HTMLElement | null;
          if (target && this.dragLink) {
            const toNodeEl = target.closest('.node') as HTMLElement;
            const toId = [...this.nodeEls.entries()].find(([, v]) => v === toNodeEl)?.[0];
            if (toId && target.dataset.kind === kind && !wouldCycle(this.state.graph, ref.node, toId)) this.state.connect({ node: ref.node, port: ref.port }, toId, target.dataset.port!);
          }
          this.dragLink = null;
          this.renderLinks();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });
    return el;
  }

  private renderLinks(): void {
    const g = this.state.graph;
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    let paths = '';
    const curve = (x1: number, y1: number, x2: number, y2: number, cls: string) => {
      const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
      return `<path class="link ${cls}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`;
    };
    for (const n of g.nodes) {
      const def = nodeDef(n.type);
      def.inputs.forEach((p, i) => {
        const ref = n.inputs[p.key];
        if (!ref) return;
        const src = byId.get(ref.node);
        if (!src) return;
        const sdef = nodeDef(src.type);
        const oi = sdef.outputs.findIndex((o) => o.key === ref.port);
        if (oi < 0) return;
        const [x1, y1] = outputPos(src, oi);
        const [x2, y2] = inputPos(n, i);
        paths += curve(x1, y1, x2, y2, `kind-${p.kind}`);
      });
    }
    if (this.dragLink) {
      const src = byId.get(this.dragLink.from.node);
      if (src) {
        const oi = nodeDef(src.type).outputs.findIndex((o) => o.key === this.dragLink!.from.port);
        const [x1, y1] = outputPos(src, oi);
        paths += curve(x1, y1, this.dragLink.x, this.dragLink.y, `kind-${this.dragLink.from.kind} dragging`);
      }
    }
    this.svg.innerHTML = paths;
  }
}
