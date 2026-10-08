// Archivio degli elementi stradali (autovelox, semafori) caricati da OpenStreetMap,
// proiettati sul percorso attivo. Condiviso da SpeedCameraMonitor e TrafficLightMonitor.

import { bus as defaultBus, angDiff, bearing, haversine, nearestOnPolyline, headingAtDistance } from './util.js';
import { corridorChunks } from './overpass.js';

export class RoadFeatureStore {
  constructor({ client, bus = defaultBus }) {
    this.client = client;
    this.bus = bus;
    this.all = new Map();           // id -> elemento grezzo
    this.onRoute = [];              // [{ f, alongM, offM }]
    this.route = null;
    this.status = { state: 'idle', done: 0, total: 0, error: '' };
    this.token = 0;
    this.around = { lat: null, lon: null, items: [] };
  }

  /** Carica gli elementi lungo il percorso, partendo dal tratto più vicino a noi. */
  async loadForRoute(route, alongM = 0) {
    const token = ++this.token;
    this.route = route;
    this._project();
    const chunks = corridorChunks(route, alongM);
    this.status = { state: 'loading', done: 0, total: chunks.length, error: '' };
    this.bus.emit('roadfeatures:status', this.status);
    let failed = 0;
    const queue = [...chunks];
    const worker = async () => {
      while (queue.length && token === this.token) {
        const pts = queue.shift();
        try {
          const items = await this.client.corridor(pts);
          if (token !== this.token) return;
          for (const it of items) this.all.set(it.id, it);
          this._project();
        } catch (e) {
          failed++;
          this.status.error = e?.message || 'errore';
        }
        this.status.done++;
        this.bus.emit('roadfeatures:status', this.status);
      }
    };
    await Promise.all([worker(), worker()]);
    if (token !== this.token) return;
    this.status.state = failed === chunks.length && chunks.length ? 'error' : 'ready';
    this.bus.emit('roadfeatures:status', this.status);
    this.bus.emit('roadfeatures:update', this.onRoute);
  }

  clear() {
    this.token++;
    this.all.clear(); this.onRoute = []; this.route = null;
    this.status = { state: 'idle', done: 0, total: 0, error: '' };
    this.around = { lat: null, lon: null, items: [] };
    this.bus.emit('roadfeatures:update', []);
  }

  /** Proietta gli elementi noti sul percorso: tiene solo quelli sulla carreggiata e nel verso giusto. */
  _project() {
    if (!this.route) { this.onRoute = []; return; }
    const { points, cum } = this.route;
    const res = [];
    for (const f of this.all.values()) {
      const np = nearestOnPolyline(points, cum, f);
      const maxOff = f.kind === 'camera' ? 35 : 30;
      if (np.distM > maxOff) continue;
      if (f.dir != null) {
        const routeBrg = headingAtDistance(points, cum, np.alongM);
        // un autovelox orientato nel verso opposto controlla l'altra carreggiata
        if (angDiff(f.dir, routeBrg) > 100) continue;
      }
      res.push({ f, alongM: np.alongM, offM: np.distM });
    }
    res.sort((a, b) => a.alongM - b.alongM);
    this.onRoute = res;
    this.bus.emit('roadfeatures:update', res);
  }

  /** Elementi del tipo richiesto davanti a noi sul percorso. */
  ahead(kind, alongM, horizonM) {
    return this.onRoute
      .filter((x) => x.f.kind === kind && x.alongM > alongM - 5 && x.alongM <= alongM + horizonM)
      .map((x) => ({ ...x.f, alongM: x.alongM, distM: Math.max(0, x.alongM - alongM) }));
  }

  // ----------------------------------------------- guida libera (senza destinazione)
  async refreshAround(fix) {
    const a = this.around;
    if (a.lat != null && haversine(a, fix) < 600) return;
    this.around = { lat: fix.lat, lon: fix.lon, items: a.items };
    try {
      const items = await this.client.around(fix.lat, fix.lon, 1500);
      this.around = { lat: fix.lat, lon: fix.lon, items };
      this.status = { state: 'ready', done: 1, total: 1, error: '' };
      this.bus.emit('roadfeatures:around', items);
    } catch (e) {
      this.around.lat = null; // riprova al prossimo fix
      this.status = { state: 'error', done: 0, total: 1, error: e?.message || 'errore' };
    }
    this.bus.emit('roadfeatures:status', this.status);
  }

  /** Senza rotta: elementi nel cono davanti alla direzione di marcia. */
  cone(kind, fix, maxDistM = 900, halfAngle = 25) {
    if (fix.heading == null || !(fix.speed > 2)) return [];
    const out = [];
    for (const f of this.around.items) {
      if (f.kind !== kind) continue;
      const d = haversine(fix, f);
      if (d < 15 || d > maxDistM) continue;
      if (angDiff(bearing(fix, f), fix.heading) > halfAngle) continue;
      if (f.dir != null && angDiff(f.dir, fix.heading) > 100) continue;
      out.push({ ...f, distM: d });
    }
    return out.sort((a, b) => a.distM - b.distM);
  }
}
