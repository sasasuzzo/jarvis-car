// Rilevamento di un possibile incidente.
//
// Un solo segnale non basta (buche, telefono che cade, frenata decisa). Si combinano
// segnali indipendenti:
//   - accelerometro (DeviceMotion): picco di decelerazione
//   - GPS: velocità prima dell'urto e crollo della velocità subito dopo
//   - fotocamera: scossone improvviso della scena (conferma, non basta da sola)
// Se scatta il sospetto, NON si chiama nessuno: JARVIS chiede "Sta bene?". Solo se manca
// una risposta rassicurante mostra il pulsante per chiamare il 112 (mai chiamata automatica).

import { CONFIG } from './config.js';
import { Persona } from './persona.js';
import { Priority } from './voice.js';
import { KMH, norm, bus as defaultBus } from './util.js';

const G = 9.80665;

// ------------------------------------------------------- movimento della scena

/** Differenza media di luminosità tra due fotogrammi (0..255). */
export function frameEnergy(a, b) {
  const n = Math.min(a.data.length, b.data.length);
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i += 4) {
    const la = a.data[i] * 0.299 + a.data[i + 1] * 0.587 + a.data[i + 2] * 0.114;
    const lb = b.data[i] * 0.299 + b.data[i + 1] * 0.587 + b.data[i + 2] * 0.114;
    sum += Math.abs(la - lb);
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

/** Individua scossoni improvvisi rispetto al "rumore normale" della scena (mediana + MAD). */
export class SceneShakeAnalyzer {
  constructor({ window = 40, minEnergy = 28, k = 6 } = {}) {
    this.window = window; this.minEnergy = minEnergy; this.k = k;
    this.hist = [];
  }
  push(energy) {
    const h = this.hist;
    let spike = false;
    if (h.length >= 15) {
      const sorted = [...h].sort((x, y) => x - y);
      const med = sorted[sorted.length >> 1];
      const mad = [...h].map((x) => Math.abs(x - med)).sort((x, y) => x - y)[h.length >> 1] || 1;
      spike = energy > this.minEnergy && energy > med + this.k * mad;
    }
    h.push(energy);
    if (h.length > this.window) h.shift();
    return spike;
  }
}

// ------------------------------------------------------------- macchina a stati

export class AccidentDetector {
  constructor({ cfg = CONFIG.accident, now = () => Date.now(), onSuspect = () => {} } = {}) {
    this.cfg = cfg; this.now = now; this.onSuspect = onSuspect;
    this.gps = [];                 // { ts, v (m/s) }
    this.pending = null;
    this.cameraSpikes = [];        // timestamp
    this.lastFired = -Infinity;
    this.hasMotionSensor = false;
    this.hasCamera = false;
    this.enabled = true;
    this.log = [];                 // ultimi eventi scartati/segnalati (diagnostica)
  }

  pushGps({ ts, speedMs }) {
    this.gps.push({ ts, v: speedMs });
    while (this.gps.length && ts - this.gps[0].ts > 30000) this.gps.shift();
  }

  /** g = deviazione dall'accelerazione di gravità, in unità g (>= 0). */
  pushMotion({ ts, g }) {
    this.hasMotionSensor = true;
    if (!this.enabled || g < this.cfg.impactGWithCamera) return;
    if (ts - this.lastFired < this.cfg.cooldownMs) return;
    if (!this.pending || ts - this.pending.ts > 9000) {
      this.pending = { ts, peakG: g, camera: this._cameraNear(ts), kind: 'impact' };
    } else if (g > this.pending.peakG) {
      this.pending.peakG = g;
    }
  }

  pushCameraSpike(ts) {
    this.cameraSpikes.push(ts);
    while (this.cameraSpikes.length && ts - this.cameraSpikes[0] > 15000) this.cameraSpikes.shift();
    if (this.pending) {
      if (Math.abs(ts - this.pending.ts) <= 2000) this.pending.camera = true;
    } else if (this.enabled && this.hasCamera && !this.hasMotionSensor && ts - this.lastFired >= this.cfg.cooldownMs) {
      // senza accelerometro: solo scossone + crollo di velocità molto netto
      this.pending = { ts, peakG: null, camera: true, kind: 'camera-only' };
    }
  }

  _cameraNear(ts) { return this.cameraSpikes.some((t) => Math.abs(t - ts) <= 2000); }

  _speedBetween(from, to, fn) {
    const v = this.gps.filter((p) => p.ts >= from && p.ts <= to).map((p) => p.v);
    return v.length ? fn(...v) : null;
  }

  /** Va chiamata di continuo (es. ogni 500 ms): valuta il sospetto quando ci sono i dati del "dopo". */
  tick(now = this.now()) {
    const p = this.pending;
    if (!p) return null;
    const age = now - p.ts;
    if (age < 1500) return null;

    if (p.kind === 'impact') {
      const pre = this._speedBetween(p.ts - 8000, p.ts - 300, Math.max);
      const post = this._speedBetween(p.ts + 1000, p.ts + 9000, Math.min);
      if (pre != null && post != null) {
        const preKmh = pre * KMH, postKmh = post * KMH;
        const need = p.camera ? this.cfg.impactGWithCamera : this.cfg.impactG;
        const stopped = postKmh <= Math.max(this.cfg.postSpeedMaxKmh, preKmh * 0.25);
        if (preKmh >= this.cfg.minPreSpeedKmh && p.peakG >= need && stopped) return this._fire(p, { preKmh, postKmh }, now);
        if (preKmh < this.cfg.minPreSpeedKmh || p.peakG < need) return this._drop(p, 'sotto soglia', { preKmh, peakG: p.peakG });
        if (age > 9000) return this._drop(p, 'veicolo non fermo', { preKmh, postKmh });
      } else if (age > 9000) return this._drop(p, 'dati GPS insufficienti');
    } else {
      const pre = this._speedBetween(p.ts - 4000, p.ts, Math.max);
      const post = this._speedBetween(p.ts + 500, p.ts + 4500, Math.min);
      if (pre != null && post != null && age > 4600) {
        if (pre * KMH >= 40 && post * KMH <= 10) return this._fire(p, { preKmh: pre * KMH, postKmh: post * KMH }, now);
        return this._drop(p, 'camera senza crollo di velocità');
      }
      if (age > 9000) return this._drop(p, 'dati insufficienti');
    }
    return null;
  }

  _fire(p, info, now) {
    this.pending = null;
    this.lastFired = now;
    const ev = { ts: p.ts, peakG: p.peakG, camera: p.camera, confidence: p.kind === 'impact' ? 'alta' : 'bassa', ...info };
    this.log.push({ at: now, fired: true, ...ev });
    this.onSuspect(ev);
    return ev;
  }

  _drop(p, reason, extra = {}) {
    this.pending = null;
    this.log.push({ at: this.now(), fired: false, reason, ...extra });
    if (this.log.length > 30) this.log.shift();
    return null;
  }
}

// -------------------------------------------------------- sensore accelerometro

export class MotionSensor {
  constructor({ win = globalThis.window, detector, now = () => Date.now() } = {}) {
    this.win = win; this.detector = detector; this.now = now;
    this.handler = null;
    this.supported = !!(win && 'DeviceMotionEvent' in win);
    this.permission = 'unknown';
  }

  async start() {
    if (!this.supported) return false;
    const DME = this.win.DeviceMotionEvent;
    if (typeof DME.requestPermission === 'function') {          // iOS: richiede un gesto dell'utente
      try { this.permission = await DME.requestPermission(); } catch { this.permission = 'denied'; }
      if (this.permission !== 'granted') return false;
    }
    this.handler = (e) => {
      const a = e.acceleration;
      let g;
      if (a && a.x != null) g = Math.hypot(a.x, a.y, a.z) / G;               // senza gravità
      else if (e.accelerationIncludingGravity?.x != null) {
        const ag = e.accelerationIncludingGravity;
        g = Math.abs(Math.hypot(ag.x, ag.y, ag.z) - G) / G;                   // si toglie la gravità
      } else return;
      this.detector.pushMotion({ ts: this.now(), g });
    };
    this.win.addEventListener('devicemotion', this.handler);
    return true;
  }

  stop() {
    if (this.handler) this.win.removeEventListener('devicemotion', this.handler);
    this.handler = null;
  }
}

// ------------------------------------------------------------- risposta all'evento

/** 'ok' = sta bene, 'help' = chiede aiuto, 'none' = nessuna risposta chiara. */
export function classifyAnswer(text) {
  if (!text) return 'none';
  const t = norm(text);
  if (/non (sto|mi sento|va) (affatto )?(bene|ok)|non bene|\bmale\b|aiuto|ferit|chiama|soccors|emergenza|\b112\b|ambulanza/.test(t)) return 'help';
  if (/sto bene|tutto (ok|bene)|va tutto bene|falso allarme|nessun problema|\bsto ok\b|\bbene\b|\bok\b/.test(t)) return 'ok';
  return 'none';
}

export class AccidentResponder {
  constructor({ voice, listener, bus = defaultBus, settings, getFix = () => null, cfg = CONFIG.accident }) {
    this.voice = voice; this.listener = listener; this.bus = bus; this.settings = settings; this.getFix = getFix; this.cfg = cfg;
    this.active = false;
    this.cancelled = false;
    this.escalated = false;
  }

  /** L'utente tocca "Sto bene" sullo schermo. */
  cancel(reason = 'utente') {
    if (!this.active) return;
    this.cancelled = true;
    this.listener.cancelOnce?.();
    this.voice.interrupt({ clearInfo: false });
    this.bus.emit('accident:cleared', { reason });
  }

  async handle(info) {
    if (this.active) return;
    this.active = true; this.cancelled = false; this.escalated = false;
    try {
      this.bus.emit('accident:ask', info);
      this.voice.announce({ key: 'acc:ask', text: Persona.accidentAsk(), priority: Priority.CRITICAL, force: true, ttlMs: 20000, source: 'accident' });
      let verdict = await this._listen();
      if (this.cancelled) return;
      if (verdict === 'none') {
        this.voice.announce({ key: 'acc:reask', text: Persona.accidentReask(), priority: Priority.CRITICAL, force: true, ttlMs: 20000, source: 'accident' });
        verdict = await this._listen(8000);
        if (this.cancelled) return;
      }
      if (verdict === 'ok') {
        this.voice.announce({ key: 'acc:ok', text: Persona.accidentOk(), priority: Priority.IMPORTANT, force: true, source: 'accident' });
        this.bus.emit('accident:cleared', { reason: 'risposta' });
        return;
      }
      await this._escalate();
    } finally {
      this.active = false;
    }
  }

  async _listen(timeoutMs = this.cfg.askTimeoutMs) {
    await this.voice.whenIdle(15000);
    if (this.cancelled) return 'ok';
    return classifyAnswer(await this.listener.listenOnce({ timeoutMs }));
  }

  /** Nessuna risposta rassicurante: mostra il pulsante 112 e continua a chiedere. Non chiama da solo. */
  async _escalate() {
    this.escalated = true;
    const fix = this.getFix();
    this.bus.emit('accident:escalate', {
      number: this.settings.get('emergencyNumber') || '112',
      contact: this.settings.get('emergencyContactNumber') ? { name: this.settings.get('emergencyContactName'), number: this.settings.get('emergencyContactNumber') } : null,
      position: fix ? { lat: fix.lat, lon: fix.lon } : null,
    });
    this.voice.announce({ key: 'acc:esc', text: Persona.accidentEscalate(), priority: Priority.CRITICAL, force: true, ttlMs: 20000, source: 'accident' });
    for (let i = 0; i < 6 && !this.cancelled; i++) {
      await this.voice.whenIdle(15000);
      const verdict = classifyAnswer(await this.listener.listenOnce({ timeoutMs: 9000 }));
      if (this.cancelled) return;
      if (verdict === 'ok') {
        this.voice.announce({ key: 'acc:ok2', text: Persona.accidentOk(), priority: Priority.IMPORTANT, force: true });
        this.bus.emit('accident:cleared', { reason: 'risposta' });
        return;
      }
      this.voice.announce({ key: `acc:rep${i}`, text: Persona.accidentRepeat(), priority: Priority.CRITICAL, force: true, ttlMs: 15000, source: 'accident' });
    }
  }
}
