// Configurazione pubblica di JARVIS CAR.
// ATTENZIONE: qui NON vanno mai chiavi API, password o token. Le chiavi
// (Groq, TomTom, YouTube) vivono come secret del Cloudflare Worker (vedi worker/).
// L'URL del Worker non è un segreto: si può scrivere qui oppure inserire
// dalla schermata di accesso (viene salvato solo su questo dispositivo).

import { store } from './util.js';

export const CONFIG = {
  /** URL del Worker, es. "https://jarvis-car.<account>.workers.dev". Vuoto = chiesto al primo accesso. */
  workerUrl: '',

  locale: 'it-IT',
  appVersion: '1.0.0',

  map: {
    // Mappa scura di CARTO (dati © OpenStreetMap). Uso non commerciale con attribuzione.
    tiles: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    subdomains: 'abcd',
    attribution: '© OpenStreetMap,
    maxZoom: 19,
  },

  // Server Overpass (OpenStreetMap) per autovelox e semafori; si prova in ordine.
  overpass: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ],

  gps: {
    maxAccuracyM: 80,       // fix peggiori di così vengono scartati
    lostAfterMs: 12000,     // oltre, "segnale GPS perso"
  },

  nav: {
    offRouteM: 45,              // distanza dalla rotta oltre la quale si considera fuori strada
    offRouteFixes: 3,           // fix consecutivi fuori rotta prima di ricalcolare
    recheckEveryMs: 120000,     // ogni quanto cercare alternative / aggiornare l'ETA col traffico
    minSavingS: 240,            // risparmio minimo per proporre/accettare un'alternativa
    minSavingPct: 0.08,
    altCooldownMs: 180000,      // dopo un cambio rotta non si rivaluta prima di questo tempo
    arrivalM: 35,
  },

  traffic: {
    incidentPollMs: 90000,
    incidentHorizonM: 15000,
    jamAnnounceHorizonM: 3500,
    delayJumpS: 180,            // aumento del ritardo che fa dire "il traffico è aumentato"
  },

  weather: {
    refreshMs: 15 * 60000,
    samples: 6,
  },

  accident: {
    minPreSpeedKmh: 25,
    impactG: 3.5,               // picco senza conferma della fotocamera
    impactGWithCamera: 2.5,     // picco con conferma della fotocamera
    postSpeedMaxKmh: 15,
    askTimeoutMs: 12000,
    cooldownMs: 5 * 60000,
  },

  voice: {
    rate: 1.02,
    pitch: 0.9,
    wakeWindowMs: 8000,
  },
};

// Priorità: impostazione salvata sul dispositivo > config.js
export function getWorkerUrl() {
  const saved = store.get('workerUrl', '');
  return String(saved || CONFIG.workerUrl || '').replace(/\/+$/, '');
}
export function setWorkerUrl(url) {
  store.set('workerUrl', String(url || '').trim().replace(/\/+$/, ''));
}
