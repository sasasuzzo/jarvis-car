// Personalità di JARVIS CAR: tono professionale, elegante, preciso, calmo.
// "Signore" con misura (non a ogni frase), ironia rara e MAI negli avvisi di sicurezza.
// Qui nascono tutte le frasi: i moduli raccolgono dati, la persona li racconta.

import { distanceSpeech, durationSpeech, numberToItalian, clockText } from './util.js';

const lastPick = new Map();
function pick(key, options) {
  if (options.length === 1) return options[0];
  let i;
  do { i = Math.floor(Math.random() * options.length); } while (i === lastPick.get(key));
  lastPick.set(key, i);
  return options[i];
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const ORD = ['', 'prima', 'seconda', 'terza', 'quarta', 'quinta', 'sesta', 'settima', 'ottava'];

// ------------------------------------------------------------- appellativo

let sinceSir = 99;   // quante frasi sono passate dall'ultimo "signore"
let lastHumorAt = 0;

/**
 * Aggiunge ", signore" a fine frase con criterio.
 * mode: 'never' (avvisi critici), 'maybe' (se non detto di recente), 'always'.
 */
export function withSir(text, mode = 'maybe') {
  if (!text) return text;
  if (/signore/i.test(text)) { sinceSir = 0; return text; }
  const should = mode === 'always' || (mode === 'maybe' && sinceSir >= 3);
  if (!should) { sinceSir++; return text; }
  sinceSir = 0;
  const m = text.match(/^(.*?)([.!?…]*)$/s);
  return `${m[1]}, signore${m[2] || '.'}`;
}
export function _resetPersona() { sinceSir = 99; lastHumorAt = 0; lastPick.clear(); }

// -------------------------------------------------------------- manovre

const MANEUVER = {
  TURN_RIGHT: { say: 'svolti a destra', icon: 'right' },
  TURN_LEFT: { say: 'svolti a sinistra', icon: 'left' },
  SHARP_RIGHT: { say: 'svolti decisamente a destra', icon: 'sharp-right' },
  SHARP_LEFT: { say: 'svolti decisamente a sinistra', icon: 'sharp-left' },
  BEAR_RIGHT: { say: 'pieghi leggermente a destra', icon: 'slight-right' },
  BEAR_LEFT: { say: 'pieghi leggermente a sinistra', icon: 'slight-left' },
  KEEP_RIGHT: { say: 'mantenga la destra', icon: 'slight-right' },
  KEEP_LEFT: { say: 'mantenga la sinistra', icon: 'slight-left' },
  STRAIGHT: { say: 'prosegua dritto', icon: 'straight' },
  FOLLOW: { say: 'prosegua dritto', icon: 'straight' },
  MAKE_UTURN: { say: 'faccia inversione a U', icon: 'uturn' },
  TRY_MAKE_UTURN: { say: 'faccia inversione a U', icon: 'uturn' },
  ENTER_MOTORWAY: { say: "imbocchi l'autostrada", icon: 'merge' },
  ENTER_FREEWAY: { say: 'imbocchi la superstrada', icon: 'merge' },
  ENTER_HIGHWAY: { say: 'imbocchi la strada a scorrimento veloce', icon: 'merge' },
  ENTRANCE_RAMP: { say: 'imbocchi la rampa', icon: 'merge' },
  TAKE_EXIT: { say: "prenda l'uscita", icon: 'exit-right' },
  MOTORWAY_EXIT_RIGHT: { say: "prenda l'uscita a destra", icon: 'exit-right' },
  MOTORWAY_EXIT_LEFT: { say: "prenda l'uscita a sinistra", icon: 'exit-left' },
  SWITCH_PARALLEL_ROAD: { say: 'passi alla carreggiata parallela', icon: 'straight' },
  SWITCH_MAIN_ROAD: { say: 'si immetta sulla strada principale', icon: 'straight' },
  ROUNDABOUT_CROSS: { say: 'alla rotatoria prosegua dritto', icon: 'roundabout' },
  ROUNDABOUT_RIGHT: { say: 'alla rotatoria', icon: 'roundabout' },
  ROUNDABOUT_LEFT: { say: 'alla rotatoria', icon: 'roundabout' },
  ROUNDABOUT_BACK: { say: 'alla rotatoria torni indietro', icon: 'roundabout' },
  ARRIVE: { say: 'sarà arrivato a destinazione', icon: 'arrive' },
  ARRIVE_LEFT: { say: 'la destinazione è sulla sinistra', icon: 'arrive' },
  ARRIVE_RIGHT: { say: 'la destinazione è sulla destra', icon: 'arrive' },
};

/** Frase di manovra senza distanza, es. "svolti a destra in Via Roma". */
export function maneuverPhrase(instr, { withStreet = true } = {}) {
  const base = MANEUVER[instr.maneuver];
  let say;
  if (base) {
    say = base.say;
    if (instr.maneuver.startsWith('ROUNDABOUT') && instr.maneuver !== 'ROUNDABOUT_CROSS' && instr.maneuver !== 'ROUNDABOUT_BACK') {
      const n = instr.roundaboutExit;
      say += n ? ` prenda la ${ORD[n] || `${n}ª`} uscita` : ' segua le indicazioni';
    }
  } else {
    // manovra non mappata: si usa il testo italiano fornito dal servizio
    say = (instr.message || 'prosegua').replace(/\.$/, '');
    say = say[0].toLowerCase() + say.slice(1);
    return say;
  }
  if (instr.signpost && /exit|motorway|MOTORWAY|TAKE_EXIT|ENTER/.test(instr.maneuver)) say += ` in direzione ${instr.signpost}`;
  else if (withStreet && instr.street && !instr.maneuver.startsWith('ARRIVE')) say += ` in ${instr.street}`;
  return say;
}

export function maneuverIcon(maneuver) {
  return MANEUVER[maneuver]?.icon ?? 'straight';
}

// ------------------------------------------------------------- frasi

export const Persona = {
  // --- avvio
  carModeOn: () => 'Modalità Macchina attivata, signore.',
  carModeOff: () => 'Modalità Macchina disattivata. Buon proseguimento, signore.',
  gpsAcquired: () => 'Posizione acquisita.',
  gpsWaiting: () => 'Sto cercando il segnale GPS.',
  gpsDenied: () => 'Non ho il permesso di usare la posizione, signore. Senza GPS non posso guidarla.',
  gpsLost: () => 'Segnale GPS perso. Navigazione sospesa.',
  gpsBack: () => 'Segnale GPS ripristinato.',
  askDestination: () => 'Destinazione?',
  micDenied: () => 'Il microfono non è disponibile, signore. Può comunque usare i comandi a schermo.',
  noSpeechRecognition: () => 'Questo browser non supporta il riconoscimento vocale. Per i comandi vocali consiglio Chrome.',

  // --- destinazione e percorso
  destinationNotFound: (q) => `Non trovo "${q}", signore. Può ripetere o essere più preciso?`,
  routeFailed: () => 'Non riesco a calcolare il percorso in questo momento, signore.',
  routeSet: ({ timeS, name }) =>
    `Destinazione impostata${name ? `: ${name}` : ''}. Tempo stimato di percorrenza: ${durationSpeech(timeS)}.`,
  navStart: () => pick('navStart', ['Navigazione attiva, signore.', 'Modalità di navigazione attiva, signore.']),
  trafficSummary(level, delayS) {
    if (level === 'scorrevole') return 'Traffico scorrevole lungo il percorso.';
    if (level === 'moderato') return 'Traffico moderato lungo il percorso.';
    const d = delayS >= 90 ? `, con circa ${durationSpeech(delayS)} di ritardo` : '';
    return level === 'molto intenso'
      ? `Traffico molto intenso lungo il percorso${d}.`
      : `Traffico intenso lungo il percorso${d}.`;
  },
  eta: ({ remainingS, remainingM, arrival }) =>
    `Mancano ${durationSpeech(remainingS)}, ${distanceSpeech(remainingM)}. Arrivo previsto alle ${clockText(arrival)}.`,
  noRoute: () => 'Non c\'è una navigazione attiva, signore. Mi indichi una destinazione.',
  navStopped: () => 'Navigazione terminata, signore.',
  arrival: () => pick('arrival', ['Siamo arrivati a destinazione, signore.', 'Destinazione raggiunta, signore.']),

  // --- manovre
  turn(stage, distM, instr, { next } = {}) {
    const phrase = maneuverPhrase(instr, { withStreet: stage === 'far' });
    if (stage === 'near') return `Ora ${phrase}.`.replace('Ora alla rotatoria', 'Ora, alla rotatoria');
    const then = next ? `, poi ${maneuverPhrase(next, { withStreet: false })}` : '';
    return `Tra ${distanceSpeech(distM)}, ${phrase}${then}.`;
  },

  // --- ricalcolo
  offRoute: () => 'Ho perso il percorso. Ricalcolo.',
  rerouted: () => 'Ho aggiornato il percorso, signore.',
  trafficIncreased: () => 'Il traffico sul percorso principale è aumentato, signore. Sto verificando un percorso alternativo.',
  trafficIncreasedNow: (deltaS) =>
    `Il traffico sul percorso principale è aumentato, signore: ora il ritardo stimato è di ${durationSpeech(deltaS)} in più.`,
  checkingAlternative: () => 'Sto verificando un percorso alternativo.',
  noAlternative: () => 'Ho verificato: non esistono alternative più convenienti, signore. Resto sul percorso attuale.',
  altFound: (savingS) => `Ho trovato un percorso migliore. Risparmio stimato: ${durationSpeech(savingS, { words: true })}.`,
  altAdopted: () => 'Lo seguo da qui. Se preferisce il precedente, dica "annulla".',
  altRevert: () => 'Torno al percorso precedente.',
  altKept: () => 'Resto sul percorso attuale, signore.',

  // --- autovelox / semafori
  cameraAhead: (m, limit) =>
    `Autovelox rilevato tra circa ${distanceSpeech(m)}${limit ? `, limite ${limit}` : ''}.`,
  cameraNear: (m, limit) => `Autovelox tra ${distanceSpeech(m)}${limit ? `. Limite ${limit}` : ''}.`,
  speedOverLimit: (limit, speed) => `Attenzione, limite ${limit}. Sta viaggiando a ${speed}.`,
  lightAhead: (m) => `Semaforo tra circa ${distanceSpeech(m)}.`,
  lightState: (state, m) => {
    const s = { red: 'rosso', green: 'verde', amber: 'giallo' }[state] || state;
    return `Semaforo ${s} tra circa ${distanceSpeech(m)}.`;
  },
  lightGreen: () => 'Il semaforo è appena diventato verde, signore.',

  // --- traffico
  jamAhead: (m, delayS) =>
    `Rallentamento rilevato più avanti, tra ${distanceSpeech(m)}${delayS >= 90 ? `: circa ${durationSpeech(delayS)} di ritardo` : ''}.`,
  incidentAhead(kind, m) {
    const k = {
      accident: 'Incidente segnalato', closed: 'Strada chiusa', works: 'Lavori in corso', jam: 'Coda segnalata',
      breakdown: 'Veicolo fermo segnalato', hazard: 'Pericolo segnalato', other: 'Evento segnalato',
    }[kind] || 'Evento segnalato';
    return `${k} tra ${distanceSpeech(m)}.`;
  },

  // --- meteo
  weatherWarning(kind, { atM, inMin, whileDriving }) {
    const lead = {
      thunderstorm: 'Sono previsti temporali',
      heavyRain: 'È prevista pioggia intensa',
      rain: 'È prevista pioggia',
      fog: 'È segnalata nebbia',
      snow: 'È prevista neve',
      ice: 'Esiste un rischio di ghiaccio',
      wind: 'È previsto vento forte',
    }[kind] || 'È previsto maltempo';
    const where = atM > 1500 ? `, dopo circa ${distanceSpeech(atM)}` : '';
    const when = inMin != null && inMin > 3 ? ` (tra circa ${durationSpeech(inMin * 60)})` : '';
    const tip = kind === 'fog' ? 'Mantenga le distanze e usi i fari antinebbia.'
      : kind === 'ice' ? 'Prudenza sui tratti ombreggiati e sui ponti.'
      : whileDriving ? 'Suggerisco prudenza.' : 'Suggerisco di partire con qualche minuto di anticipo.';
    return `${lead} lungo il percorso${where}${when}. ${tip}`;
  },

  // --- agenda / consigli
  leaveBy: ({ title, startsAt, leaveAt, reasons = [] }) => {
    const head = `Il suo appuntamento${title ? ` "${title}"` : ''} è alle ${clockText(startsAt)}.`;
    const why = reasons.length ? `Considerando ${reasons.join(' e ')}, suggerisco` : 'Suggerisco';
    return `${head} ${why} di partire entro le ${clockText(leaveAt)}.`;
  },
  leaveNow: ({ title, startsAt }) => `Signore, per l'appuntamento${title ? ` "${title}"` : ''} delle ${clockText(startsAt)} è il momento di partire.`,
  lateForAppointment: ({ title, startsAt, lateS }) =>
    `Con le condizioni attuali arriverà circa ${durationSpeech(lateS)} dopo l'orario dell'appuntamento${title ? ` "${title}"` : ''} delle ${clockText(startsAt)}.`,
  breakSuggestion: (h) => `Guida da ${h === 1 ? 'un\'ora' : `${numberToItalian(h)} ore`}, signore. Le consiglio una breve pausa alla prossima occasione sicura.`,
  conditionsAdvice: (parts) => `Considerando ${parts.join(' e ')}, suggerisco prudenza.`,

  // --- incidente
  accidentAsk: () => 'Signore, ho rilevato un evento anomalo. Sta bene?',
  accidentReask: () => 'Signore, mi risponda. Sta bene?',
  accidentEscalate: () => 'Non ricevo risposta. Le mostro il pulsante per chiamare il 112.',
  accidentRepeat: () => 'Tocchi il pulsante per chiamare il 112, oppure dica "sto bene".',
  accidentOk: () => 'Bene, signore. Segnalo come falso allarme.',

  // --- musica / comandi
  musicPlaying: (title) => (title ? `In riproduzione: ${title}.` : 'Musica in riproduzione.'),
  musicPaused: () => 'Musica in pausa.',
  musicResumed: () => 'Riprendo la musica.',
  musicNotConfigured: () => 'La ricerca musicale non è configurata sul server, signore.',
  musicNotFound: (q) => `Non ho trovato musica per "${q}", signore.`,
  volumeSet: (pct) => `Volume al ${pct} percento.`,
  nothingAhead: () => 'Davanti a lei non risulta nulla di rilevante, signore.',
  verbosityEssential: () => 'D\'accordo. Parlerò solo per gli avvisi importanti.',
  verbosityNormal: () => 'Torno a una comunicazione completa, signore.',
  didntUnderstand: () => 'Non ho capito il comando, signore.',
  aiUnavailable: () => 'Non riesco a contattare il mio servizio di ragionamento in questo momento, signore.',
  sessionExpired: () => 'La sessione è scaduta, signore. Deve accedere di nuovo.',

  // --- ironia: rara, solo informativa, mai in sicurezza
  maybeHumor(kind, now = Date.now(), hour = new Date().getHours()) {
    if (now - lastHumorAt < 15 * 60000) return '';
    const lines = {
      trafficHeavy: [
        `Il traffico sembra aver deciso di collaborare poco ${hour >= 17 ? 'questa sera' : 'oggi'}.`,
        'La strada oggi mette alla prova la pazienza di entrambi, signore.',
      ],
      tripStart: ['Cintura allacciata? Io non ho mani, ma ho una certa fiducia in lei.'],
      longTrip: ['Un viaggio di una certa dignità, signore. Provvedo io a tenerla informata.'],
    }[kind];
    if (!lines) return '';
    lastHumorAt = now;
    return pick('humor:' + kind, lines);
  },
};

export { cap };
