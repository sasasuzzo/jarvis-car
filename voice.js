// Voce di JARVIS CAR: Voice Priority Engine + sintesi (browser) + riconoscimento (browser).
//
// La voce è il canale principale: i moduli NON parlano mai direttamente, passano
// sempre da VoicePriorityEngine.announce(), che
//   - impedisce due annunci contemporanei (un solo parlato alla volta),
//   - ordina per priorità (CRITICO > IMPORTANTE > INFORMATIVO; GUI_ONLY non parla),
//   - scarta gli annunci scaduti (un "autovelox tra 400 m" detto 20 s dopo è falso),
//   - non ripete la stessa informazione (chiave + cooldown + testo identico).

import { norm, sleep } from './util.js';
import { settings } from './settings.js';

export const Priority = Object.freeze({ CRITICAL: 0, IMPORTANT: 1, INFO: 2, GUI_ONLY: 3 });
export const PRIORITY_NAME = ['CRITICO', 'IMPORTANTE', 'INFORMATIVO', 'GUI'];

const DEFAULT_TTL = { 0: 15000, 1: 20000, 2: 30000 };
const DEFAULT_COOLDOWN = { 0: 8000, 1: 40000, 2: 90000 };

export class VoicePriorityEngine {
  /**
   * @param synth  { speak(text,{priority}) => Promise, cancel() }
   * @param onMessage  chiamata per OGNI annuncio (anche GUI_ONLY): la GUI mostra sempre
   * @param onSpeaking (bool, item) quando inizia/finisce una frase
   * @param quietGate  () => bool; false = "non è il momento" per gli INFORMATIVI
   */
  constructor({
    synth,
    now = () => Date.now(),
    onMessage = () => {},
    onSpeaking = () => {},
    quietGate = () => true,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
    minGapMs = 350,
  } = {}) {
    this.synth = synth;
    this.now = now;
    this.onMessage = onMessage;
    this.onSpeaking = onSpeaking;
    this.quietGate = quietGate;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.minGapMs = minGapMs;

    this.queue = [];
    this.current = null;            // { item, token }
    this.tokenSeq = 0;
    this.lastSpoken = new Map();    // key -> timestamp
    this.recentText = new Map();    // testo normalizzato -> timestamp
    this.history = [];              // ultimi annunci pronunciati
    this.lastEndAt = -Infinity;
    this.timer = null;
    this.idleWaiters = [];
    this.verbosity = 'normal';      // 'normal' | 'essential'
    this.muted = false;             // true: parla solo il CRITICO
    this.stats = { spoken: 0, deduped: 0, expired: 0, gui: 0, preempted: 0 };
  }

  setVerbosity(v) { this.verbosity = v === 'essential' ? 'essential' : 'normal'; }
  setMuted(b) { this.muted = !!b; if (b) this.queue = this.queue.filter((i) => i.priority === Priority.CRITICAL); }

  /** Risposta diretta a un comando dell'utente: sempre pronunciata, mai deduplicata. */
  reply(text, opts = {}) {
    return this.announce({ key: `reply:${this.now()}`, text, priority: Priority.IMPORTANT, force: true, ttlMs: 30000, source: 'reply', ...opts });
  }

