// GPS reale dal browser (Geolocation API). Nessuna posizione inventata:
// senza permesso o senza fix, i moduli dipendenti restano fermi e lo dichiarano.

import { CONFIG } from './config.js';
import { bus as defaultBus, bearing, haversine } from './util.js';

export class GpsTracker {
  constructor({ geolocation = globalThis.navigator?.geolocation, bus = defaultBus, now = () => Date.now(), cfg = CONFIG.gps } = {}) {
    this.geo = geolocation; this.bus = bus; this.now = now; this.cfg = cfg;
    this.watchId = null;
    this.fix = null;
    this.lostTimer = null;
    this.isLost = false;
    this.denied = false;
    this.lastError = null;
    this.highAccuracy = true;
    this.listeners = [];
  }

  get supported() { return !!this.geo; }
  onFix(fn) { this.listeners.push(fn); }

  start() {
    if (!this.supported || this.watchId != null) return;
    this.lastError = null;
    // 1) fix rapido a bassa precisione (cache/Wi-Fi/celle): evita l'attesa del GPS "freddo"
    try {
      this.geo.getCurrentPosition(
        (pos) => { if (!this.fix) this._handle(pos); },
        (err) => this._onError(err, { quick: true }),
        { enableHighAccuracy: false, maximumAge: 120000, timeout: 12000 },
      );
    } catch { /* ignora */ }
    // 2) inseguimento ad alta precisione
    this._watch(true);
    this.lostTimer = setInterval(() => this._checkLost(), 3000);
  }

  _watch(high) {
    if (this.watchId != null) this.geo.clearWatch(this.watchId);
    this.highAccuracy = high;
    this.watchId = this.geo.watchPosition(
      (pos) => this._handle(pos),
      (err) => this._onError(err),
      { enableHighAccuracy: high, maximumAge: high ? 0 : 30000, timeout: high ? 30000 : 60000 },
    );
  }

  _onError(err, { quick = false } = {}) {
    if (err.code === 1) {                 // permesso negato dall'utente o dal browser
      this.denied = true; this.lastError = 'denied';
      this.bus.emit('gps:denied');
      return;
    }
    this.lastError = err.code === 3 ? 'timeout' : 'unavailable';
    if (!quick) {
      // su computer senza chip GPS l'alta precisione può non rispondere mai: si ripiega sulla rete
      if (this.highAccuracy && !this.fix) this._watch(false);
      this.bus.emit('gps:error', { code: err.code, message: err.message, kind: this.lastError });
    }
  }

  stop() {
    if (this.watchId != null) this.geo?.clearWatch(this.watchId);
    this.watchId = null;
    clearInterval(this.lostTimer);
    this.fix = null;
    this.isLost = false;
    this.lastError = null;
  }

  /** Primo fix utile (per "Posizione acquisita"). */
  waitForFix(timeoutMs = 20000) {
    if (this.fix) return Promise.resolve(this.fix);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error('timeout GPS')); }, timeoutMs);
      const off = this.bus.on('gps:fix', (f) => { clearTimeout(t); off(); resolve(f); });
      const offDen = this.bus.on('gps:denied', () => { clearTimeout(t); off(); offDen(); reject(new Error('permesso negato')); });
    });
  }

  _handle(pos) {
    const c = pos.coords;
    const ts = pos.timestamp || this.now();
    if (c.accuracy != null && c.accuracy > this.cfg.maxAccuracyM && this.fix) return; // fix scadente, si tiene il precedente
    const prev = this.fix;
    let speed = Number.isFinite(c.speed) ? c.speed : null;
    let heading = Number.isFinite(c.heading) ? c.heading : null;
    if (prev && ts > prev.ts) {
      const dt = (ts - prev.ts) / 1000;
      const dist = haversine(prev, { lat: c.latitude, lon: c.longitude });
      if (speed == null && dt >= 0.4 && dt <= 10) speed = dist / dt;
      if (heading == null && dist > 5 && (speed ?? 0) > 1.5) heading = bearing(prev, { lat: c.latitude, lon: c.longitude });
    }
    if (speed != null && speed < 0.6) speed = 0;          // jitter da fermo
    if (heading == null) heading = prev?.heading ?? null;
    const fix = { lat: c.latitude, lon: c.longitude, speed: speed ?? 0, heading, accuracy: c.accuracy ?? null, ts };
    this.fix = fix;
    if (this.isLost) { this.isLost = false; this.bus.emit('gps:back', fix); }
    this.bus.emit('gps:fix', fix);
    for (const fn of this.listeners) { try { fn(fix); } catch (e) { console.error('[gps]', e); } }
  }

  _checkLost() {
    if (!this.fix || this.isLost) return;
    // da fermi (o con aggiornamenti rari, come sui computer) si aspetta di più prima di dichiarare il segnale perso
    const limit = (this.fix.speed ?? 0) > 3 ? this.cfg.lostAfterMs : this.cfg.lostAfterMs * 5;
    if (this.now() - this.fix.ts > limit) { this.isLost = true; this.bus.emit('gps:lost'); }
  }
}
