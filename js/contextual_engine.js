// Contextual Engine — il centro dell'architettura.
//
// I moduli (GPS, navigazione, traffico, meteo, agenda, musica, autovelox, semafori,
// fotocamera) RACCOLGONO dati. Questo motore li mette insieme in una rappresentazione
// unica dello stato del viaggio e ne DEDUCE consigli solo quando c'è un motivo concreto.
// Le deduzioni sono regole deterministiche (veloci, verificabili, gratuite). Groq entra
// solo per capire comandi liberi e rispondere a domande, ricevendo questo stato come contesto.

import { CONFIG } from './config.js';
import { Persona } from './persona.js';
import { Priority } from './voice.js';
import {
  bus as defaultBus, clockText, distanceSpeech, durationSpeech, KMH, haversine,
} from './util.js';
import { severityOf } from './weather.js';

const WEATHER_REASON = {
  rain: 'la pioggia prevista', heavyRain: 'la pioggia intensa prevista', thunderstorm: 'i temporali previsti',
  fog: 'la nebbia prevista', snow: 'la neve prevista', ice: 'il rischio di ghiaccio', wind: 'il vento forte previsto',
};

export class ContextualEngine {
  constructor({
    bus = defaultBus, voice, navigator, traffic, weather, agenda, music, roadFeatures, speedCameras, trafficLights,
    getFix, getCameraState = () => ({ active: false }), settings, now = () => Date.now(), cfg = CONFIG,
  }) {
    Object.assign(this, { bus, voice, navigator, traffic, weather, agenda, music, roadFeatures, speedCameras, trafficLights, getFix, getCameraState, settings, now, cfg });
    this.state = {
      driving: false, drivingSince: null, stoppedSince: null,
      weatherNow: null, weatherAlong: null, weatherAt: 0,
      agendaPlan: null,            // { item, travelS, leaveAt, reasons, at }
      sessionStartedAt: null,
    };
    this.timer = null;
    this.busy = { weather: false, agenda: false };
    this.firstEval = true;
    this._off = [];
    this.announcedBreak = 0;
  }

  start() {
    this.state.sessionStartedAt = this.now();
    this.firstEval = true;
    this._off.push(this.bus.on('gps:fix', (f) => this.onFix(f)));
    this._off.push(this.bus.on('nav:route', (e) => {
      if (e.route && e.source !== 'check') { this.state.weatherAt = 0; this.refreshWeather(); }
    }));
    this.timer = setInterval(() => this.evaluate(), 15000);
    setTimeout(() => this.evaluate(), 4000);
  }

  stop() {
    this._off.forEach((f) => f());
    this._off = [];
    clearInterval(this.timer);
  }

  // -------------------------------------------------------------- raccolta
  onFix(fix) {
    const t = this.now();
    const s = this.state;
    const moving = (fix.speed ?? 0) > 2.5;
    if (moving) {
      if (!s.driving) {
        // riparte dopo una sosta lunga: nuova "guida continua"
        if (s.stoppedSince == null || t - s.stoppedSince > 5 * 60000 || s.drivingSince == null) s.drivingSince = t;
        s.driving = true;
      }
      s.stoppedSince = null;
    } else if (s.driving) {
      s.driving = false;
      s.stoppedSince = t;
    }
  }

  /**
   * Il momento giusto per un INFORMATIVO? No se una svolta è imminente.
   * (Il Voice Priority Engine consulta questa funzione prima di pronunciare un INFO.)
   */
  quietGate = () => {
    const next = this.navigator.progress?.next;
    const v = Math.max(this.getFix()?.speed ?? 0, 8);
    if (next && next.distM < Math.max(150, v * 10)) return false;
    return true;
  };

  // ---------------------------------------------------------------- valutazione
  async evaluate() {
    try {
      this.breakAdvice();
      await Promise.all([this.weatherAdvice(), this.agendaAdvice()]);
    } catch (e) {
      console.warn('[contesto] valutazione fallita:', e?.message || e);
    } finally {
      this.firstEval = false;
    }
  }

  breakAdvice() {
    if (!this.settings.get('breakReminder')) return;
    const s = this.state;
    if (!s.driving || s.drivingSince == null) return;
    const hours = (this.now() - s.drivingSince) / 3600000;
    const h = Math.floor(hours);
    if (h >= 2 && h > this.announcedBreak) {
      this.announcedBreak = h;
      this.voice.announce({ key: `break:${h}`, text: Persona.breakSuggestion(h), priority: Priority.INFO, ttlMs: 60000, cooldownMs: 3600000, source: 'context' });
    }
    if (hours < 1) this.announcedBreak = 0;
  }

