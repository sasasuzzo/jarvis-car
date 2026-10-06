// Impostazioni utente, salvate solo su questo dispositivo.

import { store, bus } from './util.js';

export const DEFAULTS = {
  verbosity: 'normal',          // 'normal' | 'essential' (solo avvisi importanti)
  voiceURI: '',                 // voce di sistema scelta ('' = migliore italiana disponibile)
  voiceRate: 1.02,
  voicePitch: 0.9,
  wakeWord: true,               // ascolto continuo della parola "Jarvis"
  keepScreenOn: true,
  theme: 'auto',                // 'auto' | 'dark' | 'light'
  cameraEnabled: false,         // la fotocamera si attiva solo se l'utente lo sceglie
  trafficLightVision: false,    // sperimentale: stato del semaforo dalla fotocamera
  accidentDetection: true,
  emergencyNumber: '112',
  emergencyContactName: '',
  emergencyContactNumber: '',
  breakReminder: true,          // consiglio di pausa dopo 2 ore di guida continua
  autoAcceptAlternative: true,  // adotta da sola un'alternativa molto più veloce (annullabile)
  avoidTolls: false,
  avoidMotorways: false,
  icsUrl: '',                   // indirizzo iCal (es. "indirizzo segreto" di Google Calendar)
  playlists: {},                // nome -> ID playlist YouTube
  bufferMin: 5,                 // margine di sicurezza per i consigli di partenza
};

let current = { ...DEFAULTS, ...(store.get('settings', {}) || {}) };

export const settings = {
  all: () => ({ ...current }),
  get: (k) => current[k],
  set(patch) {
    current = { ...current, ...patch };
    store.set('settings', current);
    bus.emit('settings:change', patch);
  },
  reset() {
    current = { ...DEFAULTS };
    store.set('settings', current);
    bus.emit('settings:change', current);
  },
};

/** Tema effettivo: "auto" segue il sistema. */
export function resolveTheme(pref = settings.get('theme')) {
  if (pref === 'light' || pref === 'dark') return pref;
  return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme() {
  const t = resolveTheme();
  if (globalThis.document) {
    document.body.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f1f4f8' : '#0e1319');
  }
  return t;
}
