// Meteo reale (Open-Meteo, senza chiave): condizioni attuali, previsioni orarie e
// condizioni lungo il percorso all'ora in cui ci si arriverà davvero.

import { CONFIG } from './config.js';
import { pointAtDistance } from './util.js';
import { timeRemainingAt } from './navigation.js';

const LABEL = {
  0: 'sereno', 1: 'prevalentemente sereno', 2: 'parzialmente nuvoloso', 3: 'coperto',
  45: 'nebbia', 48: 'nebbia con brina',
  51: 'pioviggine debole', 53: 'pioviggine', 55: 'pioviggine intensa', 56: 'pioviggine gelata', 57: 'pioviggine gelata intensa',
  61: 'pioggia debole', 63: 'pioggia', 65: 'pioggia intensa', 66: 'pioggia gelata', 67: 'pioggia gelata intensa',
  71: 'neve debole', 73: 'neve', 75: 'neve intensa', 77: 'granelli di neve',
  80: 'rovesci deboli', 81: 'rovesci', 82: 'rovesci violenti', 85: 'rovesci di neve', 86: 'rovesci di neve intensi',
  95: 'temporale', 96: 'temporale con grandine', 99: 'temporale con forte grandine',
};
export const describeCode = (c) => LABEL[c] ?? 'condizioni variabili';

const SEVERITY = { thunderstorm: 5, snow: 4, ice: 4, heavyRain: 4, fog: 3, wind: 3, rain: 1 };
export const severityOf = (k) => SEVERITY[k] ?? 0;

/**
 * Classifica un'ora di previsione in un rischio per la guida (o null).
 * precip in mm/h, visibilità in metri, raffiche in km/h.
 */
export function classifyHour({ code, precip = 0, visibilityM = null, gustKmh = 0, tempC = null }) {
  if ([95, 96, 99].includes(code)) return 'thunderstorm';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([56, 57, 66, 67].includes(code)) return 'ice';
  if (tempC != null && tempC <= 2 && precip >= 0.2) return 'ice';
  if (code === 65 || code === 82 || precip >= 4) return 'heavyRain';
  if ([45, 48].includes(code) || (visibilityM != null && visibilityM < 1000)) return 'fog';
  if (gustKmh >= 65) return 'wind';
  if ([51, 53, 55, 61, 63, 80, 81].includes(code) || precip >= 0.5) return 'rain';
  return null;
}

const HOURLY = 'temperature_2m,precipitation,precipitation_probability,weather_code,visibility,wind_gusts_10m';
const CURRENT = 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,visibility';

export function parseForecast(json) {
  const arr = Array.isArray(json) ? json : [json];
  return arr.map((loc) => {
    const h = loc.hourly ?? {};
    const hours = (h.time ?? []).map((t, i) => ({
      t: Date.parse(t + 'Z'),                        // richiesto con timezone=GMT
      tempC: h.temperature_2m?.[i] ?? null,
      precip: h.precipitation?.[i] ?? 0,
      prob: h.precipitation_probability?.[i] ?? null,
      code: h.weather_code?.[i] ?? 0,
      visibilityM: h.visibility?.[i] ?? null,
      gustKmh: h.wind_gusts_10m?.[i] ?? 0,
    }));
    const c = loc.current ?? null;
    return {
      lat: loc.latitude, lon: loc.longitude,
      current: c && {
        tempC: c.temperature_2m, feelsC: c.apparent_temperature, precip: c.precipitation, code: c.weather_code,
        windKmh: c.wind_speed_10m, gustKmh: c.wind_gusts_10m, visibilityM: c.visibility ?? null,
        label: describeCode(c.weather_code),
      },
      hours,
    };
  });
}

/** L'ora di previsione che contiene l'istante t (o la più vicina se fuori intervallo). */
export function hourAt(hours, t) {
  const inside = hours.find((h) => t >= h.t && t < h.t + 3600000);
  if (inside) return inside;
  let best = null;
  for (const h of hours) if (!best || Math.abs(h.t - t) < Math.abs(best.t - t)) best = h;
  return best;
}

export class WeatherService {
  constructor({ fetchImpl, now = () => Date.now(), cfg = CONFIG.weather } = {}) {
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.now = now; this.cfg = cfg;
    this.cache = new Map();
    this.last = { current: null, along: null };
    this.available = null;
    this.lastError = '';
  }

  async _get(points) {
    const key = points.map((p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`).join('|');
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < 10 * 60000) return hit.data;
    const p = new URLSearchParams({
      latitude: points.map((x) => x.lat.toFixed(4)).join(','),
      longitude: points.map((x) => x.lon.toFixed(4)).join(','),
      current: CURRENT, hourly: HOURLY, forecast_days: '2', timezone: 'GMT', wind_speed_unit: 'kmh',
    });
    try {
      const r = await this.fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
      if (!r.ok) throw new Error('meteo ' + r.status);
      const data = parseForecast(await r.json());
      this.cache.set(key, { at: this.now(), data });
      this.available = true; this.lastError = '';
      return data;
    } catch (e) {
      this.available = false; this.lastError = e?.message || 'errore';
      throw e;
    }
  }

  async current(pos) {
    const [loc] = await this._get([pos]);
    this.last.current = loc.current;
    return { ...loc.current, risk: classifyHour({ ...loc.current, tempC: loc.current.tempC }) };
  }

  /** Previsione in un punto a una certa ora (ms). */
  async at(pos, whenMs) {
    const [loc] = await this._get([pos]);
    const h = hourAt(loc.hours, whenMs);
    return h ? { ...h, label: describeCode(h.code), risk: classifyHour(h) } : null;
  }

  /**
   * Condizioni lungo il percorso, valutate all'ora prevista di arrivo in ciascun punto.
   * @returns {samples:[{atM, distM, etaMin, kind, tempC, code, precip, visibilityM, label}], worst}
   */
  async alongRoute(route, alongM = 0, startMs = this.now(), delayStartS = 0) {
    const total = route.lengthM;
    const n = Math.max(2, this.cfg.samples);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const d = alongM + ((total - alongM) * i) / (n - 1);
      const p = pointAtDistance(route.points, route.cum, d);
      pts.push({ lat: p.lat, lon: p.lon, d });
    }
    const locs = await this._get(pts);
    const remainingNow = timeRemainingAt(route, alongM);
    const samples = locs.map((loc, i) => {
      const toReachS = delayStartS + (remainingNow - timeRemainingAt(route, pts[i].d));
      const eta = startMs + toReachS * 1000;
      const h = hourAt(loc.hours, eta);
      const kind = h ? classifyHour(h) : null;
      return {
        atM: pts[i].d, distM: pts[i].d - alongM, etaMin: Math.round(toReachS / 60), eta,
        kind, tempC: h?.tempC ?? null, code: h?.code ?? null, precip: h?.precip ?? 0,
        visibilityM: h?.visibilityM ?? null, label: h ? describeCode(h.code) : '',
        lat: pts[i].lat, lon: pts[i].lon,
      };
    });
    const worst = samples.reduce((a, s) => (severityOf(s.kind) > severityOf(a?.kind) ? s : a), null);
    this.last.along = { samples, worst: worst && worst.kind ? worst : null };
    return this.last.along;
  }
}
