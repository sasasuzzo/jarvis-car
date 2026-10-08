// Modalità Macchina: orchestratore della sessione di guida.
// Crea i moduli, li collega tra loro e al Contextual Engine, e gestisce la sequenza
// "Modalità Macchina attivata → Posizione acquisita → Destinazione? → …".
// Non contiene logica di dominio: quella sta nei moduli.

import { CONFIG } from './config.js';
import { settings } from './settings.js';
import { Persona } from './persona.js';
import {
  Priority, VoicePriorityEngine, BrowserSynth, JarvisSynth, SpeechListener,
} from './voice.js';
import { GpsTracker } from './gps.js';
import { RouteNavigator } from './navigation.js';
import { TrafficMonitor } from './traffic.js';
import { OverpassClient } from './overpass.js';
import { RoadFeatureStore } from './road_features.js';
import { SpeedCameraMonitor } from './speed_cameras.js';
import { TrafficLightMonitor } from './traffic_lights.js';
import { TrafficLightVision } from './traffic_light_vision.js';
import { WeatherService } from './weather.js';
import { Agenda } from './agenda.js';
import { Places } from './places.js';
import { MusicPlayer } from './music.js';
import { ContextualEngine } from './contextual_engine.js';
import { CommandRouter } from './commands.js';
import { CameraService } from './camera.js';
import {
  AccidentDetector, AccidentResponder, MotionSensor, SceneShakeAnalyzer, frameEnergy,
} from './accident_detection.js';
import { bus, store } from './util.js';

const spokenName = (n) => String(n || '').split(',')[0].trim();

export class CarMode {
  constructor({ api, videoEl = null }) {
    this.api = api;
    this.bus = bus;
    this.running = false;
    this.wakeLock = null;
    this.unduckTimer = null;

    // ---- voce
    this.synth = new JarvisSynth({ api, fallback: new BrowserSynth({ lang: CONFIG.locale }) });
    this.voice = new VoicePriorityEngine({
      synth: this.synth,
      onMessage: (m) => bus.emit('hud:message', m),
      onSpeaking: (on) => this._onSpeaking(on),
      quietGate: () => this.engine?.quietGate() ?? true,
    });
    this.listener = new SpeechListener({
      lang: CONFIG.locale,
      wakeWindowMs: CONFIG.voice.wakeWindowMs,
      onState: (s) => bus.emit('voice:state', s),
      onHeard: (h) => bus.emit('voice:heard', h),
      onDenied: () => this.voice.announce({ key: 'mic:denied', text: Persona.micDenied(), priority: Priority.GUI_ONLY }),
    });

    // ---- dati
    this.gps = new GpsTracker();
    this.navigator = new RouteNavigator({ api, voice: this.voice, bus, settings });
    this.traffic = new TrafficMonitor({ api, voice: this.voice, bus, navigator: this.navigator });
    this.overpass = new OverpassClient();
    this.roadFeatures = new RoadFeatureStore({ client: this.overpass, bus });
    this.weather = new WeatherService();
    this.agenda = new Agenda({ api });
    this.places = new Places();
    this.music = new MusicPlayer({ api, bus });

    this.vision = new TrafficLightVision();
    this.cameras = new SpeedCameraMonitor({ store: this.roadFeatures, voice: this.voice, navigator: this.navigator });
    this.lights = new TrafficLightMonitor({
      store: this.roadFeatures, voice: this.voice, navigator: this.navigator,
      getVision: () => (settings.get('trafficLightVision') ? this.vision.current() : null),
    });

    this.camera = videoEl ? new CameraService({ video: videoEl, bus }) : null;
    this.accident = new AccidentDetector({ onSuspect: (ev) => this.responder.handle(ev) });
    this.motion = new MotionSensor({ detector: this.accident });
    this.shake = new SceneShakeAnalyzer();
    this.prevFrame = null;
    this.responder = new AccidentResponder({
      voice: this.voice, listener: this.listener, bus, settings, getFix: () => this.gps.fix,
    });

    // ---- cervello
    this.engine = new ContextualEngine({
      bus, voice: this.voice, navigator: this.navigator, traffic: this.traffic, weather: this.weather,
      agenda: this.agenda, music: this.music, roadFeatures: this.roadFeatures,
      speedCameras: this.cameras, trafficLights: this.lights,
      getFix: () => this.gps.fix, getCameraState: () => ({ active: !!this.camera?.active }), settings,
    });

    this.commands = new CommandRouter({
      voice: this.voice, navigator: this.navigator, music: this.music, engine: this.engine,
      weather: this.weather, agenda: this.agenda, api, settings, getFix: () => this.gps.fix,
      actions: {
        navigateTo: (t) => this.navigateTo(t),
        resumeTrip: () => this.resumeTrip(),
        cancelWait: () => this.voice.reply('D\'accordo, signore. Mi dica quando vuole una destinazione.'),
        stopNavigation: () => this.stopNavigation(),
        endSession: () => this.end(),
        savePlace: (n) => this.savePlaceHere(n),
      },
    });

    this._wire();
  }

