// Client del Worker: unico punto di uscita verso Groq, TomTom, YouTube, iCal.
// Il browser non conosce nessuna chiave: possiede solo un token di sessione.

import { getWorkerUrl } from './config.js';
import { store, bus } from './util.js';

export class ApiError extends Error {
  constructor(code, status = 0, detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.status = status;
  }
}

export class Api {
  constructor({ fetchImpl, getBase = getWorkerUrl } = {}) {
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.getBase = getBase;
    this.services = null; // { ai, maps, music } dopo check()
  }

  // ------------------------------------------------------------ sessione
  get session() {
    const s = store.get('session', null);
    if (!s || !s.token || !s.expiresAt || s.expiresAt <= Date.now()) return null;
    return s;
  }
  get hasSession() { return !!this.session; }
  logout() { store.del('session'); this.services = null; }

  async login(username, password) {
    const data = await this._req('auth/login', { method: 'POST', body: { username, password }, auth: false, timeoutMs: 12000 });
    store.set('session', { token: data.token, expiresAt: data.expiresAt });
    return data;
  }

  async check() {
    const data = await this._req('auth/check', { timeoutMs: 10000 });
    this.services = data.services || {};
    return data;
  }

  // ------------------------------------------------------------- servizi
  /** @returns {Promise<string>} testo della risposta */
  async chat(messages, { maxTokens = 220, temperature = 0.6 } = {}) {
    const data = await this._req('ai/chat', { method: 'POST', body: { messages, max_tokens: maxTokens, temperature }, timeoutMs: 20000 });
    return data.text || '';
  }

  /** Rotta con traffico in tempo reale, alternative, istruzioni in italiano. */
  routeRaw({ from, to, avoid = [], alternatives = 2, heading = null }) {
    const p = new URLSearchParams({
      traffic: 'true',
      travelMode: 'car',
      routeType: 'fastest',
      maxAlternatives: String(alternatives),
      instructionsType: 'text',
      language: 'it-IT',
      computeTravelTimeFor: 'all',
      routeRepresentation: 'polyline',
    });
    p.append('sectionType', 'traffic');
    for (const a of avoid) p.append('avoid', a);
    if (heading != null && Number.isFinite(heading)) p.set('vehicleHeading', String(Math.round(heading) % 360));
    const loc = `${from.lat.toFixed(6)},${from.lon.toFixed(6)}:${to.lat.toFixed(6)},${to.lon.toFixed(6)}`;
    return this._req(`tt/routing/1/calculateRoute/${loc}/json?${p}`, { timeoutMs: 20000 });
  }

  searchPlaces(query, { near, limit = 5 } = {}) {
    const p = new URLSearchParams({ limit: String(limit), language: 'it-IT', typeahead: 'false', idxSet: 'POI,Geo,Addr,Str,PAD' });
    if (near) { p.set('lat', String(near.lat)); p.set('lon', String(near.lon)); }
    return this._req(`tt/search/2/search/${encodeURIComponent(query)}.json?${p}`, { timeoutMs: 12000 });
  }

  incidents(bbox) {
    const p = new URLSearchParams({
      bbox: `${bbox.minLon.toFixed(5)},${bbox.minLat.toFixed(5)},${bbox.maxLon.toFixed(5)},${bbox.maxLat.toFixed(5)}`,
      fields: '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity}}}',
      language: 'it-IT',
      timeValidityFilter: 'present',
    });
    return this._req(`tt/traffic/services/5/incidentDetails?${p}`, { timeoutMs: 15000 });
  }

  musicSearch(q, n = 12) {
    return this._req(`yt/search?${new URLSearchParams({ q, n: String(n) })}`, { timeoutMs: 12000 });
  }

  /** Audio (mp3) della voce di JARVIS per un testo breve. */
  async tts(text) {
    const base = this.getBase();
    const s = this.session;
    if (!base || !s) throw new ApiError('unauthorized', 401);
    const r = await this._fetch(`${base}/tts?${new URLSearchParams({ text })}`, { headers: { Authorization: `Bearer ${s.token}` } }, 12000);
    if (!r.ok) throw new ApiError('tts_failed', r.status);
    return r.blob();
  }

  async icsText(url) {
    const base = this.getBase();
    const s = this.session;
    if (!base || !s) throw new ApiError('unauthorized', 401);
    const r = await this._fetch(`${base}/ics?${new URLSearchParams({ url })}`, { headers: { Authorization: `Bearer ${s.token}` } }, 15000);
    if (!r.ok) throw new ApiError('ics_failed', r.status);
    return r.text();
  }

  // ------------------------------------------------------------- interno
  async _fetch(url, init, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await this.fetch(url, { ...init, signal: ctl.signal });
    } catch (e) {
      throw new ApiError(e?.name === 'AbortError' ? 'timeout' : 'network', 0, e?.message);
    } finally {
      clearTimeout(t);
    }
  }

  async _req(path, { method = 'GET', body, auth = true, timeoutMs = 15000 } = {}) {
    const base = this.getBase();
    if (!base) throw new ApiError('no_server');
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      const s = this.session;
      if (!s) { bus.emit('auth:expired'); throw new ApiError('unauthorized', 401); }
      headers.Authorization = `Bearer ${s.token}`;
    }
    const r = await this._fetch(`${base}/${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }, timeoutMs);
    let data = null;
    try { data = await r.json(); } catch { /* corpo non JSON */ }
    if (r.status === 401 && auth) { this.logout(); bus.emit('auth:expired'); throw new ApiError('unauthorized', 401); }
    if (!r.ok) throw new ApiError(data?.error || 'http_' + r.status, r.status, data?.detail || data?.error?.description || '');
    return data;
  }
}
