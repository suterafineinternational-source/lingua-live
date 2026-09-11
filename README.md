# Lingua Live

Lingua Live è una web app per interpretazione simultanea AI durante live, webinar, meeting e conferenze.

## Stato attuale

Questa prima base implementa:

- input audio da microfono;
- input audio da una scheda del browser;
- traduzione vocale realtime italiano -> inglese;
- trascrizione del parlato originale;
- sottotitoli inglesi live;
- controllo voce ON/OFF e volume;
- codice stanza e link invito;
- esportazione della trascrizione bilingue;
- interfaccia responsive desktop/mobile.

> Nota: il codice stanza nella versione MVP è ancora locale. La condivisione audio multi-listener verrà aggiunta nella milestone successiva.

## Avvio locale

Richiede Node.js 20+.

```bash
cp .env.example .env
npm install
npm run dev
```

Inserire la chiave OpenAI in `.env`:

```bash
OPENAI_API_KEY=sk-...
PORT=5173
```

Aprire quindi:

```text
http://localhost:5173
```

## Sicurezza

La chiave API standard deve restare esclusivamente sul server. Il browser deve ricevere solo credenziali temporanee necessarie alla sessione realtime. Non committare mai `.env`.

## Roadmap prodotto

### Milestone 1 — Realtime MVP
- Italiano -> inglese realtime.
- Microfono / browser-tab audio.
- Trascrizione e captions.
- Export transcript.

### Milestone 2 — Host + Audience
- Stanze reali persistenti.
- Ruolo Host e ruolo Listener.
- Link e QR di accesso.
- Multi-listener.
- Streaming audio tradotto a tutti i partecipanti.
- Stato presenza e riconnessione.

### Milestone 3 — Glossario professionale
- Glossario per evento.
- Termini protetti e pronunce.
- Preset per Amazon, PPC, Seller Central, ASIN, ACoS, TACoS, Rufus e Master Zon.
- Correzione automatica dei nomi propri.

### Milestone 4 — Event platform
- Dashboard eventi.
- Registrazione audio e transcript.
- Riassunto post-evento.
- Download TXT/PDF/SRT/VTT.
- Analytics di utilizzo e latenza.

### Milestone 5 — Integrations
- OBS / virtual audio.
- Zoom / Google Meet / Teams / Webex dove tecnicamente supportato.
- PWA mobile.
- Billing e piani.

## Branching

Le nuove funzionalità vengono sviluppate su branch `codex/*` e integrate tramite pull request.