  // ------------------------------------------------------------- collegamenti
  _wire() {
    this.listener.onCommand((cmd) => {
      const cur = this.voice.current;
      if (!cur || cur.item.priority > Priority.CRITICAL) this.voice.interrupt();   // l'utente parla: si tace
      this.commands.handle(cmd);
    });

    this.gps.onFix((fix) => this._onFix(fix));

    bus.on('gps:denied', () => this.voice.announce({ key: 'gps:denied', text: Persona.gpsDenied(), priority: Priority.IMPORTANT, force: true }));
    bus.on('gps:error', (e) => {
      if (e.kind === 'unavailable' && !this.gps.fix) this.voice.announce({ key: 'gps:unavailable', text: Persona.gpsUnavailable(), priority: Priority.IMPORTANT, cooldownMs: 120000 });
    });
    bus.on('gps:lost', () => this.voice.announce({ key: 'gps:lost', text: Persona.gpsLost(), priority: Priority.IMPORTANT, cooldownMs: 60000 }));
    bus.on('gps:back', () => this.voice.announce({ key: 'gps:back', text: Persona.gpsBack(), priority: Priority.INFO, cooldownMs: 60000 }));

    // nuova geometria di percorso -> si ricaricano autovelox e semafori
    bus.on('nav:route', (e) => {
      if (!e.route) { this.roadFeatures.clear(); return; }
      if (e.source && e.source !== 'check') this.roadFeatures.loadForRoute(e.route, 0);
    });
    bus.on('nav:alternative', () => {
      this.voice.announce({ key: 'nav:alt-ask', text: 'Vuole che la imposti, signore?', priority: Priority.IMPORTANT, force: true });
      this.voice.whenIdle(8000).then(() => this.listener.arm(15000));
    });
    bus.on('nav:arrived', () => setTimeout(() => {
      if (this.navigator.state === 'arrived') { this.navigator.stop({ silent: true }); this.roadFeatures.clear(); }
    }, 20000));
    bus.on('auth:expired', () => {
      this.voice.announce({ key: 'auth:exp', text: Persona.sessionExpired(), priority: Priority.IMPORTANT, force: true });
    });
    bus.on('settings:change', (p) => {
      if ('verbosity' in p) this.voice.setVerbosity(p.verbosity);
      if ('trafficLightVision' in p && this.camera) this.camera.needBig = !!p.trafficLightVision;
      if ('accidentDetection' in p) this.accident.enabled = !!p.accidentDetection;
    });
  }

  _onSpeaking(on) {
    bus.emit('voice:speaking', on);
    if (on) {
      clearTimeout(this.unduckTimer);
      this.music.duck();
      this.listener.setIgnoreUntil(Infinity);       // JARVIS non deve sentire se stesso
    } else {
      this.unduckTimer = setTimeout(() => this.music.unduck(), 450);
      this.listener.setIgnoreUntil(Date.now() + 700);
    }
  }

  _onFix(fix) {
    this.accident.pushGps({ ts: fix.ts, speedMs: fix.speed ?? 0 });
    this.navigator.onFix(fix);
    this.cameras.onFix(fix);
    this.lights.onFix(fix);
    bus.emit('car:fix', fix);
  }

