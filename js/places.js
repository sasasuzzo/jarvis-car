// Luoghi salvati ("casa", "lavoro", ...): permettono "JARVIS, portami al lavoro".
// Vivono solo su questo dispositivo.

import { store, norm } from './util.js';

const ALIASES = {
  casa: ['casa', 'a casa', 'home'],
  lavoro: ['lavoro', 'al lavoro', 'ufficio', 'in ufficio', 'al lavoro'],
};

export class Places {
  constructor() { this.map = store.get('places', {}) || {}; }

  all() { return { ...this.map }; }

  set(name, place) {
    const key = this.canonical(name);
    this.map[key] = { name: place.name || key, lat: place.lat, lon: place.lon, address: place.address || '' };
    store.set('places', this.map);
  }

  remove(name) {
    delete this.map[this.canonical(name)];
    store.set('places', this.map);
  }

  canonical(name) {
    const n = norm(name).replace(/^(a|al|alla|in|il|la|lo)\s+/, '');
    for (const [k, list] of Object.entries(ALIASES)) if (list.map(norm).includes(n) || k === n) return k;
    return n;
  }

  /** "al lavoro" -> luogo salvato, oppure null. */
  resolve(text) {
    const key = this.canonical(text);
    return this.map[key] ?? null;
  }
}
