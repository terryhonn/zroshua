/**
 * Zroshua Lovelace card.
 *
 * Reads the full irrigation snapshot from the hub sensor attributes (published
 * by the add-on over MQTT; entity auto-discovered by attribute shape) and sends
 * commands back through the `mqtt.publish` service on topic `zroshua/command`.
 * No build step, no dependencies &mdash; a plain custom element.
 *
 * Usage:
 *   type: custom:zroshua-card
 *   view: dashboard        # dashboard | groups | zones | upcoming | timeline
 *   title: Irrigation      # optional
 *   entity: sensor.zroshua_state   # optional override
 */
const VIEWS = ['dashboard', 'groups', 'zones', 'upcoming', 'timeline'];

/** Dashboard info tiles — order/visibility configurable (card config + drag). */
const DASH_TILES = [
  { id: 'watering_now', label: 'Watering now' },
  { id: 'zones', label: 'Zones' },
  { id: 'groups', label: 'Groups' },
  { id: 'today_water', label: 'Today water' },
  { id: 'today_time', label: 'Today time' },
  { id: 'next_watering', label: 'Next watering' },
];
const DASH_TILE_IDS = DASH_TILES.map((t) => t.id);
const TILE_STORE_KEY = 'zroshua.card.tiles';

const I = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>',
  drop: '<svg viewBox="0 0 24 24"><path d="M12 3c3.2 4.2 6 7.5 6 10.7A6 6 0 0 1 6 13.7C6 10.5 8.8 7.2 12 3z"/></svg>',
  sprinkler:
    '<svg viewBox="0 0 24 24"><path d="M11 13h2v8h-2zM7 21h10v1.6H7z"/><circle cx="12" cy="10" r="2.2"/><path d="M5.5 8.5l2.1 1.1M18.5 8.5l-2.1 1.1M12 4.4v2.4M7.6 5.4l1.5 1.9M16.4 5.4l-1.5 1.9" stroke-width="1.7" stroke-linecap="round" fill="none" stroke="currentColor"/></svg>',
  sprout:
    '<svg viewBox="0 0 24 24"><path d="M12 21v-8M12 13c0-4-3-6-7-6 0 4 3 6 7 6zm0 0c0-4 3-6 7-6 0 4-3 6-7 6z"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2" stroke-linecap="round"/></svg>',
  rain: '<svg viewBox="0 0 24 24"><path d="M7 15a5 5 0 0 1-.9-9.9 6 6 0 0 1 11.5 1.7A4 4 0 0 1 17 15H7z"/><path d="M8.5 17.5l-1.2 2.6M12.5 17.5l-1.2 2.6M16.5 17.5l-1.2 2.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>',
  zzz: '<svg viewBox="0 0 24 24"><path d="M5 8h6l-6 7h6M14 5h5l-5 6h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6.5" y="5.5" width="4" height="13" rx="1.5"/><rect x="13.5" y="5.5" width="4" height="13" rx="1.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><rect x="11" y="9.5" width="2" height="5.5" fill="var(--card-background-color,#000)"/><rect x="11" y="16.6" width="2" height="2" fill="var(--card-background-color,#000)"/></svg>',
  queue:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h10M4 18h6"/></svg>',
  seq: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 12h12m0 0-4-4m4 4-4 4"/></svg>',
  par: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 5v14M16 5v14"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  plant: '<svg viewBox="0 0 24 24"><path d="M12 21v-8M12 13c0-4-3-6-7-6 0 4 3 6 7 6zm0 0c0-4 3-6 7-6 0 4-3 6-7 6z"/></svg>',
  group: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  bucket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 8h12l-1.2 11.2a2 2 0 0 1-2 1.8H9.2a2 2 0 0 1-2-1.8L6 8zm-1-3h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2.5M12 20.5V23M4.2 4.2l1.8 1.8M18 18l1.8 1.8M1 12h2.5M20.5 12H23M4.2 19.8l1.8-1.8M18 6l1.8-1.8" stroke-linecap="round"/></svg>',
};
const zoneIcon = (type) =>
  type === 'drip' ? I.drop : type === 'beds' ? I.sprout : I.sprinkler;

class ZroshuaCard extends HTMLElement {
  setConfig(config) {
    this._config = { view: 'dashboard', entity: 'sensor.zroshua_state', ...config };
    if (!VIEWS.includes(this._config.view)) throw new Error(`view must be one of ${VIEWS.join(', ')}`);
    this._built = false;
    this._sel = null;
    this._filter = 'all';
    this._tileCfg = false;
    this._editUp = null; // upcoming row being edited
    this._editDraft = null; // schedule draft
    this._dragTile = null;
  }

  set hass(hass) {
    this._hass = hass;
    // hass fires on EVERY entity change in HA; re-render only when the hub
    // entity itself changed, otherwise taps die on rebuilt DOM mid-touch.
    const st = this._state();
    if (st === this._lastState && this._built) return;
    this._lastState = st;
    // Keep an open schedule editor draft across hub refreshes.
    if (this._editUp && this._editDraft && st?.attributes) {
      const still = (st.attributes.upcoming || []).find(
        (u) => u.scheduleId === this._editUp.scheduleId && u.targetId === this._editUp.targetId && u.ts === this._editUp.ts,
      );
      if (!still) {
        // Match by schedule+target if ts drifted after save.
        const alt = (st.attributes.upcoming || []).find(
          (u) => u.scheduleId === this._editDraft.id && u.targetId === this._editUp.targetId,
        );
        if (alt) this._editUp = alt;
      }
    }
    this._render();
  }

  getCardSize() {
    return this._config.view === 'timeline' ? 4 : 6;
  }

  static getConfigElement() {
    return document.createElement('zroshua-card-editor');
  }
  static getStubConfig() {
    return { view: 'dashboard' };
  }

  // ---- helpers -----------------------------------------------------------

  _state() {
    if (!this._hass) return null;
    const direct = this._hass.states[this._config.entity];
    if (direct) return direct;
    if (this._foundId && this._hass.states[this._foundId]) return this._hass.states[this._foundId];
    for (const id of Object.keys(this._hass.states)) {
      if (!id.startsWith('sensor.') || !/zroshua/.test(id)) continue;
      const at = this._hass.states[id].attributes;
      if (at && Array.isArray(at.zones) && Array.isArray(at.groups) && Array.isArray(at.upcoming)) {
        this._foundId = id;
        return this._hass.states[id];
      }
    }
    return null;
  }
  _candidates() {
    if (!this._hass) return [];
    return Object.keys(this._hass.states).filter((id) => /^sensor\..*zroshua/.test(id));
  }
  _cmd(action, extra = {}) {
    if (!this._hass) return;
    this._hass.callService('mqtt', 'publish', {
      topic: 'zroshua/command',
      payload: JSON.stringify({ action, ...extra }),
    });
  }

  /** Visible tile ids in display order. */
  _tileLayout() {
    const prefs = this._tilePrefs();
    const hidden = new Set(prefs.hidden || []);
    return (prefs.order || [...DASH_TILE_IDS]).filter((id) => DASH_TILE_IDS.includes(id) && !hidden.has(id));
  }

