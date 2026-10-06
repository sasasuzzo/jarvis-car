// Comandi vocali.
// 1) parseIntent(): riconoscimento deterministico dei comandi comuni (istantaneo, gratuito, offline).
// 2) Tutto il resto (domande libere, richieste insolite) passa a Groq, che riceve lo stato
//    del viaggio dal Contextual Engine e può rispondere a voce o restituire un'azione
//    da una lista chiusa (navigare, musica, volume, nuovo appuntamento).

import { norm, clockText } from './util.js';
import { Persona } from './persona.js';

const FILLER = /\b(per favore|per piacere|grazie|adesso|subito|ora|jarvis|gentilmente)\b/g;
const PLACE_PREP = '(?:a|al|allo|alla|ai|agli|alle|in|da|dal|dallo|dalla|dai|verso|per|presso|fino a|fino al)';

/** Estrae la destinazione da una frase di navigazione o da una risposta a "Destinazione?". */
export function extractDestination(t) {
  let s = t.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(new RegExp(`^(?:portami|accompagnami|navigami|andiamo|vai|dirigiti|voglio andare|devo andare|imposta la destinazione|imposta destinazione|destinazione|vorrei andare)\\s*${PLACE_PREP}?\\s+`), '');
  s = s.replace(new RegExp(`^${PLACE_PREP}\\s+`), '');
  return s.trim();
}

/**
 * @param ctx { awaiting: null|'destination', hasNav, hasPending, hasRevert, hasTrip }
 * @returns { intent, slots }
 */
