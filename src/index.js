// src/index.js — hovedinngang for Workeren.
// Kombinerer det som før lå i functions/api/generate.js og functions/api/stats.js
// (Pages Functions-stil) til én fetch-handler, siden dette prosjektet er satt opp
// som en Worker med statiske assets (wrangler.toml -> main = "src/index.js"),
// ikke som et Cloudflare Pages-prosjekt. functions/-mappen blir ikke lest av
// "wrangler deploy" for denne prosjekttypen — derfor feilet siste bygg da
// src/index.js ble slettet.
const MODELL = "claude-haiku-4-5-20251001"; // billigst. Bytt til "claude-sonnet-5" for bedre copy.

function byggPrompt(p, t, harBilde) {
    const b = p.modus === "bedrift";

  const profilTekst = b
      ? `BEDRIFTSPROFIL:
      - Bedrift/merkevare: ${p.navn || "ikke oppgitt"}
      - Bransje/hva de selger: ${p.produkt || "ikke oppgitt"}
      - Historie/bakgrunn: ${p.historie || "ikke oppgitt"}
      - Målgruppe: ${p.malgruppe || "ikke oppgitt"}`
        : `PERSONPROFIL:
        - Navn/alias: ${p.navn || "ikke oppgitt"}
        - Alder: ${p.alder || "ikke oppgitt"}
        - Kjønn: ${p.kjonn || "ikke oppgitt"}
        - Bakgrunn/historie: ${p.historie || "ikke oppgitt"}
        - Hva selges/promoteres: ${p.produkt || "ikke oppgitt"}
        - Målgruppe: ${p.malgruppe || "ikke oppgitt"}`;

  const bildeRegel = harBilde
      ? `\n- Du har fått et bilde. Ta utgangspunkt i det du FAKTISK ser i bildet — konkrete detaljer,
      stemning, farger, motiv. Ikke skriv generisk tekst som kunne passet et hvilket som helst bilde.`
        : "";

  const felles = `Du er en erfaren norsk SoMe-copywriter som skriver innhold som konverterer.

  ${profilTekst}
  - Plattform: ${p.plattform}
  - Tone: ${p.tone}
  - Språk: ${p.sprak}

  Regler:
  - Skriv på ${p.sprak === "engelsk" ? "engelsk" : "norsk (bokmål)"}.
  - Vær konkret og personlig, aldri generisk. Bruk detaljer fra profilen.
  - Ingen overdrevne løfter om inntekt eller resultater. Ærlig og troverdig.${bildeRegel}
  - Svar KUN med gyldig JSON. Ingen forklaring, ingen markdown, ingen backticks.`;

  const prompts = {
        hooks: `${felles}

        Lag 8 scroll-stoppende hooks (første linje i et innlegg) for ${p.plattform}.
        Varier mellom: nysgjerrighet, tall/konkret, kontrast, personlig historie, spørsmål.
        JSON-format: {"hooks":[{"tekst":"...","type":"nysgjerrighet"}]}`,

        pitch: `${felles}

        Lag: 1) en bio (maks 150 tegn), 2) en kort pitch på 1-2 setninger,
        3) en lengre pitch på ca 4 setninger som forteller historien og hvorfor folk bør følge/kjøpe.
        JSON-format: {"bio":"...","pitch_kort":"...","pitch_lang":"..."}`,

        innlegg: `${felles}

        Lag 2 komplette ${p.plattform}-innlegg klare til publisering. Hvert innlegg: sterk hook som
        første linje, kropp med historie/verdi, tydelig CTA til slutt, og 5 relevante hashtags.
        JSON-format: {"innlegg":[{"tittel":"kort intern tittel","tekst":"hele innlegget med linjeskift","hashtags":["#..."]}]}`,
  };

  return prompts[t];
}

// --- Tilgangskontroll + måling -----------------------------------

async function sjekkTilgang(body, env) {
    const inn = (body.passord || "").trim();

  if (env.APP_PASSWORD && inn === env.APP_PASSWORD) {
        return { ok: true, kode: "EIER" };
  }

  const kode = inn.toUpperCase();
    const gyldige = (env.KODER || "")
      .split(",")
      .map((k) => k.trim().toUpperCase())
      .filter(Boolean);

  if (!gyldige.includes(kode)) return { ok: false };

  if (env.BRUK) {
        try {
                const nokkel = "kode:" + kode;
                const d = JSON.parse((await env.BRUK.get(nokkel)) || "{}");
                const na = new Date().toISOString();
                d.bruk = (d.bruk || 0) + 1;
                d.sist = na;
                if (!d.forste) d.forste = na;
                d.dager = d.dager || [];
                const dag = na.slice(0, 10);
                if (!d.dager.includes(dag)) d.dager.push(dag);
                await env.BRUK.put(nokkel, JSON.stringify(d));
        } catch (e) {
                // måling skal aldri stoppe genereringen
        }
  }

  return { ok: true, kode };
}

// --- /api/generate --------------------------------------------------