  _tilePrefs() {
    try {
      const raw = localStorage.getItem(TILE_STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.order)) {
          const order = parsed.order.filter((id) => DASH_TILE_IDS.includes(id));
          for (const id of DASH_TILE_IDS) if (!order.includes(id)) order.push(id);
          return { order, hidden: (parsed.hidden || []).filter((id) => DASH_TILE_IDS.includes(id)) };
        }
      }
    } catch {
      /* ignore */
    }
    if (Array.isArray(this._config.tiles)) {
      const visible = this._config.tiles.filter((id) => DASH_TILE_IDS.includes(id));
      const hidden = DASH_TILE_IDS.filter((id) => !visible.includes(id));
      const order = [...visible, ...hidden];
      return { order, hidden };
    }
    return { order: [...DASH_TILE_IDS], hidden: [...(this._config.hiddenTiles || [])] };
  }

  _saveTilePrefs(prefs) {
    const order = (prefs.order || []).filter((id) => DASH_TILE_IDS.includes(id));
    for (const id of DASH_TILE_IDS) if (!order.includes(id)) order.push(id);
    const hidden = (prefs.hidden || []).filter((id) => DASH_TILE_IDS.includes(id));
    const next = { order, hidden };
    try {
      localStorage.setItem(TILE_STORE_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
    // Persist into Lovelace card config when the dashboard can accept it.
    const visible = order.filter((id) => !hidden.includes(id));
    this._config = { ...this._config, tiles: visible, hiddenTiles: hidden };
    this.dispatchEvent(
      new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }),
    );
  }

  _reorderTile(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    const prefs = this._tilePrefs();
    const order = [...prefs.order];
    const fi = order.indexOf(fromId);
    const ti = order.indexOf(toId);
    if (fi < 0 || ti < 0) return;
    order.splice(fi, 1);
    order.splice(ti, 0, fromId);
    this._saveTilePrefs({ ...prefs, order });
    this._render();
  }
  _fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  _countdown(ts) {
    const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `in ${d}d ${h}h`;
    if (h > 0) return `in ${h}h ${String(m).padStart(2, '0')}m`;
    return `in ${m}m`;
  }
  _left(ts) {
    const m = Math.max(0, Math.round((ts - Date.now()) / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
  }
  _fmtMin(m) {
    const n = Math.max(0, Math.round(Number(m) || 0));
    if (n >= 60) return `${Math.floor(n / 60)}h ${n % 60}m`;
    return `${n} min`;
  }
  _fmtTemp(c, unit = 'C') {
    if (c == null || Number.isNaN(Number(c))) return '—';
    const v = unit === 'F' ? (Number(c) * 9) / 5 + 32 : Number(c);
    return `${Math.round(v)}°${unit}`;
  }
  _volUnit(a) {
    return a.volumeUnit === 'gal' ? 'gal' : 'L';
  }
  _esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  _kindLabel(kind) {
    return (
      {
        run_start: 'Started',
        run_end: 'Ended',
        skip: 'Skipped',
        fault: 'Fault',
        stop_rain: 'Rain stop',
        info: 'Info',
        adjust: 'Adjust',
        system: 'System',
      }[kind] || kind
    );
  }
  _kindCls(kind) {
    return (
      {
        run_start: 'ok',
        run_end: 'accent',
        skip: 'warn',
        fault: 'danger',
        stop_rain: 'warn',
        info: 'muted',
        adjust: 'accent',
        system: 'muted',
      }[kind] || 'muted'
    );
  }
  _btn({ cls = '', data = '', icon = '', label = '', disabled = false, title = '' }) {
    return `<button class="btn ${cls}" ${data} ${disabled ? 'disabled' : ''} title="${this._esc(title)}">
      ${icon ? `<span class="i">${icon}</span>` : ''}${label ? `<span>${this._esc(label)}</span>` : ''}</button>`;
  }
  _status(z) {
    if (z.fault) return { key: 'fault', label: 'fault', cls: 'danger' };
    if (z.running) return { key: 'running', label: z.endsAt ? this._left(z.endsAt) : 'watering', cls: 'ok' };
    if (z.queued) return { key: 'queued', label: 'queued', cls: 'warn' };
    if (z.pausedUntil && z.pausedUntil > Date.now()) return { key: 'paused', label: 'paused', cls: 'warn' };
    if (!z.enabled) return { key: 'off', label: 'off', cls: 'muted' };
    return { key: 'idle', label: `${Math.round(z.baseMin)}m`, cls: 'idle' };
  }

  // ---- render ------------------------------------------------------------

  _render() {
    const a = this._state() ? this._state().attributes : null;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    if (!this._built) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card></ha-card>`;
      this._built = true;
    }
    const card = this.shadowRoot.querySelector('ha-card');
    if (!a) {
      const cands = this._candidates();
      const hint = cands.length
        ? `Found ${cands.map((c) => `<code>${this._esc(c)}</code>`).join(', ')} but no hub state yet &mdash; waiting for data.`
        : `Is the Zroshua add-on running with MQTT? (The add-on Settings page shows the MQTT status.)`;
      card.innerHTML = `<div class="pad muted">Waiting for the Zroshua hub entity. ${hint}</div>`;
      return;
    }
    const title = this._config.title;
    const header = title ? `<div class="hdr">${this._esc(title)}</div>` : '';
    card.innerHTML = header + this['_view_' + this._config.view](a);
    this._wire(card, a);
  }

  _wire(card, a) {
    const on = (sel, fn) => card.querySelectorAll(sel).forEach((el) => (el.onclick = (e) => { e.stopPropagation(); fn(el); }));
    on('[data-run-group]', (el) => this._cmd('run_group', { groupId: el.dataset.runGroup }));
    on('[data-stop-group]', (el) => this._cmd('stop_group', { groupId: el.dataset.stopGroup }));
    on('[data-run-zone]', (el) => {
      this._cmd('run_zone', { zoneId: el.dataset.runZone, minutes: Number(el.dataset.min) || undefined });
      this._sel = null;
      this._render();
    });
    on('[data-stop-zone]', (el) => {
      this._cmd('stop_zone', { zoneId: el.dataset.stopZone });
      if (this._sel) { this._sel = null; this._render(); }
    });
    on('[data-stop-all]', () => this._cmd('stop_all'));
    on('[data-pause-all]', (el) => this._cmd('pause', { hours: Number(el.dataset.pauseAll) }));
    on('[data-extend-zone]', (el) => this._cmd('extend_zone', { zoneId: el.dataset.extendZone, minutes: Number(el.dataset.min) || 5 }));
    on('[data-mq-remove]', (el) => this._cmd('manual_queue_remove', { key: el.dataset.mqRemove }));
    on('[data-mq-clear]', () => this._cmd('manual_queue_clear'));
    on('[data-pause-group]', (el) => {
      this._cmd('pause_group', { groupId: el.dataset.pauseGroup, hours: Number(el.dataset.hours) });
    });
    on('[data-pause-zone]', (el) => {
      this._cmd('pause_zone', { zoneId: el.dataset.pauseZone, hours: Number(el.dataset.hours) });
      if (this._sel) { this._sel = null; this._render(); }
    });
    on('[data-zone-sel]', (el) => {
      const next = this._sel === el.dataset.zoneSel ? null : el.dataset.zoneSel;
      this._openAnim = next !== null && this._sel === null; // animate only on open, not re-render
      this._sel = next;
      this._render();
    });
    on('[data-close-sel]', () => {
      this._sel = null;
      this._render();
    });
    on('[data-filter]', (el) => {
      this._filter = el.dataset.filter;
      this._render();
    });
    on('[data-tile-cfg]', () => {
      this._tileCfg = true;
      this._openAnim = true;
      this._render();
    });
    on('[data-close-tile-cfg]', () => {
      this._tileCfg = false;
      this._render();
    });
    on('[data-tile-toggle]', (el) => {
      const id = el.dataset.tileToggle;
      const prefs = this._tilePrefs();
      const hidden = new Set(prefs.hidden || []);
      if (el.checked) hidden.delete(id);
      else hidden.add(id);
      // Keep at least one tile visible.
      const visible = DASH_TILE_IDS.filter((t) => !hidden.has(t));
      if (!visible.length) return;
      this._saveTilePrefs({ order: prefs.order, hidden: [...hidden] });
      this._render();
    });
    on('[data-tile-reset]', () => {
      this._saveTilePrefs({ order: [...DASH_TILE_IDS], hidden: [] });
      this._render();
    });
    on('[data-edit-up]', (el) => {
      const i = Number(el.dataset.editUp);
      const u = (a.upcoming || []).filter((x) => x.ts > Date.now())[i];
      if (!u?.schedule) return;
      this._editUp = u;
      this._editDraft = JSON.parse(JSON.stringify(u.schedule));
      this._openAnim = true;
      this._sel = null;
      this._tileCfg = false;
      this._render();
    });
    on('[data-close-edit]', () => {
      this._editUp = null;
      this._editDraft = null;
      this._render();
    });
    on('[data-save-schedule]', () => {
      if (!this._editUp || !this._editDraft) return;
      this._cmd('update_schedule', {
        kind: this._editUp.kind === 'zone' ? 'zone' : 'group',
        targetId: this._editUp.targetId,
        schedule: this._editDraft,
      });
      this._editUp = null;
      this._editDraft = null;
      this._render();
    });
    // Schedule draft field edits (keep sheet open).
    card.querySelectorAll('[data-sch-field]').forEach((el) => {
      const apply = () => {
        if (!this._editDraft) return;
        const field = el.dataset.schField;
        if (field === 'enabled') this._editDraft.enabled = el.checked;
        else if (field === 'weekday') {
          const d = Number(el.dataset.day);
          const set = new Set(this._editDraft.weekdays || []);
          if (el.checked) set.add(d);
          else set.delete(d);
          this._editDraft.weekdays = [...set].sort((a, b) => a - b);
        } else if (field === 'start') {
          const i = Number(el.dataset.idx);
          const starts = [...(this._editDraft.starts || [])];
          if (!starts[i]) starts[i] = { start: '06:00' };
          starts[i] = { ...starts[i], start: el.value };
          this._editDraft.starts = starts;
        } else if (field === 'anchor') {
          const i = Number(el.dataset.idx);
          const starts = [...(this._editDraft.starts || [])];
          if (!starts[i]) starts[i] = { start: '06:00' };
          starts[i] = { ...starts[i], anchor: el.value === 'finish' ? 'finish' : 'start' };
          this._editDraft.starts = starts;
        } else if (field === 'zoneDur') {
          const zid = el.dataset.zid;
          this._editDraft.zoneDurations = { ...(this._editDraft.zoneDurations || {}), [zid]: Number(el.value) || 0 };
        } else if (field === 'zoneSel') {
          const zid = el.dataset.zid;
          let sel = this._editDraft.zoneSelection ? [...this._editDraft.zoneSelection] : null;
          // null = all zones; first untick creates explicit list of all except this one
          const allIds = (this._editUp.memberZones || []).map((z) => z.id);
          if (sel == null) sel = el.checked ? null : allIds.filter((id) => id !== zid);
          else {
            if (el.checked && !sel.includes(zid)) sel.push(zid);
            if (!el.checked) sel = sel.filter((id) => id !== zid);
            if (sel.length === allIds.length) sel = null;
          }
          this._editDraft.zoneSelection = sel;
        }
      };
      el.onchange = (e) => {
        e.stopPropagation();
        apply();
        if (el.dataset.schField === 'zoneSel' || el.dataset.schField === 'weekday' || el.dataset.schField === 'enabled') {
          this._render();
        }
      };
      if (el.tagName === 'INPUT' && el.type === 'number') {
        el.oninput = (e) => {
          e.stopPropagation();
          apply();
        };
      }
    });
    on('[data-add-start]', () => {
      if (!this._editDraft) return;
      this._editDraft.starts = [...(this._editDraft.starts || []), { start: '18:00', anchor: 'start' }];
      this._render();
    });
    on('[data-del-start]', (el) => {
      if (!this._editDraft) return;
      const i = Number(el.dataset.delStart);
      this._editDraft.starts = (this._editDraft.starts || []).filter((_, idx) => idx !== i);
      if (!this._editDraft.starts.length) this._editDraft.starts = [{ start: '06:00', anchor: 'start' }];
      this._render();
    });

    // Tile drag-and-drop
    card.querySelectorAll('[data-tile-id]').forEach((el) => {
      el.ondragstart = (e) => {
        this._dragTile = el.dataset.tileId;
        this._didTileDrag = false;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', el.dataset.tileId);
        el.classList.add('dragging');
      };
      el.ondragend = () => {
        el.classList.remove('dragging');
        this._dragTile = null;
        card.querySelectorAll('.tile.drag-over').forEach((x) => x.classList.remove('drag-over'));
      };
      el.ondragover = (e) => {
        e.preventDefault();
        this._didTileDrag = true;
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drag-over');
      };
      el.ondragleave = () => el.classList.remove('drag-over');
      el.ondrop = (e) => {
        e.preventDefault();
        el.classList.remove('drag-over');
        const from = e.dataTransfer.getData('text/plain') || this._dragTile;
        this._reorderTile(from, el.dataset.tileId);
      };
    });
  }

  _chip(txt, cls = '', icon = '') {
    return `<span class="chip ${cls}">${icon ? `<span class="ci">${icon}</span>` : ''}${this._esc(txt)}</span>`;
  }

  // ---- views -------------------------------------------------------------

  _view_dashboard(a) {
    const vol = this._volUnit(a);
    const tempUnit = a.tempUnit === 'F' ? 'F' : 'C';
    const zones = a.zones || [];
    const groups = a.groups || [];
    const enabledZones = zones.filter((z) => z.enabled).length;
    const enabledGroups = groups.filter((g) => g.enabled).length;
    const nextList = (a.upcoming || []).filter((u) => u.ts > Date.now()).slice(0, 6);
    const next = nextList[0];

    const tileData = {
      watering_now: {
        label: 'Watering now',
        value: String((a.active || []).length),
        sub: (a.queue || []).length ? `${a.queue.length} queued` : '',
        icon: I.drop,
        cls: 'ok',
      },
      zones: { label: 'Zones', value: `${enabledZones}/${zones.length}`, sub: 'enabled / total', icon: I.plant, cls: 'ok' },
      groups: { label: 'Groups', value: String(groups.length), sub: `${enabledGroups} enabled`, icon: I.group, cls: 'accent' },
      today_water: { label: 'Today water', value: `${a.litersToday ?? 0} ${vol}`, sub: '', icon: I.bucket, cls: 'idle' },
      today_time: { label: 'Today time', value: this._fmtMin(a.minutesToday ?? 0), sub: 'completed runs', icon: I.clock, cls: 'warn' },
      next_watering: {
        label: 'Next watering',
        value: next ? this._countdown(next.ts) : '—',
        sub: next ? `${this._fmtTime(next.ts)} · ${this._esc(next.groupName)}` : '',
        icon: I.clock,
        cls: 'accent',
      },
    };

    const tilesHtml = this._tileLayout()
      .map((id) => {
        const t = tileData[id];
        if (!t) return '';
        return `<div class="tile" draggable="true" data-tile-id="${id}" title="Drag to reorder">
          <span class="ti ${t.cls}">${t.icon}</span>
          <div class="grow"><span class="muted small">${t.label}</span><b>${t.value}</b>${
            t.sub ? `<div class="muted tiny">${t.sub}</div>` : ''
          }</div>
        </div>`;
      })
      .join('');

    const active = (a.active || [])
      .map((r) => {
        const pct = Math.round((r.progress || 0) * 100);
        return `<div class="row tap" data-zone-sel="${this._esc(r.zoneId)}">
          <div class="grow"><b>${this._esc(r.zoneName)}</b> ${this._chip(r.triggeredBy)}
            <div class="bar"><div style="width:${pct}%"></div></div></div>
          <span class="muted small">${this._left(r.endsAt)}</span>
          ${this._btn({ cls: 'ghost icon', data: `data-extend-zone="${this._esc(r.zoneId)}" data-min="5"`, icon: I.plus, title: '+5 min' })}
          ${this._btn({ cls: 'danger icon', data: `data-stop-zone="${this._esc(r.zoneId)}"`, icon: I.stop, title: 'Stop' })}
        </div>`;
      })
      .join('');

    const queue = (a.queue || [])
      .map(
        (q) =>
          `<div class="row small tap" data-zone-sel="${this._esc(q.zoneId)}"><span class="grow">${this._esc(q.zoneName)} &mdash; ${Math.round(
            q.durationMin,
          )} min</span>${this._chip(q.waitReason, 'muted')}</div>`,
      )
      .join('');

    const upcoming = nextList
      .map((u, i) => {
        const dim = u.willSkip || u.paused ? 'dim' : '';
        const kindAttr = u.kind === 'zone' ? 'data-pause-zone' : 'data-pause-group';
        const target = u.kind === 'zone' ? u.targetId : u.groupId;
        const skipHours = Math.max(0.05, (u.ts + 60000 - Date.now()) / 3600000);
        const pauseBtn = u.paused
          ? this._btn({ cls: 'ghost icon', data: `${kindAttr}="${this._esc(target)}" data-hours="0"`, icon: I.play, title: 'Resume' })
          : this._btn({
              cls: 'ghost icon',
              data: `${kindAttr}="${this._esc(target)}" data-hours="${skipHours}"`,
              icon: I.pause,
              title: 'Skip this run',
            });
        const badge = u.paused
          ? this._chip('paused', 'warn', I.pause)
          : u.willSkip
            ? this._chip(u.skipReason ? `will skip: ${u.skipReason}` : 'will skip', 'danger', I.warn)
            : u.maybeSkip
              ? this._chip(`may skip: ${u.maybeSkip}`, 'warn')
              : '';
        const zonesTxt = (u.zones || []).join(', ');
        const editable = !!u.schedule;
        return `<div class="uprow ${dim} ${editable ? 'tap' : ''}" ${editable ? `data-edit-up="${i}"` : ''} title="${
          editable ? 'Edit schedule' : ''
        }">
          <div class="uptop">
            <div class="grow">
              <div class="upname"><b>${this._esc(u.groupName)}</b>${u.kind === 'zone' ? ' <span class="ztag">zone</span>' : ''}</div>
              ${zonesTxt && u.kind !== 'zone' ? `<div class="muted small">${this._esc(zonesTxt)}</div>` : ''}
              ${badge}
            </div>
            <div class="upmeta">
              <span class="muted small nowrap">${u.minutes != null ? `${u.minutes}m` : ''}</span>
              ${this._chip(this._countdown(u.ts), 'accent')}
              <span class="muted small nowrap">${this._fmtTime(u.ts)}</span>
              ${pauseBtn}
            </div>
          </div>
        </div>`;
      })
      .join('');

    const w = a.weather;
    const forecast = ((w && w.forecast) || [])
      .slice(0, 7)
      .map((f, i) => {
        const day = new Date(Date.now() + i * 86400000).toLocaleDateString([], { weekday: 'short' });
        return `<div class="fc"><span class="muted tiny">${day}</span><b>${this._fmtTemp(f.tempMaxC, tempUnit)}</b><span class="tiny info">${
          f.precipProb != null ? `${f.precipProb}%` : ''
        }</span></div>`;
      })
      .join('');
    const weatherBlock = w?.entity
      ? `<div class="sec">Weather</div>
         <div class="wx"><b class="wx-temp">${this._fmtTemp(w.temperatureC, tempUnit)}</b>
           <span class="muted">${this._esc(w.condition || '')}</span>
           ${w.humidity != null ? `<span class="muted">💧 ${w.humidity}%</span>` : ''}
         </div>
         <div class="fcgrid">${forecast}</div>`
      : '';

    const pumps = (a.pumpStates || [])
      .map((p) => this._chip(p.on ? `pump ${p.name}: ON` : `pump ${p.name}: off`, p.on ? 'ok' : 'muted'))
      .join('');
    const levels = (a.sourceLevels || [])
      .map((l) => {
        const pct = l.levelPct ?? 0;
        const col = pct < 20 ? 'danger' : pct < 40 ? 'warn' : 'idle';
        const label =
          l.levelDisplay != null ? `~${l.levelDisplay} ${vol} (${pct}%)` : l.levelPct != null ? `${pct}%` : '—';
        return `<div class="lvl"><div class="lvlh"><span class="muted small">${this._esc(l.name)}</span><span class="muted tiny">${label}</span></div>
          <div class="bar"><div class="${col}" style="width:${pct}%"></div></div></div>`;
      })
      .join('');

    const mq = a.manualQueue || [];
    const mqRows = mq
      .map(
        (q) =>
          `<div class="row small"><span class="grow">${this._chip(`#${q.position}`, 'muted')} <b>${this._esc(q.zoneName)}</b>
            <span class="muted small"> · ${Math.round(q.durationMin)}m${q.waitReason ? ` · ${this._esc(q.waitReason)}` : ''}</span></span>
            ${this._btn({ cls: 'ghost icon', data: `data-mq-remove="${this._esc(q.key)}"`, icon: I.x, title: 'Remove from queue' })}</div>`,
      )
      .join('');

    const journal = (a.journal || [])
      .slice(0, 12)
      .map((e) => {
        const when = new Date(e.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return `<div class="jrow">
          <div class="grow">
            ${this._chip(this._kindLabel(e.kind) + (e.code ? `: ${e.code}` : ''), this._kindCls(e.kind))}
            ${e.target ? `<b class="jtarget">${this._esc(e.target)}</b>` : ''}
            ${e.detail ? `<div class="muted small jdetail">${this._esc(e.detail)}</div>` : ''}
          </div>
          <span class="muted tiny nowrap">${when}</span>
        </div>`;
      })
      .join('');

    return `
      <div class="pad dash">
        <div class="dash-tools">
          <span class="muted tiny">Drag tiles to reorder</span>
          ${this._btn({ cls: 'ghost icon', data: 'data-tile-cfg', icon: I.gear, title: 'Choose tiles' })}
        </div>
        <div class="tiles tiles6">${tilesHtml || '<div class="muted">No tiles selected — open tile settings.</div>'}</div>

        <div class="panel">
          <div class="sec top">Now</div>
          ${active || '<div class="muted">Nothing is watering right now.</div>'}
          ${queue ? `<div class="sec">Queue</div>${queue}` : ''}
        </div>

        <div class="panel">
          <div class="sec top">Upcoming waterings</div>
          <div class="muted tiny" style="margin-bottom:6px">Tap a row to edit schedule &amp; zone timings</div>
          ${upcoming || '<div class="muted">No scheduled waterings in the next 7 days.</div>'}
        </div>

        ${weatherBlock ? `<div class="panel">${weatherBlock}</div>` : ''}

        <div class="panel">
          <div class="sec top">Quick actions</div>
          <div class="actions">
            ${this._btn({ cls: 'danger', data: 'data-stop-all', icon: I.stop, label: 'Stop all' })}
            ${
              a.snoozeUntil
                ? this._btn({
                    cls: 'ghost',
                    data: 'data-pause-all="0"',
                    icon: I.play,
                    label: `Resume (paused till ${this._fmtTime(a.snoozeUntil)})`,
                  })
                : this._btn({ cls: 'ghost', data: 'data-pause-all="24"', icon: I.pause, label: 'Pause 24h' })
            }
          </div>
          ${pumps ? `<div class="pumps">${pumps}</div>` : ''}
          ${levels ? `<div class="levels">${levels}</div>` : ''}
        </div>

        <div class="panel">
          <div class="sec top rowish"><span>Manual queue</span>
            ${mq.length ? this._btn({ cls: 'ghost', data: 'data-mq-clear', icon: I.x, label: 'Clear' }) : ''}
          </div>
          ${mqRows || '<div class="muted small">No manual runs queued. Tap a zone while watering to add more, or use Water now.</div>'}
        </div>

        <div class="panel">
          <div class="sec top">Journal</div>
          <div class="journal">${journal || '<div class="muted">No journal entries yet.</div>'}</div>
        </div>

        ${this._sheet(a)}
        ${this._tileCfgSheet()}
        ${this._scheduleSheet()}
      </div>`;
  }

  _tileCfgSheet() {
    if (!this._tileCfg) return '';
    const prefs = this._tilePrefs();
    const hidden = new Set(prefs.hidden || []);
    const anim = this._openAnim ? ' anim' : '';
    this._openAnim = false;
    const rows = DASH_TILES.map(
      (t) => `<label class="tcfg-row">
        <input type="checkbox" data-tile-toggle="${t.id}" ${hidden.has(t.id) ? '' : 'checked'} />
        <span>${this._esc(t.label)}</span>
      </label>`,
    ).join('');
    return `<div class="ovl" data-close-tile-cfg></div><div class="sheet sheet-wide${anim}">
      <div class="shead">
        <div class="grow"><b>Dashboard tiles</b><div class="muted small">Show / hide tiles. Drag tiles on the card to reorder.</div></div>
        ${this._btn({ cls: 'ghost icon', data: 'data-close-tile-cfg', icon: I.x, title: 'Close' })}
      </div>
      <div class="tcfg">${rows}</div>
      <div class="srow" style="margin-top:10px">
        ${this._btn({ cls: 'ghost', data: 'data-tile-reset', label: 'Reset defaults' })}
        ${this._btn({ cls: 'primary', data: 'data-close-tile-cfg', label: 'Done' })}
      </div>
    </div>`;
  }

  _scheduleSheet() {
    const u = this._editUp;
    const s = this._editDraft;
    if (!u || !s) return '';
    const anim = this._openAnim ? ' anim' : '';
    this._openAnim = false;
    const days = [
      [1, 'Mon'],
      [2, 'Tue'],
      [3, 'Wed'],
      [4, 'Thu'],
      [5, 'Fri'],
      [6, 'Sat'],
      [0, 'Sun'],
    ];
    const wd = new Set(s.weekdays || []);
    const dayChips = days
      .map(
        ([d, label]) =>
          `<label class="daychip"><input type="checkbox" data-sch-field="weekday" data-day="${d}" ${
            wd.has(d) ? 'checked' : ''
          }/><span>${label}</span></label>`,
      )
      .join('');
    const starts = (s.starts || [{ start: '06:00' }])
      .map(
        (st, i) => `<div class="sch-start">
        <input type="time" data-sch-field="start" data-idx="${i}" value="${this._esc(st.start || '06:00')}" />
        <select data-sch-field="anchor" data-idx="${i}">
          <option value="start" ${st.anchor !== 'finish' ? 'selected' : ''}>Start at</option>
          <option value="finish" ${st.anchor === 'finish' ? 'selected' : ''}>Finish by</option>
        </select>
        ${this._btn({ cls: 'ghost icon', data: `data-del-start="${i}"`, icon: I.x, title: 'Remove' })}
      </div>`,
      )
      .join('');
    const members = u.memberZones || [];
    const sel = s.zoneSelection;
    const zoneRows = members
      .map((z) => {
        const included = !sel || sel.includes(z.id);
        const dur = s.zoneDurations?.[z.id] ?? z.baseMin;
        return `<div class="sch-zone">
          <label class="sch-zone-on"><input type="checkbox" data-sch-field="zoneSel" data-zid="${this._esc(z.id)}" ${
            included ? 'checked' : ''
          }/> <b>${this._esc(z.name)}</b></label>
          <label class="sch-dur">min <input type="number" min="1" max="${z.maxMin || 999}" step="1"
            data-sch-field="zoneDur" data-zid="${this._esc(z.id)}" value="${Math.round(dur)}" ${included ? '' : 'disabled'}/></label>
        </div>`;
      })
      .join('');
    const modeNote =
      s.mode === 'per_day'
        ? `<div class="muted small" style="margin:6px 0">This schedule uses per-day times. Weekday chips &amp; starts below edit the shared week template; open the add-on for full per-day editing.</div>`
        : '';
    return `<div class="ovl" data-close-edit></div><div class="sheet sheet-wide${anim}">
      <div class="shead">
        <div class="grow">
          <b>${this._esc(u.groupName)}</b>
          <div class="muted small">${u.kind === 'zone' ? 'Zone schedule' : 'Group schedule'} · ${this._fmtTime(u.ts)} · ${this._countdown(u.ts)}</div>
        </div>
        ${this._btn({ cls: 'ghost icon', data: 'data-close-edit', icon: I.x, title: 'Close' })}
      </div>
      <label class="tcfg-row"><input type="checkbox" data-sch-field="enabled" ${s.enabled !== false ? 'checked' : ''}/> <span>Schedule enabled</span></label>
      ${modeNote}
      <div class="sec">Days</div>
      <div class="dayrow">${dayChips}</div>
      <div class="sec">Start times</div>
      ${starts}
      <div class="srow" style="margin-top:6px">${this._btn({ cls: 'ghost', data: 'data-add-start', icon: I.plus, label: 'Add time' })}</div>
      <div class="sec">Zones &amp; durations</div>
      <div class="muted tiny" style="margin-bottom:6px">Untick a zone to leave it out of this schedule. Duration is minutes for this schedule only.</div>
      ${zoneRows || '<div class="muted">No zones</div>'}
      <div class="srow" style="margin-top:12px">
        ${this._btn({ cls: 'ghost', data: 'data-close-edit', label: 'Cancel' })}
        ${this._btn({ cls: 'primary', data: 'data-save-schedule', label: 'Save schedule' })}
      </div>
    </div>`;
  }

  _view_groups(a) {
    const tiles = (a.groups || [])
      .map((g) => {
        const paused = g.pausedUntil && g.pausedUntil > Date.now();
        const state = g.running ? 'run' : paused ? 'paused' : g.enabled ? 'idle' : 'off';
        const modeIcon = g.mode === 'sequential' ? I.seq : I.par;
        const modeLabel =
          g.mode === 'sequential' ? 'Sequential' : g.mode === 'parallel_limit' ? `Parallel &times;${g.parallelLimit || 2}` : 'Parallel';
        const modeChip = `<span class="gchip" title="Execution mode: ${modeLabel}"><span class="ci">${modeIcon}</span>${modeLabel}</span>`;
        const pauseBtn = paused
          ? this._btn({ cls: 'ghost icon', data: `data-pause-group="${this._esc(g.id)}" data-hours="0"`, icon: I.play, title: 'Resume group' })
          : this._btn({ cls: 'ghost icon', data: `data-pause-group="${this._esc(g.id)}" data-hours="12"`, icon: I.pause, title: 'Pause group 12h' });
        const nextRow = g.running
          ? `<div class="gnext ok"><span class="ci">${I.drop}</span>${g.activeZones != null ? `${g.activeZones} watering` : 'watering'}${g.queuedZones ? ` &middot; ${g.queuedZones} queued` : ''}</div>
             <div class="shimmer"></div>`
          : paused
            ? `<div class="gnext warn"><span class="ci">${I.pause}</span>paused &middot; until ${this._fmtTime(g.pausedUntil)}</div>`
            : g.nextTs
              ? `<div class="gnext"><span class="ci">${I.clock}</span>${this._countdown(g.nextTs)} &middot; ${this._fmtTime(g.nextTs)}${g.nextMinutes ? ` &middot; ${g.nextMinutes}m` : ''}</div>`
              : `<div class="gnext muted"><span class="ci">${I.clock}</span>no schedule</div>`;
        const btn = g.running
          ? this._btn({ cls: 'danger block', data: `data-stop-group="${this._esc(g.id)}"`, icon: I.stop, label: 'Stop group' })
          : this._btn({ cls: 'primary block', data: `data-run-group="${this._esc(g.id)}"`, icon: I.play, label: 'Run', disabled: !g.enabled });
        return `<div class="gtile ${state}">
          <div class="ghead">
            <span class="gname" title="${this._esc(g.name)}">${this._esc(g.name)}</span>
            <span class="ghead-actions">${pauseBtn}</span>
          </div>
          <div class="gmeta muted small">${modeChip}<span>${g.zoneCount} zones &middot; ${g.schedules} schedule${g.schedules === 1 ? '' : 's'}${g.enabled ? '' : ' &middot; disabled'}</span></div>
          ${nextRow}
          ${btn}
        </div>`;
      })
      .join('');
    return `<div class="pad"><div class="ggrid">${tiles || '<div class="muted">No groups.</div>'}</div></div>`;
  }

  _view_zones(a) {
    const zones = a.zones || [];
    const groups = a.groups || [];
    const counts = {
      all: zones.length,
      running: zones.filter((z) => z.running || z.queued).length,
      idle: zones.filter((z) => z.enabled && !z.running && !z.queued).length,
      off: zones.filter((z) => !z.enabled).length,
    };
    const show = (z) =>
      this._filter === 'all'
        ? true
        : this._filter === 'running'
          ? z.running || z.queued
          : this._filter === 'idle'
            ? z.enabled && !z.running && !z.queued
            : !z.enabled;

    const filters = [
      ['all', `All ${counts.all}`],
      ['running', `Active ${counts.running}`],
      ['idle', `Idle ${counts.idle}`],
      ['off', `Off ${counts.off}`],
    ]
      .map(([k, l]) => `<button class="fchip ${this._filter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`)
      .join('');

    const chipFor = (z) => {
      const st = this._status(z);
      const sel = this._sel === z.id ? 'sel' : '';
      return `<button class="zchip ${st.key} ${sel}" data-zone-sel="${this._esc(z.id)}" title="${this._esc(z.name)}">
        <span class="zi">${zoneIcon(z.type)}</span>
        <span class="zn">${this._esc(z.name)}</span>
        <span class="zs ${st.cls}"><span class="dot"></span>${st.label}</span>
      </button>`;
    };

    const seen = new Set();
    const sections = groups
      .map((g) => {
        const list = zones.filter((z) => (z.groupIds || []).includes(g.id) && show(z));
        list.forEach((z) => seen.add(z.id));
        if (!list.length) return '';
        const runningN = list.filter((z) => z.running).length;
        return `<div class="zsec">
          <div class="zhead"><span>${this._esc(g.name)}</span><span class="muted small">${list.length}${runningN ? ` &middot; ${runningN} watering` : ''}</span></div>
          <div class="zgrid">${list.map(chipFor).join('')}</div>
        </div>`;
      })
      .join('');
    const rest = zones.filter((z) => !seen.has(z.id) && !(z.groupIds || []).length && show(z));
    const restSec = rest.length
      ? `<div class="zsec"><div class="zhead"><span>Ungrouped</span><span class="muted small">${rest.length}</span></div>
         <div class="zgrid">${rest.map(chipFor).join('')}</div></div>`
      : '';

    return `<div class="pad">
      <div class="fbar">${filters}</div>
      ${sections + restSec || '<div class="muted">No zones match this filter.</div>'}
      ${this._sheet(a)}
    </div>`;
  }

  /** Action sheet for the selected zone: a fixed overlay above the viewport,
   *  so on a long list nothing scrolls or shifts — it pops over where you are.
   *  Shared by the zones and dashboard views. */
  _sheet(a) {
    const z = (a.zones || []).find((x) => x.id === this._sel);
    if (!z) return '';
    const st = this._status(z);
    const base = Math.round(z.baseMin) || 10;
    const presets = [...new Set([5, 10, 15, base])].sort((x, y) => x - y).filter((m) => m <= (z.maxMin || 999));
    const paused = z.pausedUntil && z.pausedUntil > Date.now();
    const anim = this._openAnim ? ' anim' : '';
    this._openAnim = false;
    const pauseRow = paused
      ? this._btn({ cls: 'ghost block', data: `data-pause-zone="${this._esc(z.id)}" data-hours="0"`, icon: I.play, label: `Resume (paused till ${this._fmtTime(z.pausedUntil)})` })
      : this._btn({ cls: 'ghost block', data: `data-pause-zone="${this._esc(z.id)}" data-hours="12"`, icon: I.pause, label: 'Pause 12h' });
    return `<div class="ovl" data-close-sel></div><div class="sheet${anim}">
      <div class="shead">
        <span class="zi big">${zoneIcon(z.type)}</span>
        <div class="grow"><b>${this._esc(z.name)}</b><div class="zs ${paused ? 'warn' : st.cls} small"><span class="dot"></span>${paused ? 'paused' : st.label}</div></div>
        ${this._btn({ cls: 'ghost icon', data: 'data-close-sel', icon: I.x, title: 'Close' })}
      </div>
      ${
        z.running
          ? `<div class="srow">${this._btn({ cls: 'danger block', data: `data-stop-zone="${this._esc(z.id)}"`, icon: I.stop, label: 'Stop watering' })}</div>`
          : `<div class="srow">
              ${presets
                .map((m) =>
                  this._btn({
                    cls: m === base ? 'primary' : 'ghost',
                    data: `data-run-zone="${this._esc(z.id)}" data-min="${m}"`,
                    icon: I.play,
                    label: `${m}m`,
                    disabled: !z.enabled,
                  }),
                )
                .join('')}
            </div>`
      }
      <div class="srow" style="margin-top:7px">${pauseRow}</div>
    </div>`;
  }

  _view_upcoming(a) {
    const rows = (a.upcoming || [])
      .filter((u) => u.ts > Date.now())
      .map((u) => {
        const skip = u.paused
          ? `<div class="skiprow warn"><span class="ci">${I.pause}</span>paused</div>`
          : u.willSkip
            ? `<div class="skiprow danger">${I.warn ? `<span class="ci">${I.warn}</span>` : ''}will skip: ${this._esc(u.skipReason || '')}</div>`
            : u.maybeSkip
              ? `<div class="skiprow warn">may skip: ${this._esc(u.maybeSkip)}</div>`
              : '';
        const tag = u.kind === 'zone' ? ' <span class="ztag">zone</span>' : '';
        const target = u.kind === 'zone' ? u.targetId : u.groupId;
        const kindAttr = u.kind === 'zone' ? 'data-pause-zone' : 'data-pause-group';
        // skip just this run: pause the target until a minute past its start
        const skipHours = Math.max(0.05, (u.ts + 60000 - Date.now()) / 3600000);
        const pauseBtn = u.paused
          ? this._btn({ cls: 'ghost icon', data: `${kindAttr}="${this._esc(target)}" data-hours="0"`, icon: I.play, title: 'Resume' })
          : this._btn({ cls: 'ghost icon', data: `${kindAttr}="${this._esc(target)}" data-hours="${skipHours}"`, icon: I.pause, title: 'Skip this run' });
        const zones = (u.zones || []).join(', ');
        return `<div class="uprow ${u.willSkip || u.paused ? 'dim' : ''}">
          <div class="uptop">
            <span class="ci accent">${I.clock}</span>
            <div class="grow">
              <div class="upname"><b>${this._esc(u.groupName)}</b>${tag}</div>
              ${zones ? `<div class="muted small">${this._esc(zones)}</div>` : ''}
            </div>
            <div class="upmeta">
              <span class="muted small nowrap">${u.minutes}m</span>
              ${this._chip(this._countdown(u.ts), 'accent')}
              <span class="muted small nowrap">${this._fmtTime(u.ts)}</span>
              ${pauseBtn}
            </div>
          </div>
          ${skip}
        </div>`;
      })
      .join('');
    return `<div class="pad">${rows || '<div class="muted">Nothing scheduled in the next 7 days.</div>'}</div>`;
  }

  _view_timeline(a) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const from = dayStart.getTime();
    const to = from + 86400000;
    const segs = (a.timeline || []).filter((s) => s.s < to && s.e > from);
    const envs = (a.timelineEnv || []).filter((e) => e.s < to && e.w > from);
    const byGroup = new Map();
    for (const s of segs) byGroup.set(s.g, [...(byGroup.get(s.g) || []), s]);
    for (const e of envs) if (!byGroup.has(e.g)) byGroup.set(e.g, []);
    const pct = (ts) => Math.max(0, Math.min(100, ((ts - from) / 86400000) * 100));
    const nowPct = pct(Date.now());
    const rows = [...byGroup.entries()]
      .map(([g, list]) => {
        const bars = list
          .map(
            (s) =>
              `<div class="tlbar ${s.c ? 'conflict' : s.k === 'z' ? 'zone' : ''}" title="${this._esc(s.z)} ${this._fmtTime(s.s)}–${this._fmtTime(s.e)}" style="left:${pct(s.s)}%;width:${Math.max(0.6, pct(s.e) - pct(s.s))}%"></div>`,
          )
          .join('');
        // finish window: hatched worst-case tail + tick at the planned end
        const tails = envs
          .filter((e) => e.g === g && e.w > e.e)
          .map(
            (e) =>
              `<div class="tlboost" title="up to ${this._fmtTime(e.w)} with temp boost" style="left:${pct(e.e)}%;width:${Math.max(0.4, pct(e.w) - pct(e.e))}%"></div>` +
              `<div class="tltick" style="left:${pct(e.e)}%"></div>`,
          )
          .join('');
        return `<div class="tlrow"><span class="tllabel" title="${this._esc(g)}">${this._esc(g)}</span><div class="tltrack">${bars}${tails}<div class="tlnow" style="left:${nowPct}%"></div></div></div>`;
      })
      .join('');
    const scale = [0, 4, 8, 12, 16, 20, 24].map((h) => `<span>${String(h).padStart(2, '0')}</span>`).join('');
    return `<div class="pad">
      <div class="tlscale"><span class="tllabel"></span><div class="tlticks">${scale}</div></div>
      ${rows || '<div class="muted">Nothing scheduled today.</div>'}
      <div class="tllegend">${this._chip('group', 'ok')}${this._chip('zone', 'accent')}${this._chip('conflict', 'danger')}</div>
    </div>`;
  }
}