  /**
   * @returns 'spoken' (in coda o in riproduzione) | 'gui' | 'deduped' | 'refreshed' | 'empty'
   */
  announce({ key, text, priority = Priority.INFO, ttlMs, cooldownMs, force = false, source = '', meta } = {}) {
    if (!text || !String(text).trim()) return 'empty';
    const now = this.now();
    key = key ?? `txt:${norm(text)}`;

    // ---- decisione: parlato o solo GUI?
    let speak = priority !== Priority.GUI_ONLY;
    if (speak && this.verbosity === 'essential' && priority === Priority.INFO) speak = false;
    if (speak && this.muted && priority !== Priority.CRITICAL) speak = false;

    if (!speak) {
      // anche le informazioni solo-GUI non vanno ripetute a raffica
      const last = this.lastSpoken.get('gui:' + key);
      if (!force && last != null && now - last < (cooldownMs ?? 30000)) return 'deduped';
      this.lastSpoken.set('gui:' + key, now);
      this.stats.gui++;
      this.onMessage({ text, priority, key, source, spoken: false, ts: now, meta });
      return 'gui';
    }

    // ---- anti-ripetizione
    if (!force) {
      const cd = cooldownMs ?? DEFAULT_COOLDOWN[priority];
      const last = this.lastSpoken.get(key);
      if (last != null && now - last < cd) { this.stats.deduped++; return 'deduped'; }
      if (this.current?.item.key === key) { this.stats.deduped++; return 'deduped'; }
      const t = this.recentText.get(norm(text));
      if (t != null && now - t < 45000) { this.stats.deduped++; return 'deduped'; }
    }

    const queued = this.queue.find((i) => i.key === key);
    const item = {
      key, text, priority, source, meta,
      createdAt: now,
      expiresAt: now + (ttlMs ?? DEFAULT_TTL[priority]),
    };
    if (queued && !force) {
      // stessa informazione già in coda: si aggiorna (distanza più recente), non si duplica
      queued.text = text;
      queued.expiresAt = item.expiresAt;
      return 'refreshed';
    }
    this.queue.push(item);
    this._sort();
    this.onMessage({ text, priority, key, source, spoken: true, ts: now, meta });

    // ---- un CRITICO interrompe ciò che sta parlando se è meno importante
    let immediate = false;
    if (priority === Priority.CRITICAL && this.current && this.current.item.priority > Priority.CRITICAL) {
      const cur = this.current;
      this.current = null;
      this.stats.preempted++;
      try { this.synth.cancel(); } catch { /* ignora */ }
      this.onSpeaking(false, cur.item);
      if (cur.item.priority === Priority.IMPORTANT && cur.item.expiresAt > now) {
        this.queue.push({ ...cur.item, resumed: true });
        this._sort();
      }
      immediate = true;
    }
    this._pump({ immediate });
    return 'spoken';
  }

  /** L'utente ha iniziato a parlare o ha toccato lo schermo: tace subito e svuota gli informativi. */
  interrupt({ clearInfo = true } = {}) {
    if (clearInfo) this.queue = this.queue.filter((i) => i.priority < Priority.INFO);
    if (this.current) {
      const cur = this.current;
      this.current = null;
      try { this.synth.cancel(); } catch { /* ignora */ }
      this.onSpeaking(false, cur.item);
    }
    this._settleIfIdle();
  }

  /** Svuota tutto (fine sessione). */
  clear() {
    this.queue = [];
    this.interrupt({ clearInfo: true });
  }

  isSpeaking() { return !!this.current; }
  lastSpokenText() { return this.history.length ? this.history[this.history.length - 1].text : ''; }

  /** Risolve quando non sta parlando e non ha nulla di pronunciabile in coda. */
  whenIdle(timeoutMs = 60000) {
    if (this._isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      const t = this.setTimer(() => resolve(), timeoutMs);
      this.idleWaiters.push(() => { this.clearTimer(t); resolve(); });
    });
  }

  getState() {
    return {
      speaking: this.current ? this.current.item.text : null,
      queued: this.queue.map((i) => ({ key: i.key, priority: PRIORITY_NAME[i.priority] })),
      verbosity: this.verbosity,
      muted: this.muted,
      stats: { ...this.stats },
    };
  }

  // ------------------------------------------------------------ interno

  _sort() { this.queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt); }
  _isIdle() { return !this.current && this.queue.length === 0; }

  _settleIfIdle() {
    if (!this._isIdle()) return;
    const w = this.idleWaiters.splice(0);
    for (const fn of w) fn();
  }

  _schedule(ms) {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; this._pump(); }, Math.max(20, ms));
  }

  _pump({ immediate = false } = {}) {
    if (this.current) return;
    const now = this.now();
    const before = this.queue.length;
    this.queue = this.queue.filter((i) => i.expiresAt > now);
    this.stats.expired += before - this.queue.length;
    if (!this.queue.length) { this._settleIfIdle(); return; }

    const sinceEnd = now - this.lastEndAt;
    if (!immediate && sinceEnd < this.minGapMs) { this._schedule(this.minGapMs - sinceEnd + 5); return; }

    const next = this.queue[0];
    if (next.priority === Priority.INFO && !this.quietGate()) { this._schedule(1000); return; }
    this.queue.shift();
    this._start(next);
  }

  _start(item) {
    const token = ++this.tokenSeq;
    const now = this.now();
    this.current = { item, token };
    this.lastSpoken.set(item.key, now);
    this.recentText.set(norm(item.text), now);
    this.history.push({ text: item.text, ts: now, priority: item.priority, key: item.key });
    if (this.history.length > 60) this.history.shift();
    this.stats.spoken++;
    this.onSpeaking(true, item);
    Promise.resolve()
      .then(() => this.synth.speak(item.text, { priority: item.priority }))
      .catch((e) => console.warn('[voice] sintesi fallita:', e?.message || e))
      .finally(() => {
        if (this.current?.token !== token) return; // interrotta: lo stato è già stato gestito
        this.current = null;
        this.lastEndAt = this.now();
        this.onSpeaking(false, item);
        this._pump();
      });
  }
}

