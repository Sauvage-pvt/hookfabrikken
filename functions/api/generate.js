// Cloudflare Pages Function — kjører på /api/generate
// Holder API-nøkkelen trygt på serveren og sjekker tilgangskode.
//
// Miljøvariabler i Cloudflare (Settings -> Variables):
//   ANTHROPIC_API_KEY = nøkkelen din fra console.anthropic.com  (Secret!)
//   APP_PASSWORD      = ditt eget hovedpassord                  (Secret!)
//   KODER             = GR-01,GR-02,GR-03,GR-04,GR-05,GR-06,GR-07,GR-08,GR-09,GR-10
//
// KV-binding (Settings -> Functions -> KV namespace bindings):
//   BRUK = hookfabrikken-bruk
//   Uten BRUK fungerer alt, men da telles ikke bruken.

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

  // Ditt eget hovedpassord: alltid inn, telles ikke
  if (env.APP_PASSWORD && inn === env.APP_PASSWORD) {
    return { ok: true, kode: "EIER" };
  }

  const kode = inn.toUpperCase();
  const gyldige = (env.KODER || "")
    .split(",")
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean);

  if (!gyldige.includes(kode)) return { ok: false };

  // Tell bruken hvis KV er koblet på
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

// --- Hovedfunksjon -----------------------------------------------

export async function onRequestPost({ request, env }) {
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