const STYLE = `
  :host { --z-ok:#12b886; --z-warn:#f0a105; --z-danger:#fa5252; --z-accent:#9775fa; --z-info:#4dabf7;
    -webkit-tap-highlight-color: transparent; }
  button { -webkit-tap-highlight-color: transparent; }
  ha-card { overflow: hidden; container-type: inline-size; }
  .pad { padding: 12px 16px 16px; }
  .hdr { padding: 14px 16px 0; font-size: 1.15rem; font-weight: 600; }
  .muted { color: var(--secondary-text-color); }
  .small { font-size: .82rem; }
  .grow { flex: 1; min-width: 0; }
  .sec { margin: 12px 0 6px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--divider-color); }
  .row.tap { cursor: pointer; border-radius: 10px; margin: 0 -6px; padding: 8px 6px; transition: background .12s; }
  @media (hover: hover) { .row.tap:hover { background: color-mix(in srgb, var(--secondary-background-color) 55%, transparent); } }
  .row.tap:active { background: color-mix(in srgb, var(--secondary-background-color) 75%, transparent); }
  .row:last-of-type { border-bottom: 0; }
  code { background: var(--secondary-background-color); padding: 1px 5px; border-radius: 4px; }

  /* icons */
  .i, .ci, .zi, .ti { display: inline-flex; }
  .i svg, .ci svg { width: 15px; height: 15px; fill: currentColor; }
  .ci { margin-right: 6px; vertical-align: -2px; }
  .ci.accent { color: var(--z-accent); }

  /* buttons */
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    border: none; border-radius: 12px; padding: 9px 15px; font-weight: 600; font-size: .88rem;
    cursor: pointer; color: var(--primary-text-color); background: var(--secondary-background-color);
    transition: transform .12s ease, box-shadow .12s ease, filter .12s ease; }
  @media (hover: hover) {
    .btn:hover:not([disabled]) { transform: translateY(-1px); filter: brightness(1.12); box-shadow: 0 3px 10px rgba(0,0,0,.35); }
  }
  .btn:active:not([disabled]) { transform: translateY(0) scale(.97); }
  .btn:focus { outline: none; }
  .btn:focus-visible { outline: 2px solid var(--z-info); outline-offset: 2px; }
  .btn[disabled] { opacity: .38; cursor: default; }
  .btn.primary { background: linear-gradient(140deg, #14c08c, #0b9e74); color: #fff; box-shadow: 0 2px 8px rgba(18,184,134,.35); }
  .btn.danger { background: linear-gradient(140deg, #f75b5b, #d63c3c); color: #fff; }
  .btn.ghost { background: color-mix(in srgb, var(--secondary-background-color) 80%, transparent);
    border: 1px solid var(--divider-color); }
  .btn.icon { padding: 8px; border-radius: 50%; }
  .btn.block { width: 100%; }

  /* chips */
  .chip { display: inline-flex; align-items: center; font-size: .72rem; padding: 2px 9px; border-radius: 999px; margin-left: 4px;
    background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .chip .ci svg { width: 12px; height: 12px; }
  .chip.ok { background: color-mix(in srgb, var(--z-ok) 18%, transparent); color: var(--z-ok); }
  .chip.warn { background: color-mix(in srgb, var(--z-warn) 18%, transparent); color: var(--z-warn); }
  .chip.danger { background: color-mix(in srgb, var(--z-danger) 18%, transparent); color: var(--z-danger); }
  .chip.accent { background: color-mix(in srgb, var(--z-accent) 18%, transparent); color: var(--z-accent); }

  .bar { height: 6px; border-radius: 4px; background: var(--divider-color); margin-top: 6px; overflow: hidden; }
  .bar div { height: 100%; background: linear-gradient(90deg, #14c08c, #0b9e74); }
  .bar div.warn { background: linear-gradient(90deg, #fcc419, #f59f00); }
  .bar div.danger { background: linear-gradient(90deg, #ff8787, #fa5252); }
  .bar div.idle { background: linear-gradient(90deg, #74c0fc, #4dabf7); }

  /* dashboard tiles */
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .tiles6 { grid-template-columns: repeat(2, 1fr); }
  @container (min-width: 520px) { .tiles6 { grid-template-columns: repeat(3, 1fr); } }
  @container (min-width: 780px) { .tiles6 { grid-template-columns: repeat(6, 1fr); } }
  .tile { display: flex; align-items: center; gap: 10px; background: var(--secondary-background-color);
    border-radius: 14px; padding: 10px 12px; min-width: 0; cursor: grab; user-select: none;
    transition: box-shadow .12s, outline .12s; }
  .tile b { display: block; font-size: 1.05rem; line-height: 1.15; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile .tiny { margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ti { width: 34px; height: 34px; border-radius: 10px; align-items: center; justify-content: center; flex-shrink: 0; }
  .ti svg { width: 18px; height: 18px; fill: currentColor; }
  .ti.ok { background: color-mix(in srgb, var(--z-ok) 16%, transparent); color: var(--z-ok); }
  .ti.warn { background: color-mix(in srgb, var(--z-warn) 16%, transparent); color: var(--z-warn); }
  .ti.idle { background: color-mix(in srgb, var(--z-info) 16%, transparent); color: var(--z-info); }
  .ti.accent { background: color-mix(in srgb, var(--z-accent) 16%, transparent); color: var(--z-accent); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .dash .panel { border: 1px solid var(--divider-color); border-radius: 14px; padding: 10px 12px 12px; margin-bottom: 10px;
    background: color-mix(in srgb, var(--secondary-background-color) 35%, transparent); }
  .sec.top { margin-top: 0; }
  .rowish { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .dash-tools { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-bottom: 6px; }
  .tile.dragging { opacity: .55; cursor: grabbing; }
  .tile.drag-over { outline: 2px solid var(--z-info); outline-offset: 1px; }
  .sheet-wide { width: min(520px, calc(100vw - 20px)); max-height: min(85vh, 720px); overflow: auto; }
  .tcfg { display: flex; flex-direction: column; gap: 8px; }
  .tcfg-row { display: flex; align-items: center; gap: 10px; padding: 8px 4px; cursor: pointer;
    border-bottom: 1px solid var(--divider-color); font-weight: 600; }
  .tcfg-row:last-child { border-bottom: 0; }
  .tcfg-row input { width: 18px; height: 18px; accent-color: var(--z-ok); }
  .dayrow { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .daychip { display: inline-flex; align-items: center; gap: 4px; padding: 5px 8px; border-radius: 999px;
    border: 1px solid var(--divider-color); font-size: .8rem; font-weight: 600; cursor: pointer; }
  .daychip input { accent-color: var(--z-ok); }
  .sch-start { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
  .sch-start input[type=time], .sch-start select, .sch-dur input {
    padding: 7px 8px; border-radius: 8px; border: 1px solid var(--divider-color);
    background: var(--card-background-color); color: var(--primary-text-color); }
  .sch-zone { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0;
    border-bottom: 1px solid var(--divider-color); flex-wrap: wrap; }
  .sch-zone-on { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .sch-dur { display: flex; align-items: center; gap: 6px; font-size: .85rem; color: var(--secondary-text-color); }
  .sch-dur input { width: 72px; }
  .uprow.tap { cursor: pointer; border-radius: 10px; margin: 0 -6px; padding: 8px 6px; transition: background .12s; }
  @media (hover: hover) { .uprow.tap:hover { background: color-mix(in srgb, var(--secondary-background-color) 55%, transparent); } }
  .tiny { font-size: .72rem; }
  .info { color: var(--z-info); }
  .wx { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .wx-temp { font-size: 1.45rem; }
  .fcgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(42px, 1fr)); gap: 4px; }
  .fc { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 4px 2px;
    border-radius: 8px; background: color-mix(in srgb, var(--secondary-background-color) 70%, transparent); }
  .pumps { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .pumps .chip { margin-left: 0; }
  .levels { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .lvlh { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 2px; }
  .journal { max-height: 280px; overflow: auto; }
  .jrow { display: flex; justify-content: space-between; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--divider-color); }
  .jrow:last-child { border-bottom: 0; }
  .jtarget { font-size: .85rem; margin-left: 4px; }
  .jdetail { margin-top: 3px; overflow-wrap: anywhere; }

  /* group tiles */
  .ggrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(215px, 1fr)); gap: 10px; }
  .gtile { position: relative; border: 1px solid var(--divider-color); border-radius: 16px; padding: 12px 14px 14px;
    background: color-mix(in srgb, var(--secondary-background-color) 55%, transparent);
    display: flex; flex-direction: column; gap: 7px; overflow: hidden; }
  .gtile.run { border-color: color-mix(in srgb, var(--z-ok) 55%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--z-ok) 40%, transparent); }
  .gtile.paused { border-color: color-mix(in srgb, var(--z-warn) 45%, transparent); }
  .gtile.off { opacity: .55; }
  .ghead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .ghead-actions { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .gname { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gmeta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }
  .gchip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px;
    background: color-mix(in srgb, var(--secondary-background-color) 80%, transparent);
    border: 1px solid var(--divider-color); color: var(--secondary-text-color); font-weight: 600; }
  .gchip .ci svg { width: 13px; height: 13px; }
  .gnext { font-size: .82rem; color: var(--secondary-text-color); display: flex; align-items: center; }
  .gnext.ok { color: var(--z-ok); font-weight: 600; }
  .gnext.warn { color: var(--z-warn); font-weight: 600; }
  .gnext .ci svg { width: 14px; height: 14px; }
  .shimmer { height: 4px; border-radius: 3px; overflow: hidden; position: relative; background: color-mix(in srgb, var(--z-ok) 22%, transparent); }
  .shimmer::after { content: ''; position: absolute; inset: 0; width: 45%; border-radius: 3px;
    background: var(--z-ok); animation: zsh 1.6s ease-in-out infinite; }
  @keyframes zsh { 0% { transform: translateX(-110%);} 100% { transform: translateX(260%);} }

  /* zones */
  .fbar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .fchip { border: 1px solid var(--divider-color); background: transparent; color: var(--secondary-text-color);
    padding: 5px 12px; border-radius: 999px; font-size: .8rem; font-weight: 600; cursor: pointer; transition: all .12s; }
  .fchip.on { background: var(--primary-text-color); color: var(--card-background-color); border-color: transparent; }
  .zsec { margin-bottom: 10px; }
  .zhead { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 2px;
    font-weight: 650; font-size: .86rem; letter-spacing: .01em; }
  .zgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 7px; }
  .zchip { display: flex; align-items: center; gap: 8px; text-align: left; border: 1px solid var(--divider-color);
    background: color-mix(in srgb, var(--secondary-background-color) 55%, transparent);
    border-radius: 12px; padding: 8px 10px; cursor: pointer; color: var(--primary-text-color);
    transition: transform .1s, border-color .12s, box-shadow .12s; min-width: 0; }
  @media (hover: hover) {
    .zchip:hover { transform: translateY(-1px); border-color: var(--secondary-text-color); }
  }
  .zchip:active { transform: scale(.985); }
  .zchip:focus, .fchip:focus { outline: none; }
  .zchip:focus-visible, .fchip:focus-visible { outline: 2px solid var(--z-info); outline-offset: 2px; }
  .zchip.sel { border-color: var(--z-info); box-shadow: 0 0 0 1px var(--z-info); }
  .zchip.running { border-color: color-mix(in srgb, var(--z-ok) 60%, transparent); }
  .zchip.fault { border-color: color-mix(in srgb, var(--z-danger) 60%, transparent); }
  .zchip.off { opacity: .5; }
  .zi { width: 28px; height: 28px; border-radius: 9px; align-items: center; justify-content: center; flex-shrink: 0;
    background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .zi svg { width: 15px; height: 15px; fill: currentColor; }
  .zi.big { width: 36px; height: 36px; }
  .zchip.running .zi { background: color-mix(in srgb, var(--z-ok) 18%, transparent); color: var(--z-ok); }
  .zchip.queued .zi { background: color-mix(in srgb, var(--z-warn) 18%, transparent); color: var(--z-warn); }
  .zchip.fault .zi { background: color-mix(in srgb, var(--z-danger) 18%, transparent); color: var(--z-danger); }
  .zchip > div, .zn { min-width: 0; }
  .zn { flex: 1; font-size: .84rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .zs { display: inline-flex; align-items: center; gap: 4px; font-size: .72rem; color: var(--secondary-text-color); white-space: nowrap; }
  .zs .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .zs.ok { color: var(--z-ok); } .zs.warn { color: var(--z-warn); } .zs.danger { color: var(--z-danger); }
  .zs.idle { color: var(--secondary-text-color); } .zs.muted { color: var(--secondary-text-color); opacity: .7; }
  .zchip.running .zs .dot { animation: zpulse 1.4s ease-in-out infinite; }
  @keyframes zpulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }

  /* zone action sheet: fixed overlay over the viewport (no scroll, no layout shift) */
  .ovl { position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 6; }
  .sheet { position: fixed; left: 50%; transform: translateX(-50%);
    bottom: calc(14px + env(safe-area-inset-bottom, 0px));
    width: min(430px, calc(100vw - 20px)); box-sizing: border-box; z-index: 7; padding: 12px;
    background: var(--card-background-color); border: 1px solid var(--divider-color);
    border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
  .sheet.anim { animation: zup .18s ease-out; }
  @keyframes zup { from { transform: translate(-50%, 16px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
  .shead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .shead .zs { display: flex; margin-top: 2px; }
  .srow { display: flex; gap: 7px; flex-wrap: wrap; }
  .srow .btn { flex: 1 1 auto; }

  /* timeline */
  .tlscale, .tlrow { display: flex; align-items: center; gap: 8px; }
  .tlrow { height: 30px; }
  .tllabel { width: 96px; flex-shrink: 0; font-size: .8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tltrack { position: relative; flex: 1; height: 22px; background: var(--secondary-background-color); border-radius: 6px; }
  .tlticks { position: relative; flex: 1; display: flex; justify-content: space-between; font-size: .7rem; color: var(--secondary-text-color); }
  .tlbar { position: absolute; top: 3px; height: 16px; border-radius: 4px; background: var(--z-ok); opacity: .92; }
  .tlbar.zone { background: var(--z-accent); }
  .tlbar.conflict { background: var(--z-danger); }
  .tlnow { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--z-info); border-radius: 2px; }
  .tlboost { position: absolute; top: 3px; height: 16px; border-radius: 0 4px 4px 0;
    background: repeating-linear-gradient(135deg, var(--z-ok) 0 3px, transparent 3px 6px); opacity: .8; }
  .tltick { position: absolute; top: 1px; height: 20px; width: 2px; background: rgba(255,255,255,.85); border-radius: 1px; }
  /* upcoming rows: stacked on narrow cards, single-line when wide enough */
  .uprow { padding: 10px 0; border-bottom: 1px solid var(--divider-color); }
  .uprow:last-of-type { border-bottom: 0; }
  .uptop { display: flex; flex-direction: column; gap: 6px; }
  .uptop > .ci { display: none; }
  .upname { line-height: 1.25; }
  .upmeta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
  .upmeta .btn.icon { margin-left: auto; }
  .nowrap { white-space: nowrap; }
  @container (min-width: 420px) {
    .uptop { flex-direction: row; align-items: center; gap: 10px; }
    .uptop > .ci { display: inline-flex; }
    .upmeta { flex-wrap: nowrap; margin-left: auto; }
    .upmeta .btn.icon { margin-left: 4px; }
  }
  .ztag { display: inline-block; font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
    padding: 1px 5px; border-radius: 5px; background: color-mix(in srgb, var(--z-info) 22%, transparent); color: var(--z-info); vertical-align: middle; }
  .skiprow { font-size: .74rem; font-weight: 600; margin-top: 2px; display: flex; align-items: center; gap: 4px; }
  .skiprow.danger { color: var(--z-danger); }
  .skiprow.warn { color: var(--z-warn); }
  .skiprow .ci svg { width: 12px; height: 12px; }
  .row.dim > .ci, .row.dim > .grow > b, .row.dim > .muted { opacity: .6; }
  .tllegend { margin-top: 8px; }
`;

