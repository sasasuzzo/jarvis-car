# JARVIS CAR

Assistente di guida vocale, web app indipendente (GitHub Pages + un piccolo proxy Cloudflare Worker).
Non dipende dal JARVIS per PC. Dati sempre reali: nessuna simulazione di GPS, traffico, autovelox, semafori, meteo o percorsi.

## Come funziona

```
Browser (GitHub Pages)  ──token──►  Cloudflare Worker  ──chiavi──►  Groq · TomTom · YouTube
   GPS · voce · mappa                login + proxy                    (le chiavi restano solo qui)
   └── Open-Meteo, Overpass/OpenStreetMap: pubblici, chiamati direttamente
```

| Modulo | File | Dati |
|---|---|---|
| Voce con priorità (CRITICO / IMPORTANTE / INFORMATIVO / solo GUI) | `js/voice.js` | Web Speech API |
| Contesto centrale | `js/contextual_engine.js` | tutti i moduli |
| Navigazione dinamica, ricalcolo, alternative | `js/navigation.js` | TomTom Routing (traffico reale) |
| Traffico e incidenti | `js/traffic.js` | TomTom Traffic Incidents |
| Autovelox | `js/speed_cameras.js` | OpenStreetMap (posizioni fisse) |
| Semafori | `js/traffic_lights.js` | OpenStreetMap (posizioni) |
| Meteo | `js/weather.js` | Open-Meteo |
| Agenda | `js/agenda.js` | voci locali + iCal (RRULE) |
| Musica | `js/music.js` | YouTube |
| Incidente / evento anomalo | `js/accident_detection.js` | accelerometro + GPS + fotocamera |
| AI (uso parsimonioso) | `js/commands.js` | Groq via Worker |

## Cosa è reale e cosa è sperimentale

- **Reale**: posizione, percorso, traffico, incidenti stradali, meteo, agenda, musica.
- **Autovelox**: solo quelli fissi presenti in OpenStreetMap; la copertura non è completa. Autovelox mobili e pattuglie non sono rilevabili e non vengono simulati. Nessun rilevatore radar. (Nota informativa, non consulenza legale: in Italia l'art. 45 CdS riguarda i dispositivi di rilevamento; qui si usano solo dati pubblici di mappa.)
- **Semafori**: posizione da OSM. Lo **stato** del semaforo non esiste come dato pubblico: la lettura dalla fotocamera è sperimentale, spenta di default, e parla solo con confidenza ≥ 85%.
- **Rilevamento incidente**: combina urto, calo di velocità e (se attiva) fotocamera. Non è stato validato su veicoli reali. Chiede "Sta bene?", e se non risponde mostra il pulsante **Chiama il 112**: non chiama mai da solo.
- CarPlay / display auto: non inclusi.

## Installazione

### 1. Worker (login, chiavi, proxy)

```bash
cd worker
npm i -g wrangler && wrangler login
wrangler secret put JC_USERNAME      # il tuo nome utente
wrangler secret put JC_PASSWORD      # la tua password
wrangler secret put TOKEN_SECRET     # stringa casuale lunga (es. openssl rand -hex 32)
wrangler secret put GROQ_API_KEY
wrangler secret put TOMTOM_API_KEY   # developer.tomtom.com (piano gratuito)
wrangler secret put YOUTUBE_API_KEY  # facoltativa, per la musica
```

In `wrangler.toml` imposta `ALLOWED_ORIGINS` con l'indirizzo della web app (es. `https://TUOUTENTE.github.io`), poi `wrangler deploy`.
Facoltativo: crea un KV `JC_KV` (istruzioni in `wrangler.toml`) per bloccare 15 minuti dopo 5 tentativi errati.

### 2. Web app

1. Crea il repository su GitHub e carica questa cartella.
2. *Settings → Pages → Source: GitHub Actions*. Il workflow `.github/workflows/pages.yml` esegue i test e pubblica.
3. Apri il sito (serve HTTPS), inserisci l'indirizzo del Worker nel campo "Server" e accedi.

## Sicurezza e privacy

- Nel repository non ci sono chiavi, password né hash. Utente e password sono secret del Worker e vengono verificati lì (confronto a tempo costante, ritardo sugli errori, blocco opzionale).
- Il Worker restituisce un token firmato con scadenza (30 giorni, `TOKEN_TTL_DAYS`). Il codice dell'app viene caricato solo dopo un accesso valido.
- Limite onesto: GitHub Pages è pubblico, quindi i file dell'interfaccia sono leggibili da chiunque. A essere protetti sono **dati e chiavi** (senza token il Worker non risponde), non il codice della pagina.
- Il Worker accetta richieste solo dall'origine in `ALLOWED_ORIGINS` e inoltra solo percorsi TomTom consentiti; l'endpoint iCal accetta solo URL https pubblici.
- Posizione, microfono, fotocamera e sensori si chiedono esplicitamente. Impostazioni, luoghi salvati e ultimo viaggio restano nel browser del dispositivo. L'AI riceve solo il contesto minimo di guida, senza nome né indirizzi salvati.

## Limiti del browser

- Schermo acceso e app in primo piano: i browser sospendono GPS e voce in background (l'app chiede il blocco dello schermo).
- Su iPhone audio e sensori partono solo dopo un tocco; il riconoscimento vocale varia per browser (meglio Chrome su Android).
- Il player YouTube deve restare visibile secondo le regole di YouTube.

## Sviluppo

```bash
npm test        # test automatici (voce, comandi, Worker, rilevamento, anti-chiavi)
```