  // ----------------------------------------------------------------- sessione
  /** Da chiamare dentro un gesto dell'utente (tocco): sblocca voce, audio, sensori. */
  async start() {
    if (this.running) return;
    this.running = true;
    this.synth.unlock();
    this.voice.setVerbosity(settings.get('verbosity'));
    this.accident.enabled = !!settings.get('accidentDetection');
    bus.emit('car:state', { state: 'starting' });
    this.voice.announce({ key: 'car:on', text: Persona.carModeOn(), priority: Priority.IMPORTANT, force: true });

    this._acquireWakeLock();
    this.music.init().catch(() => {});                 // il player richiede un gesto: lo si prepara ora
    this.gps.start();
    this.traffic.start();
    this.engine.start();
    this.accidentTimer = setInterval(() => this.accident.tick(), 500);

    // sensori (ciascuno chiede il proprio permesso, solo se l'utente lo ha scelto)
    if (settings.get('accidentDetection')) this.motion.start().catch(() => {});
    if (settings.get('cameraEnabled') && this.camera) this._startCamera();

    // calendario
    const ics = settings.get('icsUrl');
    if (ics) this.agenda.sync(ics).catch(() => {});

    // microfono / riconoscimento vocale
    if (this.listener.supported) {
      if (settings.get('wakeWord')) this.listener.start();
    } else {
      this.voice.announce({ key: 'stt:none', text: Persona.noSpeechRecognition(), priority: Priority.GUI_ONLY });
    }

    // posizione
    try {
      await this.gps.waitForFix(25000);
      this.voice.announce({ key: 'gps:ok', text: Persona.gpsAcquired(), priority: Priority.IMPORTANT, force: true });
    } catch (e) {
      if (!this.gps.denied) {
        this.voice.announce({ key: 'gps:wait', text: Persona.gpsWaiting(), priority: Priority.IMPORTANT, force: true });
        // il fix può arrivare più tardi: lo si dice quando arriva
        const off = bus.on('gps:fix', () => { off(); this.voice.announce({ key: 'gps:ok', text: Persona.gpsAcquired(), priority: Priority.IMPORTANT, force: true }); });
      }
    }

    bus.emit('car:state', { state: 'running' });
    this.commands.hasTrip = !!this._freshTrip();
    this.commands.expectDestination();
    this.voice.announce({ key: 'car:ask-dest', text: Persona.askDestination(), priority: Priority.IMPORTANT, force: true });
    this.voice.whenIdle(15000).then(() => { if (this.listener.supported) this.listener.arm(20000); });
  }

  async end() {
    if (!this.running) return;
    this.voice.announce({ key: 'car:off', text: Persona.carModeOff(), priority: Priority.IMPORTANT, force: true });
    await this.voice.whenIdle(8000);
    this.running = false;
    this.navigator.stop({ silent: true });
    this.traffic.stop();
    this.engine.stop();
    this.gps.stop();
    this.listener.stop();
    this.motion.stop();
    clearInterval(this.accidentTimer);
    this.camera?.stop();
    this.music.pause();
    this.roadFeatures.clear();
    this.voice.clear();
    this._releaseWakeLock();
    bus.emit('car:state', { state: 'idle' });
  }

  // ---------------------------------------------------------------- fotocamera
  async _startCamera() {
    try {
      this.camera.needBig = !!settings.get('trafficLightVision');
      await this.camera.start();
      this.accident.hasCamera = true;
      this.camera.subscribe((frame) => {
        if (this.prevFrame) {
          const e = frameEnergy(this.prevFrame, frame.small);
          if (this.shake.push(e)) this.accident.pushCameraSpike(frame.ts);
        }
        this.prevFrame = frame.small;
        if (frame.big && settings.get('trafficLightVision')) this.vision.push(frame.big);
      });
    } catch (e) {
      this.accident.hasCamera = false;
      bus.emit('hud:message', { text: 'Fotocamera non disponibile: ' + (e?.name || 'errore'), priority: Priority.GUI_ONLY, spoken: false, ts: Date.now() });
    }
  }

