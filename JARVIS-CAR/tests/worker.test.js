import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, signToken, verifyToken } from '../worker/worker.js';

const env = { JC_USERNAME: 'utente-test', JC_PASSWORD: 'password-test', TOKEN_SECRET: 'segreto-test', GROQ_API_KEY: 'g', TOMTOM_API_KEY: 'tt-secret', ALLOWED_ORIGINS: 'https://app.example' };
const H = { Origin: 'https://app.example', 'Content-Type': 'application/json' };
const deps = (extra = {}) => ({ sleep: async () => {}, ...extra });
const login = (u, p, e = env) => handle(new Request('https://w.test/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ username: u, password: p }) }), e, deps());

test('login: solo le credenziali giuste', async () => {
  assert.equal((await login('utente-test', 'password-test')).status, 200);
  assert.equal((await login('utente-test', 'sbagliata')).status, 401);
  assert.equal((await login('altro', 'password-test')).status, 401);
  assert.equal((await login('', '')).status, 401);
});

test('token: firma, scadenza, manomissione', async () => {
  const { token } = await signToken('k', { ttlMs: 1000, now: 0 });
  assert.ok(await verifyToken('k', token, 500));
  assert.ok(!(await verifyToken('k', token, 2000)));
  assert.ok(!(await verifyToken('altra', token, 500)));
  assert.ok(!(await verifyToken('k', token.slice(0, -2) + 'xx', 500)));
});

test('endpoint protetti senza token; origine non ammessa', async () => {
  for (const p of ['auth/check', 'tt/routing/1/calculateRoute/1,1:2,2/json', 'yt/search?q=a', 'ics?url=https://a.b/c.ics']) {
    const r = await handle(new Request('https://w.test/' + p, { headers: H }), env, deps());
    assert.equal(r.status, 401, p);
  }
  const r = await handle(new Request('https://w.test/auth/login', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' }), env, deps());
  assert.equal(r.status, 403);
});

test('proxy TomTom: chiave aggiunta lato server, percorsi non ammessi bloccati', async () => {
  const { token } = await (await login('utente-test', 'password-test')).json();
  const seen = [];
  const f = async (u) => { seen.push(String(u)); return new Response('{}', { status: 200 }); };
  const auth = { ...H, Authorization: `Bearer ${token}` };
  const ok = await handle(new Request('https://w.test/tt/search/2/geocode/roma.json?key=rubata&avoid=tollRoads&avoid=ferries', { headers: auth }), env, deps({ fetch: f }));
  assert.equal(ok.status, 200);
  const u = new URL(seen[0]);
  assert.equal(u.searchParams.get('key'), 'tt-secret');
  assert.deepEqual(u.searchParams.getAll('avoid'), ['tollRoads', 'ferries']);
  const bad = await handle(new Request('https://w.test/tt/map/1/tile/basic/1/0/0.png', { headers: auth }), env, deps({ fetch: f }));
  assert.equal(bad.status, 403);
  const ics = await handle(new Request('https://w.test/ics?url=http://169.254.169.254/x', { headers: auth }), env, deps({ fetch: f }));
  assert.equal(ics.status, 400);
});
