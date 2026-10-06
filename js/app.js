// Interfaccia: collega gli eventi della Modalità Macchina alla GUI.
// La GUI è complementare alla voce: sottotitoli di ciò che JARVIS dice, manovra, nastro "Davanti",
// statistiche di viaggio. Nulla qui prende decisioni: legge lo stato e lo mostra.

import { CarMode } from './car_mode.js';
import { MapView } from './map_ui.js';
import { settings, applyTheme } from './settings.js';
import { maneuverIcon } from './persona.js';
import { Priority } from './voice.js';
import { bus, clockText, clamp } from './util.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function distParts(m) {
  if (m < 1000) return { n: String(m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50), u: 'm' };
  const km = m / 1000;
  return { n: km < 10 ? km.toFixed(1).replace('.', ',') : String(Math.round(km)), u: 'km' };
}

export function startApp(api) {
  const mapView = new MapView($('map'), { onUserMove: () => { $('recenter').hidden = false; } });
  const car = new CarMode({ api, videoEl: $('cam') });
  window.__car = car; // utile per la diagnostica da console

  // ---------------------------------------------------------------- tema
  const syncTheme = () => { const t = applyTheme(); mapView.setTheme(t); };
  syncTheme();
  globalThis.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (settings.get('theme') === 'auto') syncTheme(); });
  bus.on('settings:change', (p) => { if ('theme' in p) syncTheme(); });

  // ------------------------------------------------------------ fogli
  let openId = null;
  function openSheet(id) {
    if (openId) closeSheets();
    openId = id;
    $('scrim').hidden = false;
    $(id).hidden = false;
    if (id === 'sheet-dest') renderDest();
    if (id === 'sheet-agenda') renderAgenda();
    if (id === 'sheet-settings') loadSettingsForm();
    if (id === 'sheet-status') renderStatus();
    if (id === 'sheet-music') renderMusic();
  }
  function closeSheets() {
    if (!openId) return;
    $(openId).hidden = true;
    $('scrim').hidden = true;
    openId = null;
  }
  $('scrim').addEventListener('click', closeSheets);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
  $('b-dest').addEventListener('click', () => openSheet('sheet-dest'));
  $('b-music').addEventListener('click', () => openSheet('sheet-music'));
  $('b-agenda').addEventListener('click', () => openSheet('sheet-agenda'));
  $('b-settings').addEventListener('click', () => openSheet('sheet-settings'));
  $('start-settings').addEventListener('click', () => openSheet('sheet-settings'));
  $('start-status').addEventListener('click', () => openSheet('sheet-status'));
  $('s-status').addEventListener('click', () => openSheet('sheet-status'));
  const logout = () => bus.emit('app:logout');
  $('start-logout').addEventListener('click', logout);
  $('s-logout').addEventListener('click', logout);

  // ---------------------------------------------------------------- avvio
  $('start-btn').addEventListener('click', async () => {
    $('start').hidden = true;
    mapView.invalidate();
    await car.start();
  });

  // --------------------------------------------------------- sfera vocale
  let listenerState = 'idle';
  let speaking = false;
  let criticalUntil = 0;
  function paintOrb() {
    const st = Date.now() < criticalUntil ? 'critical' : speaking ? 'speaking' : listenerState;
    $('orb').dataset.state = st;
  }
  bus.on('voice:state', (s) => { listenerState = s; paintOrb(); });
  bus.on('voice:speaking', (on) => { speaking = on; paintOrb(); });
  $('orb').addEventListener('click', () => {
    if (!car.pushToTalk()) openSheet('sheet-dest'); // senza riconoscimento vocale: comandi scritti
  });
  $('caption').addEventListener('click', () => car.voice.interrupt());

  // ------------------------------------------------------------ sottotitoli
  let capTimer = null;
  const PCLASS = { [Priority.CRITICAL]: 'critical', [Priority.IMPORTANT]: 'important', [Priority.INFO]: 'info', [Priority.GUI_ONLY]: 'info' };
  bus.on('hud:message', (m) => {
    const cap = $('caption');
    $('caption-text').textContent = m.text;
    cap.dataset.p = PCLASS[m.priority] || 'info';
    if (m.priority === Priority.CRITICAL) { criticalUntil = Date.now() + 6000; paintOrb(); setTimeout(paintOrb, 6100); }
    clearTimeout(capTimer);
    capTimer = setTimeout(() => { cap.dataset.p = 'idle'; }, clamp(3500 + m.text.length * 70, 5000, 13000));
  });
  let heardTimer = null;
  bus.on('voice:heard', (h) => {
    $('heard').textContent = `“${h.text}”`;
    clearTimeout(heardTimer);
    heardTimer = setTimeout(() => { $('heard').textContent = ''; }, h.final ? 3500 : 6000);
    if (h.text && $('caption').dataset.p === 'idle') $('caption').dataset.p = 'info';
  });

  // ---------------------------------------------------------- GPS e mappa
  bus.on('car:fix', (fix) => {
    mapView.setUser(fix);
    $('t-speed').textContent = Math.round((fix.speed ?? 0) * 3.6);
  });
  $('recenter').addEventListener('click', () => { mapView.recenter(car.gps.fix); $('recenter').hidden = true; });
  bus.on('nav:route', ({ route, alternatives, source }) => {
    mapView.drawRoute(route, alternatives || []);
    if (!route) return;
    if (source === 'plan') {
      mapView.fitRoute(route);
      setTimeout(() => { mapView.recenter(car.gps.fix); $('recenter').hidden = true; }, 4500);
    }
  });

  // ------------------------------------------------- manovra, statistiche, nastro
  let lastTape = 0;
  bus.on('nav:progress', (p) => {
    const nm = p.next;
    $('maneuver').hidden = !nm;
    if (nm) {
      $('m-icon').innerHTML = `<use href="#i-${maneuverIcon(nm.maneuver)}"/>`;
      const d = distParts(nm.distM);
      $('m-dist-n').textContent = d.n;
      $('m-dist-u').textContent = d.u;
      $('m-street').textContent = nm.street || nm.signpost || nm.message || '';
    }
    $('trip').hidden = false;
    $('t-eta').textContent = clockText(p.eta);
    const min = Math.max(1, Math.round(p.remainingS / 60));
    $('t-min').parentElement.innerHTML = min < 60
      ? `<span id="t-min">${min}</span><span class="unit">min</span>`
      : `<span id="t-min">${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}</span><span class="unit">h</span>`;
    const km = distParts(p.remainingM);
    $('t-km').parentElement.innerHTML = `<span id="t-km">${km.u === 'm' ? '0,' + String(Math.round(p.remainingM / 100)) : km.n}</span><span class="unit">km</span>`;
    const lvl = car.navigator.snapshot().level;
    const t = $('t-traffic');
    t.textContent = lvl ? `Traffico ${lvl}` : 'Traffico';
    t.dataset.level = lvl || '';
    const now = Date.now();
    if (now - lastTape > 1000) { lastTape = now; paintTape(); paintFeatures(); }
  });
  bus.on('nav:state', ({ state }) => {
    if (state === 'idle') { $('maneuver').hidden = true; $('trip').hidden = true; $('tape').hidden = true; mapView.setFeatures([]); }
  });
  bus.on('weather:update', ({ now }) => {
    if (now) $('t-weather').textContent = `${Math.round(now.tempC)}° ${now.label}`;
  });

  function paintTape() {
    const items = [];
    const cam = car.cameras.nextCamera;
    if (cam && cam.distM < 3000) items.push({ k: 'camera', icon: 'camera', d: cam.distM });
    const lgt = car.lights.nextLight;
    if (lgt && lgt.distM < 1500) items.push({ k: 'light', icon: 'light', d: lgt.distM });
    if (car.navigator.active) {
      const tr = car.traffic.snapshot();
      const jam = tr.jams.find((j) => !j.inside);
      if (jam && jam.distM < 5000) items.push({ k: 'jam', icon: 'jam', d: jam.distM });
      const inc = tr.incidents[0];
      if (inc && inc.distM < 5000) items.push({ k: inc.kind === 'closed' ? 'closed' : 'incident', icon: inc.kind === 'closed' ? 'closed' : 'incident', d: inc.distM });
    }
    items.sort((a, b) => a.d - b.d);
    const top = items.slice(0, 4);
    $('tape').hidden = !top.length;
    $('tape').innerHTML = top.map((i) => {
      const d = distParts(i.d);
      return `<div class="tape-item" data-k="${i.k}"><svg><use href="#i-${i.icon}"/></svg><span>${d.n}<small>${d.u}</small></span></div>`;
    }).join('');
    // il nastro non deve coprire la carta quando la manovra è nascosta
    $('tape').style.top = $('maneuver').hidden ? 'calc(var(--safe-t) + 14px)' : '';
  }

  let incidents = [];
  bus.on('traffic:incidents', (list) => { incidents = list; });
  function paintFeatures() {
    const f = car.roadFeatures;
    const out = [];
    if (car.navigator.active && car.navigator.progress) {
      const a = car.navigator.progress.alongM;
      for (const c of f.ahead('camera', a, 5000)) out.push({ id: c.id, kind: 'camera', lat: c.lat, lon: c.lon });
      for (const l of f.ahead('light', a, 1800).filter((x) => !x.ped).slice(0, 8)) out.push({ id: l.id, kind: 'light', lat: l.lat, lon: l.lon });
      for (const i of incidents.slice(0, 6)) out.push({ id: `i${i.id}`, kind: 'incident', iconId: i.kind === 'closed' ? 'closed' : 'incident', lat: i.geometry[0].lat, lon: i.geometry[0].lon });
    } else {
      const fix = car.gps.fix;
      if (fix) {
        for (const x of f.around.items) {
          if (x.ped) continue;
          const dLat = (x.lat - fix.lat) * 111000, dLon = (x.lon - fix.lon) * 111000 * Math.cos(fix.lat * Math.PI / 180);
          if (Math.hypot(dLat, dLon) < (x.kind === 'camera' ? 1500 : 700)) out.push({ id: x.id, kind: x.kind, lat: x.lat, lon: x.lon });
        }
      }
    }
    mapView.setFeatures(out);
  }
  bus.on('car:fix', () => { if (!car.navigator.active && Date.now() - lastTape > 1000) { lastTape = Date.now(); paintTape(); paintFeatures(); } });

  // ---------------------------------------------------------------- banner
  let bannerTimer = null;
  function showBanner({ text, yes, no, onYes, onNo, ms = 25000 }) {
    $('banner-text').textContent = text;
    $('banner-yes').textContent = yes;
    $('banner-no').textContent = no;
    $('banner').hidden = false;
    const hide = () => { $('banner').hidden = true; clearTimeout(bannerTimer); };
    $('banner-yes').onclick = () => { hide(); onYes?.(); };
    $('banner-no').onclick = () => { hide(); onNo?.(); };
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hide, ms);
  }
  bus.on('nav:alternative', ({ savingS }) => {
    showBanner({
      text: `Percorso più veloce: risparmi circa ${Math.max(1, Math.round(savingS / 60))} minuti.`,
      yes: 'Imposta', no: 'Ignora',
      onYes: () => car.navigator.acceptPending(), onNo: () => car.navigator.rejectPending(),
    });
  });
  bus.on('nav:rerouted', ({ reason }) => {
    if (reason !== 'alternative' || !car.navigator.previousRoute) return;
    showBanner({
      text: 'Ho cambiato percorso per risparmiare tempo.',
      yes: 'Annulla', no: 'Va bene',
      onYes: () => car.navigator.revert(), ms: 25000,
    });
  });

  // ------------------------------------------------------------- emergenza
  bus.on('accident:ask', () => {
    $('em-text').textContent = 'Sta bene? Rispondi a voce oppure tocca un pulsante.';
    $('em-call').hidden = true; $('em-contact').hidden = true; $('em-share').hidden = true;
    $('emergency').hidden = false;
  });
  bus.on('accident:escalate', ({ number, contact, position }) => {
    $('em-text').textContent = 'Non ho ricevuto risposta. Tocca il pulsante per chiamare i soccorsi.';
    $('em-call').href = `tel:${number}`;
    $('em-call').querySelector('span').textContent = `Chiama il ${number}`;
    $('em-call').hidden = false;
    if (contact) { $('em-contact').href = `tel:${contact.number}`; $('em-contact').textContent = `Chiama ${contact.name || 'il contatto'}`; $('em-contact').hidden = false; }
    if (position && navigator.share) {
      $('em-share').hidden = false;
      $('em-share').onclick = () => navigator.share({ title: 'La mia posizione', text: `Mi trovo qui: https://www.openstreetmap.org/?mlat=${position.lat}&mlon=${position.lon}#map=18/${position.lat}/${position.lon}` }).catch(() => {});
    }
  });
  bus.on('accident:cleared', () => { $('emergency').hidden = true; });
  $('em-ok').addEventListener('click', () => { car.responder.cancel('utente'); $('emergency').hidden = true; });

  // ----------------------------------------------------------- destinazione
  function renderDest() {
    const saved = car.places.all();
    $('dest-saved').innerHTML = Object.entries(saved).map(([k, v]) => `<button class="chip" type="button" data-k="${esc(k)}">${esc(k[0].toUpperCase() + k.slice(1))}</button>`).join('');
    $('dest-saved').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { closeSheets(); car.startNavigationTo(saved[b.dataset.k]); }));
    $('dest-stop').hidden = !car.navigator.active;
    $('dest-empty').hidden = true;
    setTimeout(() => $('dest-input').focus(), 50);
  }
  $('dest-stop').addEventListener('click', () => { car.stopNavigation(); closeSheets(); });
  $('dest-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('dest-input').value.trim();
    if (!q) return;
    const fix = car.gps.fix;
    $('dest-empty').hidden = true;
    $('dest-results').innerHTML = '<li class="empty">Cerco…</li>';
    try {
      // comandi scritti: "metti musica", "quanto manca"… funzionano anche qui
      const res = await car.navigator.searchPlaces(q, fix);
      if (!res.length) { $('dest-results').innerHTML = ''; $('dest-empty').hidden = false; $('dest-empty').textContent = `Nessun risultato per "${q}". Prova con via e città.`; return; }
      $('dest-results').innerHTML = res.map((r, i) => `<li><button type="button" data-i="${i}"><span class="t">${esc(r.name)}</span><span class="s">${esc(r.address)}</span></button></li>`).join('');
      $('dest-results').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        const r = res[+b.dataset.i];
        closeSheets();
        car.startNavigationTo({ name: r.name, lat: r.lat, lon: r.lon });
      }));
    } catch (err) {
      $('dest-results').innerHTML = '';
      $('dest-empty').hidden = false;
      $('dest-empty').textContent = err.code === 'unauthorized' ? 'Sessione scaduta: accedi di nuovo.' : 'Ricerca non riuscita. Controlla la connessione.';
    }
  });

  // ------------------------------------------------------------------ musica
  function renderMusic() {
    const s = car.music.state();
    $('music-title').textContent = s.title || 'Niente in riproduzione';
    $('mu-play').innerHTML = `<svg><use href="#i-${s.playing ? 'pause' : 'play'}"/></svg>`;
    $('mu-vol').value = s.volume; $('mu-vol-o').textContent = s.volume;
  }
  bus.on('music:state', () => { if (openId === 'sheet-music') renderMusic(); });
  $('mu-play').addEventListener('click', async () => {
    car.synth.unlock();
    try {
      if (car.music.playing) car.music.pause();
      else if (car.music.queue.length || car.music.title) car.music.resume();
      else { await car.music.init(); await car.music.searchAndPlay('musica per guidare'); }
    } catch (e) { showMusicMsg(car.commands.musicError(e, '')); }
    setTimeout(renderMusic, 400);
  });
  $('mu-next').addEventListener('click', () => car.music.next());
  $('mu-prev').addEventListener('click', () => car.music.prev());
  $('mu-vol').addEventListener('input', (e) => { const v = car.music.setVolume(+e.target.value); $('mu-vol-o').textContent = v; });
  function showMusicMsg(t) { $('music-msg').textContent = t; $('music-msg').hidden = !t; }
  $('music-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('music-input').value.trim();
    if (!q) return;
    showMusicMsg('Cerco…');
    try { const item = await car.music.searchAndPlay(q); showMusicMsg(''); $('music-title').textContent = item.title; }
    catch (err) { showMusicMsg(car.commands.musicError(err, q)); }
  });

  // ------------------------------------------------------------------ agenda
  const fmtWhen = (ms) => new Date(ms).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function renderAgenda() {
    const list = car.agenda.all().filter((i) => i.start > Date.now() - 3600000 && i.start < Date.now() + 7 * 86400000);
    $('agenda-list').innerHTML = list.map((i) => `<li class="item"><span class="t">${esc(i.title)}</span><span class="s">${esc(fmtWhen(i.start))}${i.place ? `, ${esc(i.place)}` : ''}</span>${i.source === 'local' ? `<button class="link" type="button" data-del="${esc(i.id)}">Elimina</button>` : ''}</li>`).join('');
    $('agenda-list').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { car.agenda.remove(b.dataset.del); renderAgenda(); }));
    $('agenda-empty').hidden = list.length > 0;
  }
  function agendaMsg(t) { $('agenda-msg').textContent = t; $('agenda-msg').hidden = !t; }
  $('agenda-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const start = new Date($('ag-when').value).getTime();
    if (!Number.isFinite(start)) return agendaMsg('Inserisci data e ora.');
    car.agenda.add({ title: $('ag-title').value.trim(), start, place: $('ag-place').value.trim() });
    e.target.reset(); agendaMsg(''); renderAgenda();
  });
  $('ag-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { const n = car.agenda.importText(await f.text()); agendaMsg(`Importati ${n} appuntamenti dei prossimi 14 giorni.`); renderAgenda(); }
    catch { agendaMsg('File non valido: serve un calendario .ics.'); }
    e.target.value = '';
  });
  $('ag-sync').addEventListener('click', async () => {
    const url = settings.get('icsUrl');
    if (!url) return agendaMsg('Aggiungi prima l\'indirizzo iCal nelle impostazioni.');
    agendaMsg('Sincronizzo…');
    try { const n = await car.agenda.sync(url); agendaMsg(`Sincronizzati ${n} appuntamenti.`); renderAgenda(); }
    catch (err) { agendaMsg(`Sincronizzazione non riuscita (${err.code || 'errore'}).`); }
  });

  // ------------------------------------------------------------ impostazioni
  const bindCheck = (id, key, after) => $(id).addEventListener('change', (e) => { settings.set({ [key]: e.target.checked }); after?.(e.target.checked); });
  function fillVoices() {
    const sel = $('s-voice');
    const voices = car.synth.voices();
    sel.innerHTML = `<option value="">Automatica</option>` + voices.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)}</option>`).join('');
    sel.value = settings.get('voiceURI') || '';
  }
  globalThis.speechSynthesis?.addEventListener?.('voiceschanged', fillVoices);
  function loadSettingsForm() {
    const s = settings.all();
    $('s-wake').checked = s.wakeWord;
    $('s-essential').checked = s.verbosity === 'essential';
    $('s-rate').value = s.voiceRate; $('s-rate-o').textContent = Number(s.voiceRate).toFixed(2);
    $('s-accident').checked = s.accidentDetection;
    $('s-camera').checked = s.cameraEnabled;
    $('s-lights').checked = s.trafficLightVision;
    $('s-break').checked = s.breakReminder;
    $('s-ec-name').value = s.emergencyContactName; $('s-ec-num').value = s.emergencyContactNumber;
    $('s-auto-alt').checked = s.autoAcceptAlternative;
    $('s-tolls').checked = s.avoidTolls; $('s-motorway').checked = s.avoidMotorways;
    $('s-ics').value = s.icsUrl;
    $('s-playlists').value = Object.entries(s.playlists || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    $('s-theme').value = s.theme;
    $('s-wake-lock').checked = s.keepScreenOn;
    fillVoices();
  }
  bindCheck('s-wake', 'wakeWord', (on) => { if (car.running) on ? car.listener.start() : car.listener.stop(); });
  $('s-essential').addEventListener('change', (e) => { const v = e.target.checked ? 'essential' : 'normal'; settings.set({ verbosity: v }); car.voice.setVerbosity(v); });
  $('s-voice').addEventListener('change', (e) => settings.set({ voiceURI: e.target.value }));
  $('s-rate').addEventListener('input', (e) => { settings.set({ voiceRate: +e.target.value }); $('s-rate-o').textContent = Number(e.target.value).toFixed(2); });
  $('s-test').addEventListener('click', () => { car.synth.unlock(); car.voice.announce({ key: 'voice:test', text: 'Sono pronto, signore. Questa è la mia voce.', priority: Priority.IMPORTANT, force: true }); });
  bindCheck('s-accident', 'accidentDetection', (on) => { if (on && car.running) car.motion.start(); });
  bindCheck('s-camera', 'cameraEnabled', (on) => { car.setCamera(on); if (!on) { settings.set({ trafficLightVision: false }); $('s-lights').checked = false; } });
  bindCheck('s-lights', 'trafficLightVision', (on) => { if (on && !$('s-camera').checked) { $('s-camera').checked = true; settings.set({ cameraEnabled: true }); car.setCamera(true); } });
  bindCheck('s-break', 'breakReminder');
  $('s-ec-name').addEventListener('change', (e) => settings.set({ emergencyContactName: e.target.value.trim() }));
  $('s-ec-num').addEventListener('change', (e) => settings.set({ emergencyContactNumber: e.target.value.trim() }));
  bindCheck('s-auto-alt', 'autoAcceptAlternative');
  bindCheck('s-tolls', 'avoidTolls');
  bindCheck('s-motorway', 'avoidMotorways');
  $('s-ics').addEventListener('change', (e) => settings.set({ icsUrl: e.target.value.trim() }));
  $('s-playlists').addEventListener('change', (e) => {
    const pl = {};
    for (const line of e.target.value.split('\n')) { const [k, ...v] = line.split('='); if (k?.trim() && v.join('=').trim()) pl[k.trim()] = v.join('=').trim(); }
    settings.set({ playlists: pl });
  });
  $('s-theme').addEventListener('change', (e) => settings.set({ theme: e.target.value }));
  bindCheck('s-wake-lock', 'keepScreenOn');
  $('s-home').addEventListener('click', () => car.savePlaceHere('casa'));
  $('s-work').addEventListener('click', () => car.savePlaceHere('lavoro'));

  // ------------------------------------------------------------------ stato
  function renderStatus() {
    $('status-list').innerHTML = car.diagnostics().map((d) => `<li data-s="${d.state}"><span class="dot"></span><div><div class="n">${esc(d.name)}</div><div class="d">${esc(d.detail)}</div></div></li>`).join('');
  }
  bus.on('roadfeatures:status', () => { if (openId === 'sheet-status') renderStatus(); });

  // ------------------------------------------------------- rotazione schermo
  addEventListener('resize', () => mapView.invalidate());
  return { car, mapView };
}

