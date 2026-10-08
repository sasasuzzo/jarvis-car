import test from 'node:test';
import assert from 'node:assert/strict';
import { GpsTracker } from '../js/gps.js';
import { JarvisSynth } from '../js/voice.js';
import { Bus } from '../js/util.js';
import { handle } from '../worker/worker.js';

function fakeGeo() {
  const g = { watches: [], quick: null, cleared: [] };
  g.getCurrentPosition = (ok, err, opts) => { g.quick = { ok, err, opts }; };
  g.watchPosition = (ok, err, opts) => { g.watches.push({ ok, err, opts }); return g.watches.length; };
  g.clearWatch = (id) => g.cleared.push(id);
  return g;
}
const pos = (lat, lon, acc = 20, speed = null) => ({ coords: { latitude: lat, longitude: lon, accuracy: acc, speed, heading: null }, timestamp: Date.now() });

test('gps: fix rapido + alta precisione, poi ripiego sulla rete se non risponde', () => {
  const geo = fakeGeo(); const bus = new Bus(); const errs = [];
  bus.on('gps:error', (e) => errs.push(e));
  const t = new GpsTracker({ geolocation: geo, bus });
  t.start();
  assert.equal(geo.quick.opts.enableHighAccuracy, false);
  assert.equal(geo.watches[0].opts.enableHighAccuracy, true);
  geo.watches[0].err({ code: 2, message: 'unavailable' });          // PC senza GPS
  assert.equal(geo.watches.length, 2);
  assert.equal(geo.watches[1].opts.enableHighAccuracy, false);
  assert.equal(errs[0].kind, 'unavailable');
  t.stop();
});

test('gps: il fix rapido viene accettato anche se poco preciso; permesso negato segnalato', () => {
  const geo = fakeGeo(); const bus = new Bus(); let denied = 0;
  bus.on('gps:denied', () => denied++);
  const t = new GpsTracker({ geolocation: geo, bus });
  t.start();
  geo.quick.ok(pos(38.1, 13.3, 1500));
  assert.equal(t.fix.lat, 38.1);
  geo.watches[0].err({ code: 1 });
  assert.equal(denied, 1); assert.equal(t.denied, true);
  t.stop();
});

test('voce: se il Worker fallisce si usa la voce del browser', async () => {
  const spoken = [];
  const fallback = { supported: true, speak: async (t) => { spoken.push(t); }, cancel() {}, unlock() {}, voices: () => [], pickVoice: () => null };
  const synth = new JarvisSynth({ api: { tts: async () => { throw new Error('502'); } }, fallback });
  synth.audio = {};                       // finto elemento audio (Node)
  await synth.speak('Buonasera, signore. Come sta?');
  assert.deepEqual(spoken, ['Buonasera, signore. Come sta?']);
  await synth.speak('Seconda frase.');
  assert.equal(synth.usingServer(), false, 'dopo due errori resta sul browser per un po\'');
});

test('worker: /tts richiede il token e inoltra a Google', async () => {
  const env = { JC_USERNAME: 'u', JC_PASSWORD: 'p', TOKEN_SECRET: 's', ALLOWED_ORIGINS: 'https://a.example' };
  const H = { Origin: 'https://a.example', 'Content-Type': 'application/json' };
  const no = await handle(new Request('https://w.test/tts?text=ciao', { headers: H }), env, {});
  assert.equal(no.status, 401);
  const { token } = await (await handle(new Request('https://w.test/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ username: 'u', password: 'p' }) }), env, {})).json();
  let seen;
  const f = async (u) => { seen = new URL(u); return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); };
  const r = await handle(new Request('https://w.test/tts?text=Buongiorno%20signore', { headers: { ...H, Authorization: `Bearer ${token}` } }), env, { fetch: f });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'audio/mpeg');
  assert.equal(seen.hostname, 'translate.google.com');
  assert.equal(seen.searchParams.get('tl'), 'it');
  assert.equal(seen.searchParams.get('q'), 'Buongiorno signore');
});