  async setCamera(on) {
    settings.set({ cameraEnabled: on });
    if (!this.camera) return;
    if (on && this.running) await this._startCamera();
    if (!on) { this.camera.stop(); this.accident.hasCamera = false; this.vision.reset(); }
  }

  // ---------------------------------------------------------------- navigazione
  _freshTrip() {
    const t = store.get('trip', null);
    return t && Date.now() - t.ts < 4 * 3600000 ? t : null;
  }

  async resumeTrip() {
    const t = this._freshTrip();
    if (!t) return this.voice.reply('Non ho un viaggio da riprendere, signore. Mi dica una destinazione.');
    return this.startNavigationTo(t.dest);
  }

  /** Cerca il luogo (salvato o geocodificato) e avvia la navigazione. */
  async navigateTo(text) {
    const fix = this.gps.fix;
    if (!fix) return this.voice.reply(Persona.gpsWaiting());
    this.commands.awaiting = null;
    let dest = this.places.resolve(text);
    if (!dest) {
      let res = [];
      try { res = await this.navigator.searchPlaces(text, fix); }
      catch (e) { return this.voice.reply(e?.code === 'unauthorized' ? Persona.sessionExpired() : Persona.routeFailed()); }
      bus.emit('search:results', res);
      if (!res.length) { this.commands.expectDestination(); return this.voice.reply(Persona.destinationNotFound(text)); }
      dest = { name: res[0].name, lat: res[0].lat, lon: res[0].lon };
    }
    return this.startNavigationTo(dest);
  }

  async startNavigationTo(dest) {
    const fix = this.gps.fix;
    if (!fix) return this.voice.reply(Persona.gpsWaiting());
    try {
      const { route, level } = await this.navigator.plan(dest, fix, { heading: fix.speed > 2 ? fix.heading : null });
      this.voice.reply(Persona.routeSet({ timeS: route.timeS, name: spokenName(dest.name) }));
      this.voice.announce({ key: 'route:traffic', text: Persona.trafficSummary(level, route.delayS), priority: Priority.IMPORTANT, force: true, ttlMs: 30000 });
      if (level === 'intenso' || level === 'molto intenso') {
        const h = Persona.maybeHumor('trafficHeavy');
        if (h) this.voice.announce({ key: 'route:humor', text: h, priority: Priority.INFO, ttlMs: 30000 });
      } else if (route.lengthM > 120000) {
        const h = Persona.maybeHumor('longTrip');
        if (h) this.voice.announce({ key: 'route:humor', text: h, priority: Priority.INFO, ttlMs: 30000 });
      }
      this.voice.announce({ key: 'nav:start', text: Persona.navStart(), priority: Priority.INFO, force: true, ttlMs: 30000 });
    } catch (e) {
      if (e?.code === 'unauthorized') return this.voice.reply(Persona.sessionExpired());
      this.voice.reply(Persona.routeFailed());
    }
  }

  stopNavigation() { this.navigator.stop(); this.commands.expectDestination(); }

  savePlaceHere(name) {
    const fix = this.gps.fix;
    if (!fix) return this.voice.reply(Persona.gpsWaiting());
    this.places.set(name, { name, lat: fix.lat, lon: fix.lon });
    this.voice.reply(`Memorizzato come "${name}", signore.`);
  }

  /** Comando digitato (barra di testo): stesso percorso dei comandi vocali. */
  runText(text) { this.voice.interrupt(); return this.commands.handle(text); }

  /** Pulsante microfono: la prossima frase è un comando. */
  pushToTalk() {
    this.voice.interrupt();
    if (!this.listener.supported) return false;
    this.listener.arm(10000);
    return true;
  }

