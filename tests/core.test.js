import test from 'node:test';
import assert from 'node:assert/strict';
import { VoicePriorityEngine, Priority } from '../js/voice.js';
import { haversine, distanceSpeech, numberToItalian, durationSpeech } from '../js/util.js';
import { parseIntent } from '../js/commands.js';
import { parseOverpass } from '../js/overpass.js';
import { AccidentDetector } from '../js/accident_detection.js';
import { findLightBlobs } from '../js/traffic_light_vision.js';

function engine(opts = {}) {
  let t = 1_000_000;
  const spoken = [];
  const timers = [];
  const synth = { speak: (text) => { spoken.push(text); return Promise.resolve(); }, cancel() { spoken.push('<cancel>'); } };
  const e = new VoicePriorityEngine({ synth, now: () => t, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer() {}, ...opts });
  return { e, spoken, advance: (ms) => { t += ms; }, flush: async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); } } };
}

test('voce: non ripete lo stesso annuncio', async () => {
  const { e, spoken, flush, advance } = engine();
  e.announce({ key: 'a', text: 'Autovelox tra quattrocento metri', priority: Priority.IMPORTANT });
  await flush(); advance(5000);
  assert.equal(e.announce({ key: 'a', text: 'Autovelox tra trecento metri', priority: Priority.IMPORTANT }), 'deduped');
  assert.equal(e.announce({ key: 'b', text: 'Autovelox tra quattrocento metri', priority: Priority.IMPORTANT }), 'deduped');
  assert.equal(spoken.length, 1);
});

test('voce: GUI_ONLY non parla, essential silenzia INFO', () => {
  const { e, spoken } = engine();
  assert.equal(e.announce({ text: 'solo schermo', priority: Priority.GUI_ONLY }), 'gui');
  e.setVerbosity('essential');
  assert.equal(e.announce({ text: 'curiosità', priority: Priority.INFO }), 'gui');
  assert.deepEqual(spoken, []);
});

test('voce: il CRITICO interrompe e passa avanti', async () => {
  const { e, spoken, flush } = engine({ synth: null });
  const out = [];
  e.synth = { speak: (t) => { out.push(t); return new Promise(() => {}); }, cancel: () => out.push('<cancel>') };
  e.announce({ key: 'i', text: 'informazione', priority: Priority.INFO });
  await flush();
  e.announce({ key: 'c', text: 'Attenzione, frenata', priority: Priority.CRITICAL });
  await flush();
  assert.deepEqual(out, ['informazione', '<cancel>', 'Attenzione, frenata']);
  assert.equal(spoken.length, 0);
});

test('voce: annunci scaduti vengono scartati', async () => {
  const { e, spoken, advance, flush } = engine();
  e.synth = { speak: (t) => { spoken.push(t); return new Promise(() => {}); }, cancel() {} };
  e.announce({ key: 'x', text: 'primo', priority: Priority.IMPORTANT });
  e.announce({ key: 'y', text: 'secondo', priority: Priority.IMPORTANT, ttlMs: 1000 });
  await flush();
  advance(5000);
  e.current = null; e._pump({ immediate: true });
  await flush();
  assert.deepEqual(spoken, ['primo']);
  assert.equal(e.stats.expired, 1);
});

test('voce: quietGate trattiene gli INFO', () => {
  const { e, spoken } = engine({ quietGate: () => false });
  e.announce({ text: 'informazione', priority: Priority.INFO });
  assert.deepEqual(spoken, []);
});

test('util: distanze e numeri', () => {
  const d = haversine({ lat: 38.116, lon: 13.361 }, { lat: 38.126, lon: 13.361 });
  assert.ok(Math.abs(d - 1112) < 15);
  assert.equal(numberToItalian(21), 'ventuno');
  assert.ok(typeof distanceSpeech(450) === 'string' && distanceSpeech(450).length > 3);
  assert.ok(durationSpeech(754).length > 2);
});

test('comandi: intenti principali', () => {
  assert.equal(parseIntent('Jarvis portami al lavoro').intent, 'navigate');
  assert.equal(parseIntent('quanto manca?').intent, 'eta');
  assert.equal(parseIntent('evita le autostrade').intent, 'avoid');
  assert.equal(parseIntent('esci dalla modalità macchina').intent, 'car_mode_off');
  assert.equal(parseIntent('sì', { hasPending: true }).intent, 'confirm_yes');
});

test('overpass: autovelox e semafori', () => {
  const r = parseOverpass({ elements: [
    { type: 'node', id: 1, lat: 1, lon: 1, tags: { highway: 'speed_camera', maxspeed: '50' } },
    { type: 'node', id: 2, lat: 1, lon: 2, tags: { highway: 'traffic_signals' } },
    { type: 'node', id: 3, lat: 1, lon: 3, tags: { crossing: 'traffic_signals' } },
    { type: 'node', id: 4, lat: 1, lon: 4, tags: { shop: 'bakery' } },
  ] });
  assert.equal(r.length, 3);
  assert.equal(r[0].maxspeed, 50);
  assert.equal(r[2].ped, true);
});

test('incidente: urto + arresto = segnalazione; frenata sola = no', () => {
  const mk = () => new AccidentDetector({ now: () => 0 });
  const a = mk();
  for (let t = 0; t <= 8000; t += 1000) a.pushGps({ ts: t, speedMs: 20 });
  a.pushMotion({ ts: 9000, g: 6 });
  for (let t = 9500; t <= 19000; t += 500) a.pushGps({ ts: t, speedMs: 0.5 });
  assert.ok(a.tick(19000));
  const b = mk();
  for (let t = 0; t <= 8000; t += 1000) b.pushGps({ ts: t, speedMs: 20 });
  b.pushMotion({ ts: 9000, g: 1.2 });
  assert.equal(b.pending, null);
  const c = mk();
  for (let t = 0; t <= 8000; t += 1000) c.pushGps({ ts: t, speedMs: 20 });
  c.pushMotion({ ts: 9000, g: 6 });
  for (let t = 9500; t <= 19000; t += 500) c.pushGps({ ts: t, speedMs: 18 });
  assert.equal(c.tick(19000), null);
});

function img(W, H, bg = [30, 30, 30]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255; }
  return { width: W, height: H, data };
}
function disc(im, cx, cy, r, rgb) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { const i = (y * im.width + x) * 4; im.data[i] = rgb[0]; im.data[i + 1] = rgb[1]; im.data[i + 2] = rgb[2]; }
  }
}
test('semaforo: rosso e verde rilevati, regole di scarto', () => {
  let im = img(160, 90, [10, 10, 10]); disc(im, 80, 20, 5, [255, 30, 30]);
  assert.equal(findLightBlobs(im)[0]?.color, 'red');
  im = img(160, 90, [10, 10, 10]); disc(im, 80, 20, 5, [30, 255, 90]);
  assert.equal(findLightBlobs(im)[0]?.color, 'green');
  im = img(160, 90, [10, 10, 10]); disc(im, 60, 20, 4, [255, 30, 30]); disc(im, 100, 20, 4, [255, 30, 30]);
  assert.equal(findLightBlobs(im).length, 0, 'fanali posteriori');
  im = img(160, 90, [10, 10, 10]); disc(im, 80, 70, 5, [255, 30, 30]);
  assert.equal(findLightBlobs(im).length, 0, 'metà bassa');
  im = img(160, 90, [200, 200, 200]); disc(im, 80, 20, 5, [255, 30, 30]);
  assert.equal(findLightBlobs(im).length, 0, 'senza alloggiamento scuro');
});
