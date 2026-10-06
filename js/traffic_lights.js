// Semafori: posizioni reali da OpenStreetMap; stato (rosso/verde) SOLO se la fotocamera
// lo rileva con affidabilità sufficiente (vedi traffic_light_vision.js).
// Se lo stato non è affidabile JARVIS dice soltanto che c'è un semaforo, mai il colore.

import { Persona } from './persona.js';
import { Priority } from './voice.js';
import { clamp, KMH } from './util.js';

export class TrafficLightMonitor {
  /**
   * @param getVision  () => { state:'red'|'green'|'amber'|null, confidence:0..1, ts } | null
   */
  constructor({ store, voice, navigator, getVision = () => null, now = () => Date.now(), minGapMs = 25000 }) {
    this.store = store; this.voice = voice; this.navigator = navigator; this.getVision = getVision; this.now = now;
    this.minGapMs = minGapMs;
    this.lastSpoken = 0;
    this.lastAnnouncedPos = null;
    this.nextLight = null;
    this.redSince = null;
    this.stoppedAtRed = false;
  }

  onFix(fix) {
    const speedMs = fix.speed ?? 0;
    const v = Math.max(speedMs, 6);
    const announceAt = clamp(v * 12, 120, 260);

    let list;
    if (this.navigator.active && this.navigator.progress) {
      list = this.store.ahead('light', this.navigator.progress.alongM, 600);
    } else {
      list = this.store.cone('light', fix, 600);
    }
    const road = list.filter((l) => !l.ped);          // i semafori pedonali restano solo sulla mappa
    this.nextLight = road[0] ?? null;
    const next = this.nextLight;
    if (!next) { this._resetVision(); return; }

    const vis = this._vision();
    const d = next.distM;

    // --- stato dalla fotocamera (solo se affidabile e il semaforo mappato è davvero vicino)
    if (vis && d <= 260) {
      if (vis.state === 'red') {
        if (this.redSince == null) this.redSince = this.now();
        if (speedMs * KMH < 4) this.stoppedAtRed = true;
        this._speak(`light:${next.id}:red`, Persona.lightState('red', d), Priority.INFO, 8000, true);
      } else if (vis.state === 'green') {
        if (this.stoppedAtRed && this.redSince != null && this.now() - this.redSince > 1500 && speedMs * KMH < 6) {
          this.voice.announce({
            key: `light:${next.id}:green`, text: Persona.lightGreen(), priority: Priority.IMPORTANT,
            ttlMs: 3500, cooldownMs: 20000, source: 'traffic_light',
          });
        }
        this._resetVision();
      }
      return;
    }

    // --- solo presenza (nessuno stato dichiarato)
    if (d <= announceAt && this._farFromOthers(next)) {
      // non parlare sopra una svolta imminente
      const nm = this.navigator.progress?.next;
      if (nm && nm.distM < 130) return;
      this._speak(`light:${next.id}:ahead`, Persona.lightAhead(d), Priority.INFO, 7000, false);
    }
  }

  _vision() {
    const v = this.getVision?.();
    if (!v || !v.state || v.confidence < 0.85) return null;
    if (this.now() - v.ts > 1200) return null;
    return v;
  }

  _resetVision() { this.redSince = null; this.stoppedAtRed = false; }

  _farFromOthers(l) {
    const p = this.lastAnnouncedPos;
    if (!p) return true;
    return Math.hypot(p.lat - l.lat, p.lon - l.lon) * 111000 > 60; // un solo annuncio per gruppo di semafori
  }

  _speak(key, text, priority, ttlMs, bypassGap) {
    const t = this.now();
    if (!bypassGap && t - this.lastSpoken < this.minGapMs) return;
    const r = this.voice.announce({ key, text, priority, ttlMs, cooldownMs: 10 * 60000, source: 'traffic_light' });
    if (r === 'spoken') {
      this.lastSpoken = t;
      if (this.nextLight) this.lastAnnouncedPos = { lat: this.nextLight.lat, lon: this.nextLight.lon };
    }
  }
}
