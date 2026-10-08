// Accesso. La verifica delle credenziali avviene SUL SERVER (Cloudflare Worker): nel repository
// e nel browser non esiste nessuna password né hash. Il Worker restituisce un token firmato
// con scadenza; senza token valido il codice dell'app non viene nemmeno caricato.

import { Api } from './api.js';
import { getWorkerUrl, setWorkerUrl } from './config.js';
import { applyTheme } from './settings.js';
import { bus } from './util.js';

const $ = (id) => document.getElementById(id);
const api = new Api();

const MESSAGES = {
  invalid_credentials: 'Utente o password non corretti.',
  too_many_attempts: 'Troppi tentativi errati. Riprova tra 15 minuti.',
  no_server: "Inserisci l'indirizzo del server.",
  network: "Server non raggiungibile. Controlla l'indirizzo e la connessione.",
  timeout: "Il server non risponde. Controlla l'indirizzo e la connessione.",
  origin_not_allowed: "Il server non accetta questo sito. Aggiungi l'indirizzo della web app in ALLOWED_ORIGINS.",
  server_not_configured: 'Il server non è configurato: mancano i secret (vedi README).',
};

function showError(msg) {
  const el = $('login-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function showLogin(msg = '') {
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-server').value = getWorkerUrl();
  $('server-box').open = !getWorkerUrl() || !!msg;
  showError(msg);
  setTimeout(() => $('login-user').focus(), 50);
}

let entered = false;
async function enter() {
  if (entered) return;
  entered = true;
  $('login').hidden = true;
  $('app').hidden = false;
  const { startApp } = await import('./app.js');   // il codice dell'app si carica solo dopo l'accesso
  startApp(api);
}

async function boot() {
  applyTheme();
  try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js'); } catch { /* facoltativo */ }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const server = $('login-server').value.trim();
    if (server) setWorkerUrl(server);
    if (!getWorkerUrl()) { $('server-box').open = true; return showError(MESSAGES.no_server); }
    const username = $('login-user').value.trim();
    const password = $('login-pass').value;
    if (!username || !password) return showError('Inserisci utente e password.');
    const btn = $('login-submit');
    btn.disabled = true; btn.textContent = 'Accesso in corso…';
    try {
      await api.login(username, password);
      await api.check();
      $('login-pass').value = '';
      await enter();
    } catch (err) {
      showError(MESSAGES[err.code] || `Accesso non riuscito (${err.code || 'errore'}).`);
      if (err.code === 'network' || err.code === 'timeout') $('server-box').open = true;
    } finally {
      btn.disabled = false; btn.textContent = 'Accedi';
    }
  });

  bus.on('app:logout', () => { api.logout(); location.reload(); });
  bus.on('auth:expired', () => setTimeout(() => location.reload(), 4000));

  if (api.hasSession && getWorkerUrl()) {
    try { await api.check(); return await enter(); }
    catch (err) {
      if (err.code === 'network' || err.code === 'timeout') return showLogin(MESSAGES[err.code]);
    }
  }
  showLogin();
}

boot();
