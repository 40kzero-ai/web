import type { AppState } from './state';
import { nodeDef } from '../engine/nodes';
import type { ParamDef } from '../engine/graph';

/** Properties panel for the selected node. */
export class PropertiesPanel {
  constructor(private root: HTMLElement, private state: AppState) {
    state.on('selection', () => this.render());
    state.on('graph', () => this.renderIfStructureChanged());
    this.render();
  }

  private lastKey = '';

  private renderIfStructureChanged(): void {
    const n = this.state.node(this.state.selected);
    const key = n ? `${n.id}:${n.type}` : '';
    if (key !== this.lastKey) this.render();
  }

  render(): void {
    const n = this.state.node(this.state.selected);
    this.lastKey = n ? `${n.id}:${n.type}` : '';
    this.root.innerHTML = '';
    if (!n) {
      this.root.innerHTML = '<div class="props-empty">Select a node to edit its properties.</div>';
      return;
    }
    const def = nodeDef(n.type);
    const head = document.createElement('div');
    head.className = 'props-head';
    head.innerHTML = `<div class="props-title">${def.title}</div><div class="props-desc">${def.description}</div>`;
    this.root.appendChild(head);

    if (def.outputs.length > 1) {
      const row = document.createElement('div');
      row.className = 'prop-row';
      row.innerHTML = `<label>View output</label>`;
      const sel = document.createElement('select');
      for (const o of def.outputs) {
        const opt = document.createElement('option');
        opt.value = o.key; opt.textContent = o.label; opt.selected = o.key === this.state.viewPort;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => this.state.select(n.id, sel.value));
      row.appendChild(sel);
      this.root.appendChild(row);
    }

    for (const p of def.params) this.root.appendChild(this.paramRow(n.id, p, n.params[p.key]));

    const actions = document.createElement('div');
    actions.className = 'props-actions';
    const outBtn = document.createElement('button');
    outBtn.className = 'btn';
    outBtn.textContent = this.state.graph.output === n.id ? '✓ Output node' : 'Set as output';
    outBtn.addEventListener('click', () => { this.state.setOutput(n.id); this.render(); });
    actions.appendChild(outBtn);
    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', () => { for (const p of def.params) this.state.setParam(n.id, p.key, p.default); this.render(); });
    actions.appendChild(resetBtn);
    this.root.appendChild(actions);
  }

  private paramRow(id: string, p: ParamDef, value: number | string | boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const label = document.createElement('label');
    label.textContent = p.label;
    if (p.hint) label.title = p.hint;
    row.appendChild(label);
    if (p.type === 'select') {
      const sel = document.createElement('select');
      for (const o of p.options ?? []) {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label; opt.selected = o.value === value;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => this.state.setParam(id, p.key, sel.value));
      row.appendChild(sel);
    } else if (p.type === 'bool') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!value;
      cb.addEventListener('change', () => this.state.setParam(id, p.key, cb.checked));
      row.appendChild(cb);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'slider-wrap';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(p.min ?? 0); range.max = String(p.max ?? 1); range.step = String(p.step ?? 0.01);
      range.value = String(value);
      const num = document.createElement('input');
      num.type = 'number';
      num.min = range.min; num.max = range.max; num.step = range.step; num.value = String(value);
      const commit = (v: number) => {
        if (Number.isNaN(v)) return;
        const clamped = Math.min(Number(range.max), Math.max(Number(range.min), v));
        const val = p.type === 'int' || p.type === 'seed' ? Math.round(clamped) : clamped;
        range.value = String(val); num.value = String(val);
        this.state.setParam(id, p.key, val);
      };
      range.addEventListener('input', () => commit(Number(range.value)));
      num.addEventListener('change', () => commit(Number(num.value)));
      wrap.appendChild(range);
      wrap.appendChild(num);
      if (p.type === 'seed') {
        const btn = document.createElement('button');
        btn.className = 'btn btn-small';
        btn.textContent = '🎲';
        btn.title = 'Randomize seed';
        btn.addEventListener('click', () => commit(Math.floor(Math.random() * 99999)));
        wrap.appendChild(btn);
      }
      row.appendChild(wrap);
    }
    return row;
  }
}