export function parseIntent(raw, ctx = {}) {
  const t = norm(raw).replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { intent: 'none', slots: {} };
  const is = (re) => re.test(t);

  // ---- conferme (solo se c'è qualcosa da confermare)
  if (ctx.hasPending && is(/^(si|certo|ok|va bene|d accordo|accetta|confermo|procedi|imposta|adotta)\b/)) return { intent: 'confirm_yes', slots: {} };
  if (ctx.hasPending && is(/^(no|ignora|lascia stare|resta|mantieni|rifiuto|non serve)\b/)) return { intent: 'confirm_no', slots: {} };
  if (ctx.hasRevert && is(/^(annulla|torna al percorso precedente|percorso precedente|rimetti il percorso)/)) return { intent: 'revert', slots: {} };

  // ---- fine sessione / navigazione
  if (is(/(esci|disattiva|chiudi|termina|spegni)( dalla| la)? modalita (macchina|auto|guida)/)) return { intent: 'car_mode_off', slots: {} };
  if (is(/(ferma|termina|interrompi|annulla|chiudi|cancella|basta) (la )?(navigazione|percorso|guida|destinazione)|esci dalla navigazione/)) return { intent: 'nav_stop', slots: {} };

  // ---- risposta a "Destinazione?": i comandi noti hanno la precedenza, il resto è un luogo
  if (ctx.awaiting === 'destination') {
    if (is(/^(riprendi|continua|riprendiamo|stesso percorso|ultimo viaggio)/) && ctx.hasTrip) return { intent: 'resume_trip', slots: {} };
    if (is(/^(niente|nessuna|annulla|lascia stare|non importa|nulla)\b/)) return { intent: 'cancel_wait', slots: {} };
    const base = parseIntent(raw, { ...ctx, awaiting: null });
    if (base.intent !== 'chat') return base;
    const place = extractDestination(t);
    if (place) return { intent: 'navigate', slots: { place } };
    return base;
  }

  // ---- navigazione
  if (is(new RegExp(`^(?:portami|accompagnami|navigami|andiamo|vai|dirigiti|voglio andare|devo andare|vorrei andare|imposta (?:la )?destinazione|destinazione)\\b`))) {
    const place = extractDestination(t);
    if (place) return { intent: 'navigate', slots: { place } };
  }
  if (is(/quanto manca|quando arrivo|a che ora arrivo|ora di arrivo|tempo di arrivo|quanta strada|quanti chilometri|tempo stimato/)) return { intent: 'eta', slots: {} };
  if (is(/evita (l autostrada|le autostrade|i pedaggi|il pedaggio|la superstrada)/)) return { intent: 'avoid', slots: { what: /pedagg/.test(t) ? 'tolls' : 'motorways', on: true } };
  if (is(/(usa|riprendi|riabilita|permetti) (l autostrada|le autostrade|i pedaggi)/)) return { intent: 'avoid', slots: { what: /pedagg/.test(t) ? 'tolls' : 'motorways', on: false } };
  if (is(/percorso alternativo|un alternativa|altra strada|strada diversa|evita il traffico|cerca un percorso|trova un percorso|alternativa/)) return { intent: 'alternative', slots: {} };

  // ---- cosa c'è davanti
  if (is(/cosa (sta )?(succedendo|c e|ce|mi aspetta) (davanti|avanti)|com e il traffico|traffico davanti|situazione davanti|cosa c e davanti|che succede davanti/)) return { intent: 'ahead', slots: {} };

  // ---- meteo
  if (is(/\b(meteo|previsioni)\b|che tempo|com(?:e)? e il tempo|piove|piovera|pioggia|temporale|nebbia|quanti gradi|che temperatura/)) {
    const scope = /destinazione|arrivo|dove vado|a arrivo/.test(t) ? 'destination' : /percorso|strada|viaggio|lungo/.test(t) ? 'route' : 'here';
    return { intent: 'weather', slots: { scope } };
  }

  // ---- agenda
  if (is(/(aggiungi|inserisci|segna|metti|fissa|ricordami).*(appuntament|impegn|agenda|ricord)/)) return { intent: 'agenda_add', slots: {} };
  if (is(/(prossimo|quale|qual e|dimmi il) (mio )?appuntamento|cosa ho oggi|agenda( di oggi)?|i miei impegni|ho impegni/)) return { intent: 'agenda_next', slots: {} };

  // ---- musica
  let m;
  if ((m = t.match(/volume (?:al |a |su )?(\d{1,3}) ?(?:%|percento|per cento)?/))) return { intent: 'volume_set', slots: { value: Math.min(100, parseInt(m[1], 10)) } };
  if (is(/alza( il)? volume|volume (piu )?alto|piu forte|aumenta( il)? volume/)) return { intent: 'volume_up', slots: {} };
  if (is(/abbassa( il)? volume|volume (piu )?basso|meno forte|diminuisci( il)? volume/)) return { intent: 'volume_down', slots: {} };
  if (is(/\b(pausa|metti in pausa|ferma la musica|stop musica|spegni la musica|silenzio musica|zitta la musica)\b/)) return { intent: 'music_pause', slots: {} };
  if (is(/^(riprendi|continua|fai ripartire|play|riavvia)( la)?( musica)?$|riprendi la musica|fai ripartire la musica/)) return { intent: 'music_resume', slots: {} };
  if (is(/\b(prossima|prossimo|successiva|successivo|salta|cambia (canzone|brano)|avanti)\b/) && !/navigazione|percorso/.test(t)) return { intent: 'music_next', slots: {} };
  if (is(/\b(precedente|brano prima|canzone prima|indietro)\b/) && !/navigazione|percorso/.test(t)) return { intent: 'music_prev', slots: {} };
  if ((m = t.match(/playlist (.+)/))) return { intent: 'music_playlist', slots: { name: m[1].trim() } };
  if ((m = t.match(/^(?:metti|mettimi|fammi sentire|riproduci|suona|voglio ascoltare|vorrei ascoltare|ascolta)\s*(.*)$/)) && !/navigazione/.test(t)) {
    return { intent: 'music_play', slots: { query: (m[1] || '').trim() } };
  }
  if (is(/^musica( per favore)?$/)) return { intent: 'music_play', slots: { query: '' } };

  // ---- luoghi
  if ((m = t.match(/(?:salva|memorizza|imposta|ricorda) (?:questo posto|la posizione|qui|la mia posizione) come (.+)/))) return { intent: 'save_place', slots: { name: m[1].trim() } };

  // ---- conversazione di servizio
  if (is(/\bripeti\b|cos hai detto|ripeti pure/)) return { intent: 'repeat', slots: {} };
  if (is(/parla meno|solo avvisi importanti|solo gli avvisi|modalita silenziosa|stai zitto|zitto|fai silenzio/)) return { intent: 'verbosity', slots: { value: 'essential' } };
  if (is(/parla di piu|riprendi a parlare|modalita normale|torna a parlare|puoi parlare/)) return { intent: 'verbosity', slots: { value: 'normal' } };
  if (is(/che ora e|che ore sono|dimmi l ora/)) return { intent: 'time', slots: {} };
  if (is(/cosa sai fare|quali comandi|elenco comandi|come ti uso/)) return { intent: 'help', slots: {} };
  if (is(/\b(riprendi|continua)\b.*(navigazione|viaggio|percorso)/)) return { intent: 'resume_trip', slots: {} };

  return { intent: 'chat', slots: {} };
}