  // ----------------------------------------------------------------- wake lock
  async _acquireWakeLock() {
    if (!settings.get('keepScreenOn') || !('wakeLock' in navigator)) return;
    const get = async () => { try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignora */ } };
    await get();
    this._vis = () => { if (document.visibilityState === 'visible' && this.running) get(); };
    document.addEventListener('visibilitychange', this._vis);
  }
  _releaseWakeLock() {
    try { this.wakeLock?.release(); } catch { /* ignora */ }
    this.wakeLock = null;
    if (this._vis) document.removeEventListener('visibilitychange', this._vis);
  }

  // ---------------------------------------------------------------- diagnostica
  /** Stato reale di ogni modulo, per la schermata "Stato sistema". Niente è dato per scontato. */
  diagnostics() {
    const svc = this.api.services || {};
    const rf = this.roadFeatures.status;
    const D = (name, state, detail) => ({ name, state, detail });   // state: ok | warn | off | na
    return [
      D('Voce (sintesi)', this.synth.supported ? 'ok' : 'na', this.synth.supported ? this.synth.engineName() : 'non supportata da questo browser'),
      D('Comandi vocali', this.listener.supported ? 'ok' : 'na', this.listener.supported ? (settings.get('wakeWord') ? 'ascolto "Jarvis" attivo' : 'solo tasto microfono') : 'riconoscimento vocale non supportato: usare Chrome o la barra di testo'),
      D('IA (Groq)', svc.ai ? 'ok' : 'na', svc.ai ? 'collegata tramite il server' : 'chiave non configurata sul server'),
      D('GPS', this.gps.denied ? 'na' : this.gps.fix ? (this.gps.isLost ? 'warn' : 'ok') : 'warn', this.gps.denied ? 'permesso negato (controlla anche i permessi del sito nel browser)' : this.gps.fix ? `precisione ${Math.round(this.gps.fix.accuracy ?? 0)} m` : this.gps.lastError === 'unavailable' ? 'posizione non disponibile: attiva la localizzazione del dispositivo' : this.gps.lastError === 'timeout' ? 'nessun segnale (timeout)' : 'in attesa del primo fix'),
      D('Navigazione e traffico (TomTom)', svc.maps ? 'ok' : 'na', svc.maps ? 'routing con traffico in tempo reale' : 'chiave non configurata sul server'),
      D('Incidenti e cantieri', this.traffic.available === false ? 'warn' : svc.maps ? 'ok' : 'na', this.traffic.available === false ? `errore: ${this.traffic.lastError}` : 'TomTom Traffic Incidents'),
      D('Autovelox (OpenStreetMap)', rf.state === 'error' ? 'warn' : 'ok', rf.state === 'error' ? `Overpass non raggiungibile (${rf.error})` : `posizioni fisse note; non copre i controlli mobili`),
      D('Semafori — posizione', rf.state === 'error' ? 'warn' : 'ok', 'OpenStreetMap'),
      D('Semafori — stato (fotocamera)', settings.get('trafficLightVision') && this.camera?.active ? 'warn' : 'off', settings.get('trafficLightVision') ? 'SPERIMENTALE: dichiara il colore solo con alta affidabilità' : 'disattivato; senza fotocamera dico solo che c\'è un semaforo'),
      D('Meteo (Open-Meteo)', this.weather.available === false ? 'warn' : 'ok', this.weather.available === false ? `errore: ${this.weather.lastError}` : 'previsioni orarie reali'),
      D('Agenda', (settings.get('icsUrl') ? !this.agenda.lastError : true) ? 'ok' : 'warn', settings.get('icsUrl') ? (this.agenda.lastError ? `sincronizzazione fallita (${this.agenda.lastError})` : `calendario iCal, ${this.agenda.ics.length} eventi`) : 'solo appuntamenti locali (aggiungere un indirizzo iCal nelle impostazioni)'),
      D('Musica (YouTube)', svc.music ? 'ok' : 'warn', svc.music ? 'ricerca e riproduzione' : 'ricerca non configurata sul server; funzionano solo le playlist salvate'),
      D('Fotocamera', this.camera?.active ? 'ok' : 'off', this.camera?.active ? 'attiva (elaborazione solo sul dispositivo)' : this.camera?.supported ? 'spenta' : 'non disponibile'),
      D('Rilevamento incidenti', settings.get('accidentDetection') ? (this.motion.supported ? 'ok' : 'warn') : 'off',
        settings.get('accidentDetection') ? `accelerometro ${this.motion.supported ? 'sì' : 'no'}, GPS sì, fotocamera ${this.camera?.active ? 'sì' : 'no'}; nessuna chiamata automatica` : 'disattivato'),
    ];
  }
}

