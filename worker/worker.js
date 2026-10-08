// JARVIS CAR — proxy sicuro (Cloudflare Worker).
//
// Perché esiste: GitHub Pages è statico e pubblico. Le chiavi API (Groq, TomTom,
// YouTube) e le credenziali di accesso NON possono stare nel repository né nel browser.
// Il Worker le tiene come secret, verifica il login e inoltra solo le chiamate consentite.
//
// Secret richiesti (wrangler secret put <NOME>):
//   JC_USERNAME, JC_PASSWORD   credenziali di accesso all'app
//   TOKEN_SECRET               stringa casuale lunga, firma i token di sessione
//   GROQ_API_KEY               IA conversazionale
//   TOMTOM_API_KEY             routing, traffico, ricerca indirizzi
//   YOUTUBE_API_KEY            (facoltativa) ricerca musicale
// Variabili: ALLOWED_ORIGINS (elenco separato da virgole), GROQ_MODEL, TOKEN_TTL_DAYS.
// KV facoltativo (binding JC_KV): blocco temporaneo dopo troppi login errati.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ------------------------------------------------------------------ cripto

const b64u = {
  enc(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Confronto a tempo costante (si confrontano gli HMAC, che hanno sempre la stessa lunghezza). */
export async function safeEqual(a, b, secret) {
  const [ha, hb] = await Promise.all([hmac(secret, 'cmp:' + a), hmac(secret, 'cmp:' + b)]);
  let d = 0;
  for (let i = 0; i < ha.length; i++) d |= ha[i] ^ hb[i];
  return d === 0;
}

export async function signToken(secret, { ttlMs, now = Date.now() }) {
  const payload = b64u.enc(enc.encode(JSON.stringify({ sub: 'jc', iat: now, exp: now + ttlMs })));
  const sig = b64u.enc(await hmac(secret, 'v1.' + payload));
  return { token: `v1.${payload}.${sig}`, expiresAt: now + ttlMs };
}

export async function verifyToken(secret, token, now = Date.now()) {
  try {
    const [v, payload, sig] = String(token || '').split('.');
    if (v !== 'v1' || !payload || !sig) return false;
    const expected = b64u.enc(await hmac(secret, 'v1.' + payload));
    if (!(await safeEqual(sig, expected, secret))) return false;
    const data = JSON.parse(dec.decode(b64u.dec(payload)));
    return data.sub === 'jc' && typeof data.exp === 'number' && data.exp > now;
  } catch { return false; }
}

// -------------------------------------------------------------------- util

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { 'Vary': 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return { headers: h, originOk: !origin || allowed.includes(origin) };
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Percorsi TomTom inoltrabili (niente proxy aperto: solo ciò che serve all'app).
const TOMTOM_ALLOWED = [
  /^routing\/1\/calculateRoute\/[^/]+\/json$/,
  /^search\/2\/(search|geocode)\/[^/]+\.json$/,
  /^search\/2\/reverseGeocode\/[^/]+\.json$/,
  /^traffic\/services\/5\/incidentDetails$/,
];

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function isPublicHttpsUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[')) return false; // IP letterali
  return true;
}

// ------------------------------------------------------------------ routes

export async function handle(request, env, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ? deps.now() : Date.now();
  const cors = corsHeaders(request, env);
  const reply = (obj, status = 200) => json(obj, status, cors.headers);

  if (request.method === 'OPTIONS') return new Response(null, { status: cors.originOk ? 204 : 403, headers: cors.headers });
  if (!cors.originOk) return reply({ error: 'origin_not_allowed' }, 403);

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');

  if (path === '' || path === 'health') return reply({ ok: true, service: 'jarvis-car-proxy' });
  if (!env.TOKEN_SECRET) return reply({ error: 'server_not_configured', detail: 'TOKEN_SECRET mancante' }, 500);

  // ---- login
  if (path === 'auth/login' && request.method === 'POST') {
    if (!env.JC_USERNAME || !env.JC_PASSWORD) return reply({ error: 'server_not_configured', detail: 'credenziali mancanti' }, 500);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const failKey = `fail:${ip}`;
    if (env.JC_KV) {
      const n = parseInt((await env.JC_KV.get(failKey)) || '0', 10);
      if (n >= 5) return reply({ error: 'too_many_attempts' }, 429);
    }
    let body;
    try { body = await request.json(); } catch { return reply({ error: 'bad_request' }, 400); }
    const okUser = await safeEqual(String(body?.username ?? ''), env.JC_USERNAME, env.TOKEN_SECRET);
    const okPass = await safeEqual(String(body?.password ?? ''), env.JC_PASSWORD, env.TOKEN_SECRET);
    if (!(okUser && okPass)) {
      await sleep(deps.failDelayMs ?? 800); // rallenta i tentativi a raffica
      if (env.JC_KV) {
        const n = parseInt((await env.JC_KV.get(failKey)) || '0', 10);
        await env.JC_KV.put(failKey, String(n + 1), { expirationTtl: 900 });
      }
      return reply({ error: 'invalid_credentials' }, 401);
    }
    if (env.JC_KV) await env.JC_KV.delete(failKey);
    const ttlDays = clamp(parseFloat(env.TOKEN_TTL_DAYS || '30') || 30, 0.01, 90);
    const { token, expiresAt } = await signToken(env.TOKEN_SECRET, { ttlMs: ttlDays * 86400000, now });
    return reply({ token, expiresAt });
  }

  // ---- tutto il resto richiede un token valido
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!(await verifyToken(env.TOKEN_SECRET, token, now))) return reply({ error: 'unauthorized' }, 401);

  if (path === 'auth/check') {
    return reply({
      ok: true,
      services: { ai: !!env.GROQ_API_KEY, maps: !!env.TOMTOM_API_KEY, music: !!env.YOUTUBE_API_KEY, tts: true },
    });
  }

  // ---- Groq
  if (path === 'ai/chat' && request.method === 'POST') {
    if (!env.GROQ_API_KEY) return reply({ error: 'ai_not_configured' }, 501);
    let body;
    try { body = await request.json(); } catch { return reply({ error: 'bad_request' }, 400); }
    const msgs = Array.isArray(body?.messages) ? body.messages.slice(-24) : [];
    const clean = msgs
      .filter((m) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
    if (!clean.length) return reply({ error: 'bad_request' }, 400);
    const model = env.GROQ_MODEL || 'openai/gpt-oss-20b';
    const maxTokens = clamp(parseInt(body.max_tokens, 10) || 220, 16, 600);
    const payload = {
      model,
      messages: clean,
      temperature: clamp(Number(body.temperature ?? 0.6), 0, 1.2),
      max_completion_tokens: maxTokens + (/gpt-oss/i.test(model) ? 512 : 0), // il ragionamento consuma token
    };
    if (/gpt-oss/i.test(model)) payload.reasoning_effort = 'low';
    const r = await doFetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return reply({ error: 'ai_upstream', status: r.status }, 502);
    const data = await r.json();
    const text = (data?.choices?.[0]?.message?.content || '').trim();
    return reply({ text, model });
  }

  // ---- TomTom (routing, ricerca, incidenti): la chiave resta qui
  if (path.startsWith('tt/')) {
    if (!env.TOMTOM_API_KEY) return reply({ error: 'maps_not_configured' }, 501);
    const sub = path.slice(3);
    if (!TOMTOM_ALLOWED.some((re) => re.test(sub))) return reply({ error: 'path_not_allowed' }, 403);
    const up = new URL('https://api.tomtom.com/' + sub);
    for (const [k, v] of url.searchParams) if (k.toLowerCase() !== 'key') up.searchParams.append(k, v); // append: parametri ripetuti (avoid, sectionType)
    up.searchParams.set('key', env.TOMTOM_API_KEY);
    const r = await doFetch(up.toString(), { headers: { 'Accept': 'application/json' } });
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store', ...cors.headers },
    });
  }

  // ---- YouTube (ricerca musica)
  if (path === 'yt/search') {
    if (!env.YOUTUBE_API_KEY) return reply({ error: 'youtube_not_configured' }, 501);
    const q = (url.searchParams.get('q') || '').slice(0, 120).trim();
    if (!q) return reply({ error: 'bad_request' }, 400);
    const n = clamp(parseInt(url.searchParams.get('n') || '12', 10) || 12, 1, 25);
    const up = new URL('https://www.googleapis.com/youtube/v3/search');
    up.search = new URLSearchParams({
      part: 'snippet', type: 'video', videoCategoryId: '10', videoEmbeddable: 'true', videoSyndicated: 'true',
      maxResults: String(n), q, key: env.YOUTUBE_API_KEY, regionCode: 'IT', relevanceLanguage: 'it',
    }).toString();
    const r = await doFetch(up.toString());
    if (!r.ok) return reply({ error: 'youtube_upstream', status: r.status }, 502);
    const data = await r.json();
    const items = (data.items || [])
      .filter((i) => i?.id?.videoId)
      .map((i) => ({ id: i.id.videoId, title: decodeEntities(i.snippet?.title), channel: decodeEntities(i.snippet?.channelTitle) }));
    return reply({ items });
  }

  // ---- voce: stessa sintesi Google (italiano) usata da gTTS nel JARVIS per PC
  if (path === 'tts') {
    const text = (url.searchParams.get('text') || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return reply({ error: 'bad_request' }, 400);
    const up = new URL('https://translate.google.com/translate_tts');
    up.search = new URLSearchParams({ ie: 'UTF-8', client: 'tw-ob', tl: 'it', q: text, total: '1', idx: '0', textlen: String(text.length) }).toString();
    let r;
    try { r = await doFetch(up.toString(), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JarvisCar/1.0)', 'Referer': 'https://translate.google.com/' } }); }
    catch { return reply({ error: 'tts_upstream', status: 0 }, 502); }
    if (!r.ok) return reply({ error: 'tts_upstream', status: r.status }, 502);
    return new Response(r.body, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400', ...cors.headers } });
  }

  // ---- agenda iCal (CORS permette solo il Worker; il calendario resta dell'utente)
  if (path === 'ics') {
    const target = url.searchParams.get('url') || '';
    if (!isPublicHttpsUrl(target)) return reply({ error: 'bad_url' }, 400);
    const r = await doFetch(target, { headers: { 'Accept': 'text/calendar,text/plain,*/*' } });
    if (!r.ok) return reply({ error: 'ics_upstream', status: r.status }, 502);
    const text = await r.text();
    if (text.length > 2_000_000) return reply({ error: 'ics_too_large' }, 413);
    if (!text.includes('BEGIN:VCALENDAR')) return reply({ error: 'not_ics' }, 422);
    return new Response(text, { status: 200, headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', ...cors.headers } });
  }

  return reply({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'internal', detail: String(e?.message || e) }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