  async refreshWeather() {
    const s = this.state;
    const fix = this.getFix();
    if (!fix || this.busy.weather) return;
    if (this.now() - s.weatherAt < this.cfg.weather.refreshMs) return;
    this.busy.weather = true;
    try {
      s.weatherNow = await this.weather.current(fix);
      const nav = this.navigator;
      if (nav.active) {
        s.weatherAlong = await this.weather.alongRoute(nav.route, nav.progress?.alongM ?? 0);
      } else s.weatherAlong = null;
      s.weatherAt = this.now();
      this.bus.emit('weather:update', { now: s.weatherNow, along: s.weatherAlong });
    } catch (e) {
      s.weatherAt = this.now() - this.cfg.weather.refreshMs + 60000; // riprova tra un minuto
    } finally {
      this.busy.weather = false;
    }
  }

  async weatherAdvice() {
    await this.refreshWeather();
    const along = this.state.weatherAlong;
    if (!along?.worst || !this.navigator.active) return;
    const w = along.worst;
    const sev = severityOf(w.kind);
    if (sev < 3 || w.distM < 800) return;       // pioggia lieve: solo sulla mappa
    const text = Persona.weatherWarning(w.kind, { atM: w.distM, inMin: w.etaMin, whileDriving: this.state.driving });
    this.voice.announce({
      key: `wx:${w.kind}`, text,
      priority: sev >= 4 ? Priority.IMPORTANT : Priority.INFO,
      ttlMs: 30000, cooldownMs: 30 * 60000, source: 'weather',
    });
  }

  async agendaAdvice() {
    const fix = this.getFix();
    const item = this.agenda.next(3 * 3600000);
    if (!item || !fix || this.busy.agenda || !item.place) return;
    const s = this.state;
    const t = this.now();
    const fresh = s.agendaPlan && s.agendaPlan.item.id === item.id && t - s.agendaPlan.at < 10 * 60000;
    if (!fresh) {
      this.busy.agenda = true;
      try {
        const coords = await this.agenda.coordsFor(item, (q) => this.navigator.searchPlaces(q, fix));
        if (!coords) return;
        const est = await this.navigator.estimate(fix, coords);
        if (!est) return;
        const reasons = [];
        if (est.level === 'intenso' || est.level === 'molto intenso') reasons.push('il traffico attuale');
        let extra = 0;
        try {
          const wx = await this.weather.at(coords, item.start);
          if (wx?.risk) {
            reasons.push(WEATHER_REASON[wx.risk] || 'il maltempo previsto');
            extra = severityOf(wx.risk) >= 3 ? Math.min(600, est.timeS * 0.15) : est.timeS * 0.05;
          }
        } catch { /* meteo non disponibile: si ragiona senza */ }
        const buffer = (this.settings.get('bufferMin') ?? 5) * 60;
        s.agendaPlan = {
          item, coords, travelS: est.timeS, level: est.level, reasons, at: t,
          leaveAt: item.start - (est.timeS + extra + buffer) * 1000,
        };
        this.bus.emit('agenda:plan', s.agendaPlan);
      } catch (e) {
        return;
      } finally {
        this.busy.agenda = false;
      }
    }
    const plan = s.agendaPlan;
    if (!plan || plan.item.id !== item.id) return;

    // 1) sto già navigando verso l'appuntamento ma farò tardi
    const nav = this.navigator;
    if (nav.active && nav.progress && nav.destination && haversine(nav.destination, plan.coords) < 400) {
      const lateS = (nav.progress.eta.getTime() - item.start) / 1000;
      if (lateS > 120) {
        this.voice.announce({
          key: `agenda:${item.id}:late`, text: Persona.lateForAppointment({ title: item.title, startsAt: item.start, lateS }),
          priority: Priority.IMPORTANT, cooldownMs: 15 * 60000, ttlMs: 30000, source: 'agenda',
        });
      }
      return;
    }
    if (nav.active || s.driving) return;

    // 2) non sto guidando: quando conviene partire
    const untilLeave = plan.leaveAt - t;
    const window = this.firstEval ? 3 * 3600000 : 25 * 60000;   // appena aperto, un riepilogo anche se manca tempo
    if (untilLeave > window) return;
    if (untilLeave < 2 * 60000 && untilLeave > -15 * 60000) {
      this.voice.announce({
        key: `agenda:${item.id}:now`, text: Persona.leaveNow({ title: item.title, startsAt: item.start }),
        priority: Priority.IMPORTANT, cooldownMs: 20 * 60000, ttlMs: 30000, source: 'agenda',
      });
      return;
    }
    this.voice.announce({
      key: `agenda:${item.id}:leave`,
      text: Persona.leaveBy({ title: item.title, startsAt: item.start, leaveAt: plan.leaveAt, reasons: plan.reasons }),
      priority: Priority.INFO, ttlMs: 45000, cooldownMs: 20 * 60000, source: 'agenda',
    });
  }