async function handleGenerate(request, env) {
    const svar = (obj, status = 200) =>
          new Response(JSON.stringify(obj), {
                  status,
                  headers: { "Content-Type": "application/json" },
          });

  if (!env.ANTHROPIC_API_KEY) {
        return svar({ error: "Mangler ANTHROPIC_API_KEY på serveren." }, 500);
  }

  let body;
    try {
          body = await request.json();
    } catch {
          return svar({ error: "Ugyldig forespørsel." }, 400);
    }

  const tilgang = await sjekkTilgang(body, env);
    if (!tilgang.ok) {
          return svar({ error: "Feil kode." }, 401);
    }

  const { profil, type, bilde } = body;
    const harBilde = !!(bilde && bilde.data);
    const prompt = byggPrompt(profil || {}, type, harBilde);
    if (!prompt) return svar({ error: "Ukjent type." }, 400);

  const innhold = [];
    if (harBilde) {
          innhold.push({
                  type: "image",
                  source: { type: "base64", media_type: bilde.type, data: bilde.data },
          });
    }
    innhold.push({ type: "text", text: prompt });

  try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                          "Content-Type": "application/json",
                          "x-api-key": env.ANTHROPIC_API_KEY,
                          "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                          model: MODELL,
                          max_tokens: 2000,
                          messages: [{ role: "user", content: innhold }],
                }),
        });

      const data = await r.json();
        if (data.error) {
                return svar({ error: "AI-tjenesten svarte med feil." }, 502);
        }

      const tekst = (data.content || [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");

      return svar({ tekst });
  } catch (e) {
        return svar({ error: "Feil mot AI-tjenesten." }, 500);
  }
}

// --- /api/stats -------------------------------------------------------
// Åpne: https://hookfabrikken.../api/stats?token=DITT_APP_PASSWORD

async function handleStats(request, env) {
    const url = new URL(request.url);

  if (url.searchParams.get("token") !== env.APP_PASSWORD) {
        return new Response("Nei.", { status: 403 });
  }

  if (!env.BRUK) {
        return new Response("KV-binding BRUK mangler.", { status: 500 });
  }

  const alle = (env.KODER || "")
      .split(",")
      .map((k) => k.trim().toUpperCase())
      .filter(Boolean);

  const rader = [];
    for (const kode of alle) {
          const rå = await env.BRUK.get("kode:" + kode);
          const d = rå ? JSON.parse(rå) : {};
          rader.push({
                  kode,
                  bruk: d.bruk || 0,
                  dager: (d.dager || []).length,
                  forste: d.forste ? d.forste.slice(0, 10) : "–",
                  sist: d.sist ? d.sist.slice(0, 10) : "–",
          });
    }

  rader.sort((a, b) => b.bruk - a.bruk);

  const brukt = rader.filter((r) => r.bruk > 0).length;
    const gjengangere = rader.filter((r) => r.dager > 1).length;

  const rows = rader
      .map(
              (r) => `<tr${r.bruk === 0 ? ' class="tom"' : ""}>
              <td><b>${r.kode}</b></td>
              <td>${r.bruk}</td>
              <td>${r.dager}</td>
              <td>${r.forste}</td>
              <td>${r.sist}</td>
              </tr>`
            )
      .join("");

  const html = `<!doctype html>
  <html lang="no"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Hookfabrikken – bruk</title>
  <style>
  body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:24px;
  background:#111;color:#eee;line-height:1.5}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#888;font-size:14px;margin-bottom:24px}
  .tall{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
  .kort{background:#1c1c1c;border:1px solid #2a2a2a;border-radius:10px;
  padding:14px 18px;min-width:110px}
  .kort .n{font-size:26px;font-weight:600}
  .kort .t{font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.5px}
  table{width:100%;border-collapse:collapse;font-size:15px}
  th{text-align:left;color:#888;font-weight:500;font-size:12px;
  text-transform:uppercase;letter-spacing:.5px;padding:8px 6px;
  border-bottom:1px solid #2a2a2a}
  td{padding:11px 6px;border-bottom:1px solid #1e1e1e}
  tr.tom td{color:#555}
  .fasit{margin-top:28px;padding:16px;background:#1c1c1c;
  border-left:3px solid #4a7;border-radius:6px;font-size:14px}
  </style></head><body>
  <h1>Hookfabrikken – testgruppe</h1>
  <div class="sub">${new Date().toLocaleDateString("no-NO")}</div>

  <div class="tall">
  <div class="kort"><div class="n">${brukt}/${alle.length}</div>
  <div class="t">har prøvd</div></div>
  <div class="kort"><div class="n">${gjengangere}</div>
  <div class="t">kom tilbake</div></div>
  <div class="kort"><div class="n">${rader.reduce((s, r) => s + r.bruk, 0)}</div>
  <div class="t">kjøringer</div></div>
  </div>

  <table>
  <tr><th>Kode</th><th>Kjøringer</th><th>Dager</th><th>Første</th><th>Siste</th></tr>
  ${rows}
  </table>

  <div class="fasit">
  <b>Tallet som betyr noe:</b> «kom tilbake» — antall som har brukt den på
  mer enn én dag. Er det under 3 etter to uker, er det ikke et produkt ennå.
  </div>
  </body></html>`;

  return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// --- Hovedinngang -------------------------------------------------

export default {
    async fetch(request, env, ctx) {
          const url = new URL(request.url);

      if (url.pathname === "/api/generate" && request.method === "POST") {
              return handleGenerate(request, env);
      }

      if (url.pathname === "/api/stats" && request.method === "GET") {
              return handleStats(request, env);
      }

      // Alt annet: server statiske filer (index.html m.m.) fra assets.
      return env.ASSETS.fetch(request);
    },
};