// ---------------------------------------------------------------------- AI

const SYSTEM_PROMPT = (now, context) => `Sei J.A.R.V.I.S. in modalità auto: l'assistente alla guida del conducente. Parli in italiano con tono professionale, elegante, calmo e preciso; ironia lieve solo quando non riguarda la sicurezza. Dai del "signore" al conducente ogni tanto, non in ogni frase.
REGOLE: risposte BREVISSIME (al massimo due frasi, adatte alla voce), niente elenchi, niente markdown, niente emoji. Usa SOLO i fatti del CONTESTO: se un dato manca, dì che non lo hai, senza inventare. Non incoraggiare mai manovre rischiose o il superamento dei limiti.
Se la richiesta è un COMANDO eseguibile, rispondi SOLO con una riga JSON, nient'altro:
{"action":"navigate","query":"luogo"} | {"action":"music","query":"artista/genere/brano"} | {"action":"volume","value":0-100} | {"action":"agenda_add","title":"...","start":"AAAA-MM-GGTHH:MM","place":"..."}
Data e ora locali: ${now}.
CONTESTO DEL VIAGGIO:
${context}`;

export function parseAiAction(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (['navigate', 'music', 'volume', 'agenda_add'].includes(o.action)) return o;
  } catch { /* non è JSON */ }
  return null;
}

export function cleanSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ').replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim();
}