  // ------------------------------------------------------------- rappresentazione
  /** Stato complessivo del viaggio (serve alla GUI, ai comandi e a Groq). */
  getState() {
    const fix = this.getFix();
    const nav = this.navigator.snapshot();
    const tr = this.traffic.snapshot();
    const s = this.state;
    return {
      time: new Date(this.now()),
      gps: fix ? { lat: fix.lat, lon: fix.lon, speedKmh: Math.round((fix.speed ?? 0) * KMH), heading: fix.heading, accuracyM: fix.accuracy } : null,
      driving: s.driving,
      drivingMin: s.drivingSince && s.driving ? Math.round((this.now() - s.drivingSince) / 60000) : 0,
      nav,
      traffic: tr,
      weatherNow: s.weatherNow,
      weatherAlong: s.weatherAlong,
      agendaNext: this.agenda.next(12 * 3600000),
      agendaPlan: s.agendaPlan,
      music: this.music.state(),
      camera: this.getCameraState(),
    };
  }

  /** "Cosa sta succedendo davanti?" — risposta deterministica, in stile JARVIS. */
  describeAhead() {
    const fix = this.getFix();
    const parts = [];
    const nav = this.navigator;
    if (nav.active && nav.progress) {
      const along = nav.progress.alongM;
      const jams = this.traffic.snapshot().jams;
      const incs = this.traffic.snapshot().incidents;
      for (const inc of incs.slice(0, 2)) parts.push(Persona.incidentAhead(inc.kind, inc.distM));
      for (const j of jams.slice(0, 2)) parts.push(j.inside ? `Siamo in un tratto rallentato, ancora per circa ${distanceSpeech(j.endM - along)}.` : Persona.jamAhead(j.distM, j.delayS));
      const cams = this.roadFeatures.ahead('camera', along, 2000);
      if (cams.length) parts.push(Persona.cameraAhead(cams[0].distM, cams[0].maxspeed));
      const lights = this.roadFeatures.ahead('light', along, 600).filter((l) => !l.ped);
      if (lights.length) parts.push(lights.length > 1 ? `${lights.length} semafori nei prossimi ${distanceSpeech(lights[lights.length - 1].distM)}.` : Persona.lightAhead(lights[0].distM));
      const w = this.state.weatherAlong?.worst;
      if (w && severityOf(w.kind) >= 3 && w.distM > 0) parts.push(Persona.weatherWarning(w.kind, { atM: w.distM, inMin: w.etaMin, whileDriving: true }));
      if (nav.progress.next) parts.unshift(Persona.turn('far', nav.progress.next.distM, nav.progress.next));
    } else if (fix) {
      const cams = this.roadFeatures.cone('camera', fix, 1500);
      if (cams.length) parts.push(Persona.cameraAhead(cams[0].distM, cams[0].maxspeed));
      const lights = this.roadFeatures.cone('light', fix, 600).filter((l) => !l.ped);
      if (lights.length) parts.push(Persona.lightAhead(lights[0].distM));
    }
    if (!parts.length) return Persona.nothingAhead();
    return parts.slice(0, 4).join(' ');
  }

  /** Testo compatto per Groq: solo fatti presenti, niente da inventare. */
  toPromptContext() {
    const st = this.getState();
    const L = [];
    L.push(`Ora: ${clockText(st.time)}.`);
    L.push(st.gps ? `Velocità attuale: ${st.gps.speedKmh} km/h. GPS preciso a ${Math.round(st.gps.accuracyM ?? 0)} m.` : 'GPS: nessuna posizione.');
    if (st.nav.active) {
      L.push(`Navigazione attiva verso ${st.nav.destination?.name || 'destinazione'}: mancano ${durationSpeech(st.nav.remainingS)} e ${distanceSpeech(st.nav.remainingM)}, arrivo previsto alle ${clockText(st.nav.eta ?? new Date())}.`);
      L.push(`Traffico sul percorso: ${st.nav.level}${st.nav.delayS >= 60 ? `, ritardo ${durationSpeech(st.nav.delayS)}` : ''}.`);
      if (st.nav.next) L.push(`Prossima manovra tra ${distanceSpeech(st.nav.next.distM)}: ${st.nav.next.message || st.nav.next.maneuver}.`);
      for (const j of st.traffic.jams) L.push(`Rallentamento tra ${distanceSpeech(j.distM)}, ritardo ${durationSpeech(j.delayS)}.`);
      for (const i of st.traffic.incidents) L.push(`Segnalazione (${i.kind}) tra ${distanceSpeech(i.distM)}.`);
    } else L.push('Nessuna navigazione attiva.');
    if (st.weatherNow) L.push(`Meteo qui: ${st.weatherNow.label}, ${Math.round(st.weatherNow.tempC)}°C.`);
    const w = st.weatherAlong?.worst;
    if (w) L.push(`Meteo sul percorso: ${w.label} tra ${distanceSpeech(w.distM)} (circa alle ${clockText(w.eta)}).`);
    if (st.agendaNext) L.push(`Prossimo appuntamento: "${st.agendaNext.title}" alle ${clockText(st.agendaNext.start)}${st.agendaNext.place ? ` a ${st.agendaNext.place}` : ''}.`);
    if (st.music.title) L.push(`Musica: ${st.music.playing ? 'in riproduzione' : 'in pausa'} - ${st.music.title}.`);
    return L.join('\n');
  }
}
