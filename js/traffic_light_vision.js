// Stato del semaforo dalla fotocamera — SPERIMENTALE, disattivato di default.
//
// Principio: meglio tacere che sbagliare. Un colore viene dichiarato solo se
//   1) c'è un disco luminoso, compatto e circondato da un alloggiamento scuro,
//   2) sta nella metà alta dell'immagine (i fanalini delle auto sono in basso),
//   3) non ha un "gemello" alla stessa altezza (fanali posteriori in coppia),
//   4) lo stesso colore compare in quasi tutti gli ultimi fotogrammi,
//   5) (nel monitor) esiste un semaforo mappato entro 260 m davanti.
// Se manca anche una sola condizione, JARVIS dice solo "semaforo tra X metri".
//
// Non è un sistema di sicurezza: l'ultima parola è sempre della segnaletica reale.

function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx / 255 };
}

export function classifyPixel(r, g, b) {
  const { h, s, v } = rgb2hsv(r, g, b);
  if ((h <= 12 || h >= 340) && s >= 0.55 && v >= 0.75) return 'red';
  if (h >= 95 && h <= 175 && s >= 0.4 && v >= 0.7) return 'green';
  if (h >= 25 && h <= 50 && s >= 0.6 && v >= 0.85) return 'amber';
  return null;
}

/** Cerca dischi colorati plausibili in un ImageData; restituisce i candidati migliori. */
export function findLightBlobs(img, { roiFrac = 0.5 } = {}) {
  const { width: W, height: H, data } = img;
  const maxY = Math.floor(H * roiFrac);
  const colorOf = new Array(W * maxY);
  for (let y = 0; y < maxY; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      colorOf[y * W + x] = classifyPixel(data[i], data[i + 1], data[i + 2]);
    }
  }
  const blobs = [];
  const seen = new Uint8Array(W * maxY);
  for (let y0 = 0; y0 < maxY; y0++) {
    for (let x0 = 0; x0 < W; x0++) {
      const idx0 = y0 * W + x0;
      const c = colorOf[idx0];
      if (!c || seen[idx0]) continue;
      // riempimento a pila
      const stack = [idx0];
      seen[idx0] = 1;
      let minX = x0, maxX = x0, minYb = y0, maxYb = y0, area = 0, sx = 0, sy = 0;
      while (stack.length) {
        const k = stack.pop();
        const x = k % W, y = (k / W) | 0;
        area++; sx += x; sy += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minYb) minYb = y; if (y > maxYb) maxYb = y;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= maxY) continue;
          const ni = ny * W + nx;
          if (!seen[ni] && colorOf[ni] === c) { seen[ni] = 1; stack.push(ni); }
        }
      }
      const w = maxX - minX + 1, h = maxYb - minYb + 1;
      if (area < 6 || area > 700) continue;
      const aspect = w / h;
      if (aspect < 0.6 || aspect > 1.7) continue;
      const fill = area / (w * h);
      if (fill < 0.55) continue;
      // alloggiamento scuro attorno
      const pad = Math.max(3, Math.round(Math.max(w, h) * 0.8));
      let ringSum = 0, ringN = 0;
      for (let y = Math.max(0, minYb - pad); y <= Math.min(H - 1, maxYb + pad); y++) {
        for (let x = Math.max(0, minX - pad); x <= Math.min(W - 1, maxX + pad); x++) {
          if (x >= minX && x <= maxX && y >= minYb && y <= maxYb) continue;
          const i = (y * W + x) * 4;
          ringSum += Math.max(data[i], data[i + 1], data[i + 2]) / 255;
          ringN++;
        }
      }
      const ringV = ringN ? ringSum / ringN : 1;
      if (ringV > 0.42) continue;
      const size = Math.max(w, h);
      const score = clamp01(((fill - 0.5) / 0.4) * 0.4 + ((0.42 - ringV) / 0.3) * 0.4 + Math.min(1, area / 40) * 0.2);
      blobs.push({ color: c, x: sx / area, y: sy / area, size, area, score });
    }
  }
  // scarta le coppie di rossi alla stessa altezza (fanali posteriori)
  const out = blobs.filter((b) => {
    if (b.color !== 'red') return true;
    return !blobs.some((o) => o !== b && o.color === 'red' && Math.abs(o.y - b.y) < b.size * 0.6
      && Math.abs(o.x - b.x) > b.size * 2.5 && Math.abs(o.x - b.x) < b.size * 14);
  });
  return out.sort((a, b) => b.score - a.score);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Stabilizza il risultato nel tempo e produce { state, confidence, ts }. */
export class TrafficLightVision {
  constructor({ window = 10, now = () => Date.now() } = {}) {
    this.window = window; this.now = now;
    this.hist = [];
    this.result = null;
  }

  /** @param img ImageData 320x180 */
  push(img) {
    const blobs = findLightBlobs(img);
    const best = blobs[0] ?? null;
    this.hist.push(best ? { color: best.color, score: best.score } : null);
    if (this.hist.length > this.window) this.hist.shift();
    this.result = this._evaluate();
    return this.result;
  }

  _evaluate() {
    if (this.hist.length < this.window) return null;
    const counts = {};
    for (const h of this.hist) if (h) counts[h.color] = (counts[h.color] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (!top) return null;
    const [color, n] = top;
    const consistency = n / this.window;
    const scores = this.hist.filter((h) => h?.color === color).map((h) => h.score);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return { state: color, confidence: Math.round(consistency * (0.6 + 0.4 * avg) * 100) / 100, ts: this.now() };
  }

  current() { return this.result; }
  reset() { this.hist = []; this.result = null; }
}