const shortTitle = (t) => String(t || '').replace(/[\(\[].*?[\)\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

export class CommandRouter {
  /**
   * actions: { navigateTo(text), stopNavigation(), endSession(), savePlace(name), resumeTrip(), cancelWait() }
   */
  constructor({ voice, navigator, music, engine, weather, agenda, api, settings, getFix, actions, now = () => Date.now() }) {
    Object.assign(this, { voice, navigator, music, engine, weather, agenda, api, settings, getFix, actions, now });
    this.awaiting = null;
    this.awaitingAt = 0;
    this.history = [];
    this.hasTrip = false;
  }

  /** Dopo "Destinazione?" la prossima frase è un luogo (per 40 secondi). */
  expectDestination() { this.awaiting = 'destination'; this.awaitingAt = this.now(); }

  async handle(text) {
    if (this.awaiting && this.now() - this.awaitingAt > 40000) this.awaiting = null;
    const ctx = {
      awaiting: this.awaiting,
      hasNav: this.navigator.active,
      hasPending: !!this.navigator.pending,
      hasRevert: !!this.navigator.previousRoute && this.now() - this.navigator.lastSwitchAt < 25000,
      hasTrip: this.hasTrip,
    };
    const { intent, slots } = parseIntent(text, ctx);
    try {
      return await this.run(intent, slots, text);
    } catch (e) {
      console.warn('[comandi]', intent, e);
      if (e?.code === 'unauthorized') this.voice.reply(Persona.sessionExpired());
      else this.voice.reply(Persona.didntUnderstand());
    }
  }

  say(text) { this.voice.reply(text); }

  async run(intent, slots, raw) {
    const nav = this.navigator;
    const fix = this.getFix();
    switch (intent) {
      case 'none': return;
      case 'navigate': this.awaiting = null; return this.actions.navigateTo(slots.place);
      case 'resume_trip': this.awaiting = null; return this.actions.resumeTrip();
      case 'cancel_wait': this.awaiting = null; return this.actions.cancelWait?.();
      case 'car_mode_off': return this.actions.endSession();
      case 'nav_stop':
        if (!nav.active) return this.say(Persona.noRoute());
        return this.actions.stopNavigation();
      case 'confirm_yes': return nav.acceptPending();
      case 'confirm_no': return nav.rejectPending();
      case 'revert': return nav.revert();

      case 'eta': {
        const eta = nav.getEta();
        return this.say(eta ? Persona.eta(eta) : Persona.noRoute());
      }
      case 'alternative':
        if (!nav.active) return this.say(Persona.noRoute());
        return void nav.checkAlternatives({ manual: true });
      case 'avoid': {
        this.settings.set(slots.what === 'tolls' ? { avoidTolls: slots.on } : { avoidMotorways: slots.on });
        this.say(slots.on ? 'D\'accordo, signore. Da ora li evito.' : 'D\'accordo, torno a considerarli.');
        if (nav.active) nav.reroute({ reason: 'avoid' });
        return;
      }
      case 'ahead': return this.say(this.engine.describeAhead());
      case 'weather': return this.say(await this.weatherAnswer(slots.scope, fix));

      case 'music_play': {
        try {
          if (!slots.query && this.music.queue.length && !this.music.playing) { this.music.resume(); return this.say(Persona.musicResumed()); }
          const item = await this.music.searchAndPlay(slots.query || 'musica per guidare');
          return this.say(Persona.musicPlaying(shortTitle(item.title)));
        } catch (e) { return this.say(this.musicError(e, slots.query)); }
      }
      case 'music_playlist': {
        const pl = this.settings.get('playlists') || {};
        const key = Object.keys(pl).find((k) => norm(k) === norm(slots.name));
        if (!key) return this.say(`Non ho una playlist chiamata "${slots.name}", signore. Può aggiungerla dalle impostazioni.`);
        await this.music.playPlaylist(pl[key]);
        return this.say(`Avvio la playlist ${key}.`);
      }
      case 'music_pause': this.music.pause(); return this.say(Persona.musicPaused());
      case 'music_resume': this.music.resume(); return this.say(Persona.musicResumed());
      case 'music_next': this.music.next(); return;
      case 'music_prev': this.music.prev(); return;
      case 'volume_set': return this.say(Persona.volumeSet(this.music.setVolume(slots.value)));
      case 'volume_up': return this.say(Persona.volumeSet(this.music.adjustVolume(+15)));
      case 'volume_down': return this.say(Persona.volumeSet(this.music.adjustVolume(-15)));

      case 'agenda_next': {
        const list = this.agenda.today();
        if (!list.length) {
          const n = this.agenda.next();
          return this.say(n ? `Il suo prossimo appuntamento è "${n.title}" alle ${clockText(n.start)}${n.place ? `, a ${n.place}` : ''}.` : 'Non risultano appuntamenti nelle prossime ore, signore.');
        }
        const first = list[0];
        const more = list.length > 1 ? ` In tutto ne ha ${list.length} oggi.` : '';
        return this.say(`Il prossimo è "${first.title}" alle ${clockText(first.start)}${first.place ? `, a ${first.place}` : ''}.${more}`);
      }
      case 'agenda_add': return this.aiAgendaAdd(raw);
      case 'save_place': return this.actions.savePlace(slots.name);

      case 'repeat': {
        const last = this.voice.lastSpokenText();
        return this.say(last || 'Non ho nulla da ripetere, signore.');
      }
      case 'verbosity': {
        this.settings.set({ verbosity: slots.value });
        this.voice.setVerbosity(slots.value);
        return this.say(slots.value === 'essential' ? Persona.verbosityEssential() : Persona.verbosityNormal());
      }
      case 'time': return this.say(`Sono le ${clockText(new Date(this.now()))}.`);
      case 'help':
        return this.say('Può chiedermi di navigare, dirle quanto manca, cercare un percorso alternativo, il meteo, cosa c\'è davanti, comandare la musica o consultare l\'agenda.');
      default: return this.chat(raw);
    }
  }

  musicError(e, q) {
    if (e?.code === 'youtube_not_configured') return Persona.musicNotConfigured();
    if (e?.code === 'not_found') return Persona.musicNotFound(q || 'musica');
    return 'Non riesco ad avviare la musica in questo momento, signore.';
  }

  async weatherAnswer(scope, fix) {
    const nav = this.navigator;
    if (scope === 'destination') {
      if (!nav.active || !nav.destination || !nav.progress) return Persona.noRoute();
      const w = await this.weather.at(nav.destination, nav.progress.eta.getTime());
      if (!w) return 'Non ho previsioni per la destinazione, signore.';
      return `A destinazione, alle ${clockText(nav.progress.eta)}, sono previsti ${Math.round(w.tempC)} gradi, ${w.label}.`;
    }
    if (scope === 'route') {
      if (!nav.active) return Persona.noRoute();
      const along = await this.weather.alongRoute(nav.route, nav.progress?.alongM ?? 0);
      const w = along.worst;
      if (!w) return 'Lungo il percorso non sono previste condizioni critiche, signore.';
      return Persona.weatherWarning(w.kind, { atM: w.distM, inMin: w.etaMin, whileDriving: true });
    }
    if (!fix) return 'Non ho ancora la posizione, signore.';
    const c = await this.weather.current(fix);
    const later = await this.weather.at(fix, this.now() + 2 * 3600000).catch(() => null);
    const tail = later?.risk && later.risk !== c.risk ? ` Nelle prossime due ore: ${later.label}.` : '';
    return `Ci sono ${Math.round(c.tempC)} gradi, ${c.label}.${tail}`;
  }

  async chat(text) {
    if (!this.api.services?.ai) return this.say(Persona.didntUnderstand());
    const nowStr = new Date(this.now()).toLocaleString('it-IT', { dateStyle: 'full', timeStyle: 'short' });
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT(nowStr, this.engine.toPromptContext()) },
      ...this.history.slice(-6),
      { role: 'user', content: text },
    ];
    let reply;
    try { reply = await this.api.chat(messages, { maxTokens: 160, temperature: 0.5 }); }
    catch (e) { return this.say(e?.code === 'unauthorized' ? Persona.sessionExpired() : Persona.aiUnavailable()); }

    const action = parseAiAction(reply);
    if (action) return this.runAiAction(action, text);
    const speech = cleanSpeech(reply);
    if (!speech) return this.say(Persona.didntUnderstand());
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: speech });
    if (this.history.length > 12) this.history.splice(0, this.history.length - 12);
    this.say(speech);
  }

  async runAiAction(a, raw) {
    switch (a.action) {
      case 'navigate': return a.query ? this.actions.navigateTo(String(a.query)) : this.say(Persona.didntUnderstand());
      case 'music': return this.run('music_play', { query: String(a.query || '') }, raw);
      case 'volume': return this.run('volume_set', { value: Math.max(0, Math.min(100, parseInt(a.value, 10) || 0)) }, raw);
      case 'agenda_add': return this.addAgendaFrom(a);
      default: return this.say(Persona.didntUnderstand());
    }
  }

  async aiAgendaAdd(raw) {
    if (!this.api.services?.ai) return this.say('Per aggiungere appuntamenti a voce mi serve il servizio di ragionamento, signore.');
    const nowStr = new Date(this.now()).toISOString();
    const out = await this.api.chat([
      { role: 'system', content: `Estrai un appuntamento dalla frase. Data e ora locali attuali (ISO): ${nowStr}. Rispondi SOLO con JSON: {"action":"agenda_add","title":"...","start":"AAAA-MM-GGTHH:MM","place":"..."} (place vuoto se assente). Se manca l'ora rispondi {"error":"ora"}.` },
      { role: 'user', content: raw },
    ], { maxTokens: 120, temperature: 0 });
    const a = parseAiAction(out);
    if (!a) return this.say('Non ho capito data e ora dell\'appuntamento, signore. Può ripetere?');
    return this.addAgendaFrom(a);
  }

  addAgendaFrom(a) {
    const start = new Date(a.start).getTime();
    if (!Number.isFinite(start) || start < this.now() - 60000) return this.say('Non ho capito quando, signore. Può ripetere con giorno e ora?');
    this.agenda.add({ title: a.title || 'Appuntamento', start, place: a.place || '' });
    this.say(`Annotato: "${a.title || 'Appuntamento'}" alle ${clockText(start)}${a.place ? `, a ${a.place}` : ''}.`);
  }
}

