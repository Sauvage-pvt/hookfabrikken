# hookfabrikken

Cloudflare Worker (`src/index.js`) + statisk side (`index.html`).

- **Rask start**: kun «hva selges» + bilde → 8 hooks, hver med én setning om mekanismen.
- **Gjør skarpere**: historie, målgruppe, tone, plattform, pitch og innlegg.
- **Stemme-minne**: hooks som kopieres lagres per kunde (i nettleseren) og sendes med
  neste kjøring, så modellen skriver i samme stemme og vekter typene som faktisk velges.
- **Tilgang**: ingen innloggingsside. Del lenken som `https://<domene>/?kode=GR-01`,
  så slipper testeren å skrive koden. Uten kode spørres det rett over knappen.
- **Statistikk**: `/api/stats?token=APP_PASSWORD` viser kjøringer, dager, kopierte hooks og favoritt-type.
- **Eget domene**: se kommentaren nederst i `wrangler.toml`.

`functions/`, `generate.js` og `stats.js` er gamle Pages-versjoner og brukes ikke av `wrangler deploy`.
