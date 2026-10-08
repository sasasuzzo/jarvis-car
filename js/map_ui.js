// Mappa (Leaflet + tasselli OpenStreetMap/CARTO): posizione, percorso colorato per traffico,
// alternative, destinazione, autovelox, semafori, incidenti.

import { CONFIG } from './config.js';
import { destPoint, clamp } from './util.js';

const TRAFFIC_COLOR = { 1: '#ffc53d', 2: '#ff8a3d', 3: '#ff4d4d', 4: '#b14cff' };

const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;
const L = () => globalThis.L;

export class MapView {
  constructor(el, { onUserMove } = {}) {
    this.map = L().map(el, { zoomControl: false, attributionControl: true, preferCanvas: true }).setView([38.116, 13.361], 13);
    this.tiles = null;
    this.setTheme('dark');
    this.layers = {
      alt: L().layerGroup().addTo(this.map),
      route: L().layerGroup().addTo(this.map),
      traffic: L().layerGroup().addTo(this.map),
      feats: L().layerGroup().addTo(this.map),
      dest: L().layerGroup().addTo(this.map),
    };
    this.me = null;
    this.following = true;
    this.featKey = '';
    this.onUserMove = onUserMove || (() => {});
    this._programmatic = false;
    this.map.on('dragstart', () => { this.following = false; this.onUserMove(); });
  }

  setTheme(theme) {
    this.map.getContainer().classList.toggle('map-dark', theme !== 'light');
    if (this.tiles) return;
    this.tiles = L().tileLayer(CONFIG.map.tiles, {
      subdomains: CONFIG.map.subdomains, maxZoom: CONFIG.map.maxZoom, attribution: CONFIG.map.attribution,
    }).addTo(this.map);
  }

  // ------------------------------------------------------------------ posizione
  setUser(fix) {
    const ll = [fix.lat, fix.lon];
    if (!this.me) {
      const ic = L().divIcon({
        className: 'me', iconSize: [44, 44], iconAnchor: [22, 22],
        html: '<svg viewBox="0 0 24 24"><path d="M12 2l7 19-7-4-7 4z"/></svg>',
      });
      this.me = L().marker(ll, { icon: ic, interactive: false, zIndexOffset: 1000 }).addTo(this.map);
    } else this.me.setLatLng(ll);
    const svg = this.me.getElement()?.querySelector('svg');
    if (svg && fix.heading != null) svg.style.transform = `rotate(${fix.heading}deg)`;
    if (this.following) this._follow(fix);
  }

  _follow(fix) {
    const kmh = (fix.speed ?? 0) * 3.6;
    const zoom = kmh < 15 ? 17 : kmh < 50 ? 16 : kmh < 90 ? 15 : 14;
    let center = { lat: fix.lat, lon: fix.lon };
    if (fix.heading != null && kmh > 8) {
      // il veicolo sta nel terzo basso dello schermo: si vede più strada davanti
      const h = this.map.getSize().y;
      const mpp = (156543.03 * Math.cos((fix.lat * Math.PI) / 180)) / 2 ** zoom;
      center = destPoint(center, fix.heading, clamp(h * 0.16 * mpp, 20, 4000));
    }
    this.map.setView([center.lat, center.lon], zoom, { animate: true, duration: 0.7 });
  }

  recenter(fix) { this.following = true; if (fix) this._follow(fix); }

  // ------------------------------------------------------------------- percorso
  drawRoute(route, alternatives = []) {
    this.layers.route.clearLayers();
    this.layers.traffic.clearLayers();
    this.layers.alt.clearLayers();
    this.layers.dest.clearLayers();
    if (!route) return;
    const ll = (pts) => pts.map((p) => [p.lat, p.lon]);
    for (const alt of alternatives) {
      L().polyline(ll(alt.points), { color: '#8fa1b5', weight: 5, opacity: 0.65, dashArray: '2 10', smoothFactor: 2 }).addTo(this.layers.alt);
    }
    L().polyline(ll(route.points), { color: '#0a1017', weight: 12, opacity: 0.85, smoothFactor: 1.5 }).addTo(this.layers.route);
    L().polyline(ll(route.points), { color: '#4da3ff', weight: 8, opacity: 1, smoothFactor: 1.5 }).addTo(this.layers.route);
    for (const s of route.traffic) {
      const color = s.category === 'ROAD_CLOSURE' ? TRAFFIC_COLOR[4] : TRAFFIC_COLOR[clamp(s.magnitude, 1, 3)];
      if (!color || (s.delayS < 20 && s.magnitude < 1 && s.category !== 'ROAD_CLOSURE')) continue;
      L().polyline(ll(route.points.slice(s.startIdx, s.endIdx + 1)), { color, weight: 8, opacity: 1, smoothFactor: 1.5 }).addTo(this.layers.traffic);
    }
    const end = route.points[route.points.length - 1];
    L().marker([end.lat, end.lon], {
      icon: L().divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 30], html: `<div class="mk dst" style="width:34px;height:34px">${icon('arrive')}</div>` }),
      interactive: false,
    }).addTo(this.layers.dest);
  }

  fitRoute(route) {
    if (!route) return;
    this.following = false;
    this.map.fitBounds(route.points.map((p) => [p.lat, p.lon]), { padding: [60, 60] });
  }

  // ------------------------------------------------- autovelox / semafori / incidenti
  /** items: [{ id, kind: 'camera'|'light'|'incident', lat, lon }] — ridisegna solo se l'insieme cambia. */
  setFeatures(items) {
    const key = items.map((i) => i.id).join('|');
    if (key === this.featKey) return;
    this.featKey = key;
    this.layers.feats.clearLayers();
    for (const it of items) {
      const cls = it.kind === 'camera' ? 'cam' : it.kind === 'light' ? 'lgt' : 'inc';
      const ic = it.kind === 'camera' ? 'camera' : it.kind === 'light' ? 'light' : it.iconId || 'incident';
      const size = it.kind === 'camera' ? 30 : 24;
      L().marker([it.lat, it.lon], {
        icon: L().divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html: `<div class="mk ${cls}" style="width:${size}px;height:${size}px">${icon(ic)}</div>` }),
        interactive: false, zIndexOffset: it.kind === 'camera' ? 500 : 0,
      }).addTo(this.layers.feats);
    }
  }

  invalidate() { this.map.invalidateSize(); }
}
