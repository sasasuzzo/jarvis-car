// Musica controllabile a voce, tramite il player YouTube incorporato (IFrame API).
// La ricerca passa dal Worker (la chiave YouTube non è nel browser). Le playlist
// salvate nelle impostazioni (ID playlist YouTube) funzionano anche senza ricerca.
// Gli annunci vocali hanno priorità: durante la voce la musica viene abbassata (ducking).

import { clamp, norm, bus as defaultBus } from './util.js';

const MOODS = [
  [/energic|carica|ritmo|dinamic|grintos|sveglia/, 'musica energica per guidare'],
  [/rilassa|calm|tranquill|chill|dolce/, 'musica rilassante per guidare'],
  [/rock/, 'rock classico playlist'],
  [/pop italian|italiana|italiano/, 'hit pop italiane'],
  [/\bpop\b/, 'pop hits playlist'],
  [/classic/, 'musica classica rilassante'],
  [/jazz/, 'jazz per viaggiare'],
  [/lo ?fi/, 'lofi chill beats'],
  [/anni 80|ottanta/, 'hit anni 80'],
  [/anni 90|novanta/, 'hit anni 90'],
  [/napoletan/, 'musica napoletana'],
  [/neomelodic/, 'neomelodici'],
  [/trap|rap|hip ?hop/, 'rap italiano hit'],
  [/dance|elettronic|house|techno/, 'dance electronic driving mix'],
];

/** Trasforma una richiesta ("qualcosa di energico", "Vasco Rossi") in una ricerca. */
export function musicQuery(request) {
  const t = norm(request)
    .replace(/^(metti|mettimi|fammi sentire|riproduci|suona|vorrei ascoltare|voglio ascoltare|ascoltare)\s+/, '')
    .replace(/^(un po di|qualcosa di|qualcosa|della|del|dei|di)\s+/, '')
    .replace(/^(musica|canzoni|brani)\s*(di|dei|del|della)?\s*/, '')
    .trim();
  for (const [re, q] of MOODS) if (re.test(t)) return q;
  return t || 'musica';
}

let apiPromise = null;
export function loadYouTubeApi(doc = globalThis.document) {
  if (globalThis.YT?.Player) return Promise.resolve(globalThis.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = globalThis.onYouTubeIframeAPIReady;
    globalThis.onYouTubeIframeAPIReady = () => { prev?.(); resolve(globalThis.YT); };
    const s = doc.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('YouTube non raggiungibile')); };
    doc.head.appendChild(s);
  });
  return apiPromise;
}

export class MusicPlayer {
  constructor({ api, containerId = 'yt-player', bus = defaultBus } = {}) {
    this.api = api; this.containerId = containerId; this.bus = bus;
    this.player = null;
    this.ready = false;
    this.volume = 70;          // volume scelto dall'utente (0..100)
    this.ducked = false;
    this.title = '';
    this.playing = false;
    this.queue = [];
    this.available = null;     // ricerca musicale configurata?
    this.lastError = '';
  }

  /** Va chiamato dopo un gesto dell'utente (autoplay). */
  async init() {
    if (this.player) return;
    const YT = await loadYouTubeApi();
    await new Promise((resolve) => {
      this.player = new YT.Player(this.containerId, {
        height: '200', width: '200',
        playerVars: { playsinline: 1, controls: 0, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => { this.ready = true; this._applyVolume(); resolve(); },
          onStateChange: (e) => this._onState(e.data),
          onError: (e) => {
            this.lastError = 'errore player ' + e.data;
            // 101/150: video non incorporabile -> passa al successivo
            if ([100, 101, 150, 5].includes(e.data)) try { this.player.nextVideo(); } catch { /* ignora */ }
          },
        },
      });
    });
  }

  _onState(s) {
    // 1 = in riproduzione, 2 = pausa, 0 = finito
    this.playing = s === 1 || s === 3;
    try { this.title = this.player.getVideoData?.().title || this.title; } catch { /* ignora */ }
    this.bus.emit('music:state', this.state());
  }

  state() {
    return { ready: this.ready, playing: this.playing, title: this.title, volume: this.volume, queued: this.queue.length };
  }

  _applyVolume() {
    if (!this.ready) return;
    const v = this.ducked ? Math.round(this.volume * 0.25) : this.volume;
    try { this.player.setVolume(clamp(v, 0, 100)); } catch { /* ignora */ }
  }

  // ------------------------------------------------------------------ comandi
  async searchAndPlay(request) {
    await this.init();
    const q = musicQuery(request);
    let res;
    try {
      res = await this.api.musicSearch(q, 15);
      this.available = true;
    } catch (e) {
      this.available = e.code === 'youtube_not_configured' ? false : this.available;
      this.lastError = e.code || e.message;
      throw e;
    }
    const ids = (res.items || []).map((i) => i.id);
    if (!ids.length) { const err = new Error('nessun risultato'); err.code = 'not_found'; throw err; }
    this.queue = res.items;
    this.title = res.items[0].title;
    this.player.loadPlaylist({ playlist: ids, index: 0 });
    this._applyVolume();
    return res.items[0];
  }

  async playPlaylist(playlistId) {
    await this.init();
    this.queue = [];
    this.player.loadPlaylist({ list: playlistId, listType: 'playlist', index: 0 });
    this._applyVolume();
  }

  pause() { try { this.player?.pauseVideo(); } catch { /* ignora */ } }
  resume() { try { this.player?.playVideo(); } catch { /* ignora */ } }
  next() { try { this.player?.nextVideo(); } catch { /* ignora */ } }
  prev() { try { this.player?.previousVideo(); } catch { /* ignora */ } }

  setVolume(pct) { this.volume = clamp(Math.round(pct), 0, 100); this._applyVolume(); this.bus.emit('music:state', this.state()); return this.volume; }
  adjustVolume(delta) { return this.setVolume(this.volume + delta); }

  /** Ducking: abbassa mentre JARVIS parla. */
  duck() { if (this.ducked) return; this.ducked = true; this._applyVolume(); }
  unduck() { if (!this.ducked) return; this.ducked = false; this._applyVolume(); }
}