// Config editor: view, title, dashboard tiles
class ZroshuaCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { view: 'dashboard', ...config };
    this._render();
  }
  set hass(h) {
    this._hass = h;
  }
  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const tiles = Array.isArray(this._config.tiles) ? this._config.tiles : [...DASH_TILE_IDS];
    const hidden = new Set(DASH_TILE_IDS.filter((id) => !tiles.includes(id)));
    const tileRows = DASH_TILES.map(
      (t) =>
        `<label class="t"><input type="checkbox" data-tile="${t.id}" ${hidden.has(t.id) ? '' : 'checked'}/> ${t.label}</label>`,
    ).join('');
    this.shadowRoot.innerHTML = `
      <style>
        .f { display: flex; flex-direction: column; gap: 10px; padding: 8px 0; }
        label { font-size: .85rem; color: var(--secondary-text-color); }
        select, input[type=text] { padding: 8px; border-radius: 8px; border: 1px solid var(--divider-color);
          background: var(--card-background-color); color: var(--primary-text-color); }
        .tiles { display: flex; flex-direction: column; gap: 6px; padding: 4px 0; }
        .t { display: flex; align-items: center; gap: 8px; color: var(--primary-text-color); font-weight: 600; cursor: pointer; }
        .hint { font-size: .75rem; color: var(--secondary-text-color); }
      </style>
      <div class="f">
        <label>View</label>
        <select id="view">${VIEWS.map((v) => `<option value="${v}" ${v === this._config.view ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <label>Title (optional)</label>
        <input id="title" type="text" value="${this._config.title || ''}" />
        <label>Dashboard tiles</label>
        <div class="hint">Uncheck to hide. On the card, drag tiles to reorder (saved in the browser; also written to card config when possible).</div>
        <div class="tiles">${tileRows}</div>
      </div>`;
    const emit = () => {
      const visible = [...this.shadowRoot.querySelectorAll('[data-tile]:checked')].map((el) => el.dataset.tile);
      const order = Array.isArray(this._config.tiles)
        ? [...this._config.tiles.filter((id) => visible.includes(id)), ...visible.filter((id) => !(this._config.tiles || []).includes(id))]
        : visible;
      this._config = {
        ...this._config,
        view: this.shadowRoot.getElementById('view').value,
        title: this.shadowRoot.getElementById('title').value || undefined,
        tiles: order.length ? order : [...DASH_TILE_IDS],
      };
      this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
    };
    this.shadowRoot.getElementById('view').onchange = emit;
    this.shadowRoot.getElementById('title').oninput = emit;
    this.shadowRoot.querySelectorAll('[data-tile]').forEach((el) => (el.onchange = emit));
  }
}

customElements.define('zroshua-card', ZroshuaCard);
customElements.define('zroshua-card-editor', ZroshuaCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'zroshua-card',
  name: 'Zroshua',
  description: 'Irrigation dashboard, groups, zones, upcoming and timeline cards.',
  preview: false,
});
console.info('%c ZROSHUA-CARD ', 'background:#12b886;color:#fff;border-radius:3px', 'loaded');