// =================================================================== sintesi

/** Spezza il testo in frasi brevi: Chrome interrompe gli enunciati lunghi dopo ~15 s. */
export function splitSentences(text, max = 170) {
  const parts = String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?;:])\s+/);
  const out = [];
  for (const p of parts) {
    if (p.length <= max) { if (p) out.push(p); continue; }
    let rest = p;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(',', max);
      if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

export class BrowserSynth {
  constructor({ synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, lang = 'it-IT' } = {}) {
    this.synth = synth;
    this.Utterance = Utterance;
    this.lang = lang;
    this.runId = 0;
    this._finishCurrent = null;
    this.voice = null;
  }

  get supported() { return !!(this.synth && this.Utterance); }

  voices() {
    try { return (this.synth?.getVoices() ?? []).filter((v) => v.lang?.toLowerCase().startsWith('it')); } catch { return []; }
  }

  /** Voce scelta dall'utente, altrimenti la migliore italiana disponibile (maschile se riconoscibile). */
  pickVoice() {
    const list = this.voices();
    if (!list.length) return null;
    const wanted = settings.get('voiceURI');
    if (wanted) { const v = list.find((x) => x.voiceURI === wanted); if (v) return v; }
    const male = list.find((v) => /luca|cosimo|diego|paolo|male|uomo/i.test(v.name));
    if (male) return male;
    const google = list.find((v) => /google/i.test(v.name));
    return google || list.find((v) => v.lang?.toLowerCase() === 'it-it') || list[0];
  }

  /** Va chiamato dentro un gesto dell'utente (tocco): iOS/Chrome sbloccano l'audio. */
  unlock() {
    if (!this.supported) return;
    try {
      const u = new this.Utterance(' ');
      u.volume = 0;
      this.synth.speak(u);
    } catch { /* ignora */ }
  }

  async speak(text) {
    if (!this.supported) return;
    const run = ++this.runId;
    if (this.synth.speaking || this.synth.pending) { this.synth.cancel(); await sleep(40); }
    for (const chunk of splitSentences(text)) {
      if (run !== this.runId) return;
      await this._utter(chunk);
    }
  }

  _utter(text) {
    return new Promise((resolve) => {
      const u = new this.Utterance(text);
      u.lang = this.lang;
      const v = this.pickVoice();
      if (v) u.voice = v;
      u.rate = settings.get('voiceRate') ?? 1;
      u.pitch = settings.get('voicePitch') ?? 1;
      u.volume = 1;
      let done = false;
      let wd = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(wd);
        if (this._finishCurrent === finish) this._finishCurrent = null;
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;
      // alcuni browser mobili non emettono mai "end": guardiano proporzionale al testo
      wd = setTimeout(finish, Math.max(5000, text.length * 110) + 2500);
      this._finishCurrent = finish;
      try { this.synth.speak(u); } catch { finish(); }
    });
  }

  cancel() {
    this.runId++;
    try { this.synth?.cancel(); } catch { /* ignora */ }
    this._finishCurrent?.();
  }
}

// ============================================================== riconoscimento

const WAKE_RE = /\b(?:(?:hey|ehi|ok|ciao|salve)\s+)?(?:jarvis|giarvis|jarves|garvis|jarvi|giarvi|jervis|iarvis|yarvis|charvis|jarvice|jar vis|giar vis)\b/;

/**
 * Cerca la parola di attivazione. Se la frase contiene "Jarvis, metti musica"
 * restituisce il comando "metti musica". Se la finestra di ascolto è armata
 * (l'utente ha appena detto solo "Jarvis" o toccato il microfono), tutta la frase è un comando.
 */
export function extractCommand(transcript, { armed = false } = {}) {
  const t = norm(transcript);
  if (!t) return { woke: false, command: '' };
  const m = WAKE_RE.exec(t);
  if (m) {
    // "jarvis metti musica" -> "metti musica"; "metti musica jarvis" -> "metti musica"
    const after = t.slice(m.index + m[0].length).trim();
    const before = t.slice(0, m.index).trim();
    return { woke: true, command: after || before };
  }
  if (armed) return { woke: false, command: t };
  return { woke: false, command: '' };
}

export class SpeechListener {
  constructor({
    Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition,
    lang = 'it-IT',
    now = () => Date.now(),
    wakeWindowMs = 8000,
    onState = () => {},
    onHeard = () => {},
    onDenied = () => {},
  } = {}) {
    this.Recognition = Recognition;
    this.lang = lang;
    this.now = now;
    this.wakeWindowMs = wakeWindowMs;
    this.onState = onState;
    this.onHeard = onHeard;
    this.onDenied = onDenied;

    this.rec = null;
    this.active = false;       // l'utente vuole l'ascolto continuo
    this.running = false;      // il motore sta effettivamente ascoltando
    this.armedUntil = 0;
    this.ignoreUntil = 0;
    this.once = null;          // { resolve, timer }
    this.handlers = [];
    this.failures = 0;
    this.lastFinal = { text: '', ts: 0 };
    this.restartTimer = null;
  }

  get supported() { return !!this.Recognition; }
  onCommand(fn) { this.handlers.push(fn); }

  /** Ignora i risultati finché JARVIS parla (altrimenti sente se stesso). */
  setIgnoreUntil(ts) { this.ignoreUntil = ts; }

  /** Tocco sul microfono: la prossima frase è un comando, senza dire "Jarvis". */
  arm(ms = this.wakeWindowMs) { this.armedUntil = this.now() + ms; this.onState('armed'); if (!this.running && this.supported) this._start(); }

  start() {
    if (!this.supported) return false;
    this.active = true;
    this._start();
    return true;
  }

  stop() {
    this.active = false;
    clearTimeout(this.restartTimer);
    try { this.rec?.abort(); } catch { /* ignora */ }
    this.running = false;
    this.onState('idle');
  }

  /** Ascolta UNA frase (risposte a "Destinazione?", "Sta bene?"). Risolve con il testo o null. */
  listenOnce({ timeoutMs = 9000 } = {}) {
    if (!this.supported) return Promise.resolve(null);
    return new Promise((resolve) => {
      if (this.once) { clearTimeout(this.once.timer); this.once.resolve(null); }
      const timer = setTimeout(() => { this.once = null; this.onState(this.active ? 'listening' : 'idle'); resolve(null); }, timeoutMs);
      this.once = { resolve, timer };
      this.ignoreUntil = Math.min(this.ignoreUntil, this.now() + 300);
      this.onState('armed');
      if (!this.running) this._start();
    });
  }

  /** Annulla un ascolto singolo in corso (risolve con null). */
  cancelOnce() {
    if (!this.once) return;
    clearTimeout(this.once.timer);
    const { resolve } = this.once;
    this.once = null;
    this.onState(this.active ? 'listening' : 'idle');
    resolve(null);
  }

  _start() {
    if (this.running || !this.supported) return;
    const rec = new this.Recognition();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => { this.running = true; this.failures = 0; this.onState(this.once || this.now() < this.armedUntil ? 'armed' : 'listening'); };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.active = false;
        this.onDenied(e.error);
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.failures++;
      }
    };
    rec.onend = () => {
      this.running = false;
      this.rec = null;
      if (this.active || this.once) {
        const delay = Math.min(3000, 200 + this.failures * 500);
        this.restartTimer = setTimeout(() => this._start(), delay);
      } else this.onState('idle');
    };
    rec.onresult = (e) => this._onResult(e);
    this.rec = rec;
    try { rec.start(); } catch { this.running = false; }
  }

  _onResult(e) {
    const now = this.now();
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0]?.transcript?.trim();
      if (!text) continue;
      if (now < this.ignoreUntil) continue;
      if (!r.isFinal) { this.onHeard({ text, final: false }); continue; }
      // alcuni Android ripetono gli stessi risultati finali
      if (text === this.lastFinal.text && now - this.lastFinal.ts < 1500) continue;
      this.lastFinal = { text, ts: now };
      this.onHeard({ text, final: true });

      if (this.once) {
        const { resolve, timer } = this.once;
        clearTimeout(timer);
        this.once = null;
        this.onState(this.active ? 'listening' : 'idle');
        resolve(text);
        continue;
      }
      const armed = now < this.armedUntil;
      const { woke, command } = extractCommand(text, { armed });
      if (woke && !command) { this.armedUntil = now + this.wakeWindowMs; this.onState('armed'); continue; }
      if (command) {
        this.armedUntil = 0;
        this.onState('listening');
        for (const h of this.handlers) h(command, { viaWake: woke, raw: text });
      }
    }
  }
}
