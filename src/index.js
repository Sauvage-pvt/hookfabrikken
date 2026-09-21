/**
 * Bedriftssok - Cloudflare Worker
 *
 * Soek i Broennoeysund + SEO- og AI-synlighetsanalyse av nettsidene.
 *
 * Deploy: push til GitHub, koble repoet i Cloudflare dashboard.
 * Live: bedriftssok.lenkemotor.workers.dev
 */

const BRREG = "https://data.brreg.no/enhetsregisteret/api/enheter";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/sok") return sokBrreg(url);
    if (url.pathname === "/api/analyse") return analyserSide(url);
    if (url.pathname === "/api/gjett") return gjettNettside(url);
    if (url.pathname === "/api/bransjer") return bransjeApi(url);
    if (url.pathname === "/api/pitch") return lagPitch(request, env);
    if (url.pathname === "/api/profil") return profilApi(request, env);
    if (url.pathname === "/mote") {
      return new Response(MOTE, {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }
    if (url.pathname === "/oppsett") {
      return new Response(OPPSETT, {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }

    return new Response(SIDE, {
      headers: { "content-type": "text/html;charset=utf-8" },
    });
  },
};

/* ------------------------------------------------------------------ Brreg */

async function sokBrreg(url) {
  const p = new URLSearchParams();
  const navn = url.searchParams.get("navn");
  const orgnr = url.searchParams.get("orgnr");
  const kode = url.searchParams.get("naeringskode");
  const kommune = url.searchParams.get("kommunenummer");

  if (orgnr) p.set("organisasjonsnummer", orgnr);
  else if (navn) { p.set("navn", navn); p.set("size", "20"); }
  else if (kode) {
    p.set("naeringskode", kode);
    p.set("size", "100");
    if (kommune) p.set("kommunenummer", kommune);
  } else return json({ feil: "Mangler søkeord" }, 400);

  try {
    const r = await fetch(`${BRREG}?${p}`, {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) return json({ feil: `Brreg svarte ${r.status}` }, 502);
    const d = await r.json();
    const enheter = d?._embedded?.enheter || [];
    return json({
      totalt: d?.page?.totalElements ?? enheter.length,
      enheter: enheter.map(forenkle),
    });
  } catch (e) {
    return json({ feil: String(e.message || e) }, 502);
  }
}

function forenkle(u) {
  const a = u.forretningsadresse || u.postadresse || {};
  return {
    navn: u.navn,
    orgnr: u.organisasjonsnummer,
    form: u.organisasjonsform?.beskrivelse || "",
    bransje: u.naeringskode1?.beskrivelse || "",
    ansatte: u.antallAnsatte ?? null,
    telefon: u.telefon || u.mobil || "",
    epost: u.epostadresse || "",
    nettside: renskUrl(u.hjemmeside),
    adresse: [(a.adresse || []).filter(Boolean).join(" "),
              [a.postnummer, a.poststed].filter(Boolean).join(" ")]
             .filter(Boolean).join(", "),
    poststed: a.poststed || "",
    registrert: u.registreringsdatoEnhetsregisteret || u.stiftelsesdato || "",
    naeringskode: u.naeringskode1?.kode || "",
    konkurs: !!u.konkurs,
    avvikling: !!u.underAvvikling,
  };
}

function renskUrl(u) {
  if (!u) return "";
  u = String(u).trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : "https://" + u;
}

/* --------------------------------------------------------------- analyse */

const AI_ROBOTER = ["GPTBot", "ClaudeBot", "PerplexityBot",
                    "Google-Extended", "CCBot", "anthropic-ai"];

async function analyserSide(url) {
  const mal = renskUrl(url.searchParams.get("url"));
  if (!mal) return json({ feil: "Mangler url" }, 400);

  const start = Date.now();
  let html = "", status = 0, endelig = mal;

  try {
    const r = await fetch(mal, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Bedriftssok/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    status = r.status;
    endelig = r.url || mal;
    if (r.ok) html = (await r.text()).slice(0, 400000);
  } catch (e) {
    return json({ feil: "Fikk ikke kontakt med nettsiden", detalj: String(e.message || e) });
  }

  const ms = Date.now() - start;
  if (!html) return json({ feil: `Nettsiden svarte ${status}` });

  const robots = await lesRobots(endelig);
  const llms = await harLlmsTxt(endelig);

  return json(vurder(html, endelig, ms, robots, llms));
}

async function lesRobots(side) {
  try {
    const u = new URL("/robots.txt", side);
    const r = await fetch(u.href, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { finnes: false, blokkerer: [] };
    const t = (await r.text()).slice(0, 20000);
    const blokkerer = AI_ROBOTER.filter((bot) => blokkeres(t, bot));
    return { finnes: true, blokkerer };
  } catch {
    return { finnes: false, blokkerer: [] };
  }
}

/* Leter etter en User-agent-blokk for boten med Disallow: / */
function blokkeres(robots, bot) {
  const linjer = robots.split(/\r?\n/);
  let inne = false;
  for (const raa of linjer) {
    const l = raa.trim();
    if (/^user-agent:/i.test(l)) {
      const navn = l.split(":")[1].trim().toLowerCase();
      inne = navn === bot.toLowerCase();
      continue;
    }
    if (inne && /^disallow:\s*\/\s*$/i.test(l)) return true;
    if (inne && /^user-agent:/i.test(l)) inne = false;
  }
  return false;
}

async function harLlmsTxt(side) {
  try {
    const u = new URL("/llms.txt", side);
    const r = await fetch(u.href, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return false;
    const t = await r.text();
    return t.length > 20 && !/<html/i.test(t.slice(0, 200));
  } catch {
    return false;
  }
}

function vurder(html, url, ms, robots, llms) {
  const lav = html.toLowerCase();
  const funn = [];

  const legg = (omrade, navn, ok, notat) =>
    funn.push({ omrade, navn, ok, notat: notat || "" });

  /* ---- teknisk ---- */
  legg("Teknisk", "HTTPS", url.startsWith("https://"),
       url.startsWith("https://") ? "" : "Kjører på usikret http");

  const rask = ms < 2500;
  legg("Teknisk", "Svartid", rask, `${(ms / 1000).toFixed(1)} sekunder`);

  const viewport = /<meta[^>]+name=["']?viewport/i.test(html);
  legg("Teknisk", "Mobiltilpasset", viewport,
       viewport ? "" : "Mangler viewport — skalerer ikke på telefon");

  /* ---- soek ---- */
  const tittel = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const tLen = tittel ? tittel.trim().length : 0;
  legg("Søk", "Sidetittel", tLen >= 15 && tLen <= 65,
       tittel ? `${tLen} tegn: «${tittel.trim().slice(0, 55)}»` : "Mangler helt");

  const besk = (html.match(
    /<meta[^>]+name=["']?description["']?[^>]*content=["']([\s\S]*?)["']/i) || [])[1];
  const bLen = besk ? besk.trim().length : 0;
  legg("Søk", "Metabeskrivelse", bLen >= 50 && bLen <= 165,
       besk ? `${bLen} tegn` : "Mangler — Google finner på sin egen");

  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/gi) || []).length;
  legg("Søk", "Overskrift (H1)", h1 === 1,
       h1 === 0 ? "Ingen H1 på siden" : h1 > 1 ? `${h1} stykker — bør være én` : "");

  const bilder = (html.match(/<img[\s>]/gi) || []).length;
  const medAlt = (html.match(/<img[^>]+alt=["'][^"']+["']/gi) || []).length;
  const altOk = bilder === 0 || medAlt / bilder >= 0.7;
  legg("Søk", "Alt-tekst på bilder", altOk,
       bilder ? `${medAlt} av ${bilder} har alt-tekst` : "Ingen bilder");

  /* ---- lokalt ---- */
  const tlf = /(?:tlf|telefon|ring)[^<]{0,20}[\d\s]{8,}|href=["']tel:/i.test(html);
  legg("Lokalt", "Telefon synlig", tlf, tlf ? "" : "Fant ikke noe nummer");

  const postnr = /\b\d{4}\s+[A-ZÆØÅ][a-zæøå]/.test(html);
  legg("Lokalt", "Adresse synlig", postnr, postnr ? "" : "Fant ingen postadresse");

  const kart = /(maps\.google|google\.com\/maps|openstreetmap)/i.test(lav);
  legg("Lokalt", "Kart eller veibeskrivelse", kart);

  const tider = /(åpningstid|apningstid|åpent|mandag|man-fre|man–fre)/i.test(lav);
  legg("Lokalt", "Åpningstider", tider);

  /* ---- AI-synlighet (GEO) ---- */
  const jsonld = /<script[^>]+type=["']application\/ld\+json/i.test(html);
  legg("AI-synlighet", "Strukturerte data", jsonld,
       jsonld ? "" : "Ingen schema.org — assistenter må gjette");

  const lokalSchema = /"@type"\s*:\s*"(LocalBusiness|HairSalon|Restaurant|Dentist|Store|ProfessionalService|HealthAndBeautyBusiness)/i.test(html);
  legg("AI-synlighet", "Bedriftsdata i schema", lokalSchema,
       lokalSchema ? "" : "Mangler LocalBusiness-oppføring");

  const apneRoboter = robots.blokkerer.length === 0;
  legg("AI-synlighet", "AI-roboter slipper inn", apneRoboter,
       apneRoboter ? (robots.finnes ? "" : "Ingen robots.txt — alt er åpent")
                   : `Blokkerer ${robots.blokkerer.join(", ")}`);

  legg("AI-synlighet", "llms.txt", llms,
       llms ? "" : "Mangler — ny standard for AI-lesere");

  const tekstMengde = html.replace(/<script[\s\S]*?<\/script>/gi, "")
                          .replace(/<style[\s\S]*?<\/style>/gi, "")
                          .replace(/<[^>]+>/g, " ")
                          .replace(/\s+/g, " ").trim().length;
  const nokTekst = tekstMengde > 600;
  legg("AI-synlighet", "Lesbar tekst uten JavaScript", nokTekst,
       `${tekstMengde} tegn i rå HTML`);

  /* ---- konvertering ---- */
  const skjema = /<form[\s>]/i.test(html) || /kontaktskjema/i.test(lav);
  legg("Konvertering", "Kontaktskjema", skjema);

  const booking = /(bestill time|book time|booking|timebestilling|calendly|bestill nå)/i.test(lav);
  legg("Konvertering", "Online booking", booking,
       booking ? "" : "Kunden må ringe i åpningstiden");

  const chat = /(intercom|tawk\.to|crisp\.chat|zendesk|livechat|drift\.com|messenger\.com\/)/i.test(lav);
  legg("Konvertering", "Chat", chat);

  /* ---- oppsummering ---- */
  const mangler = funn.filter((f) => !f.ok);
  const poeng = Math.round((funn.filter((f) => f.ok).length / funn.length) * 100);

  const vekt = ["Online booking", "Mobiltilpasset", "Kontaktskjema",
                "Bedriftsdata i schema", "Sidetittel", "Telefon synlig"];
  const viktigst = vekt.filter((v) => mangler.some((m) => m.navn === v)).slice(0, 3);

  return {
    url, poeng, ms,
    antallFunn: funn.length,
    antallMangler: mangler.length,
    funn,
    salgsvinkel: viktigst.length
      ? "Mangler " + viktigst.map((v) => v.toLowerCase()).join(", ")
      : "Godt dekket — lav prioritet",
  };
}

/* ------------------------------------------------------------ bransjer */

/*
 * Naeringskodene hentes fra SSB, samme kilde som Broennoeysund bruker.
 * Da slutter verktoeyet ikke aa virke neste gang standarden endres,
 * slik den gjorde da SN2007 ble byttet ut med SN2025.
 */
const KLASS = "https://data.ssb.no/api/klass/v1/classifications/6/codesAt";
let BRANSJE_MINNE = null;
let BRANSJE_TID = 0;

async function lastBransjer() {
  if (BRANSJE_MINNE && Date.now() - BRANSJE_TID < 86400000) return BRANSJE_MINNE;

  const dato = new Date().toISOString().slice(0, 10);
  const r = await fetch(`${KLASS}?date=${dato}&language=nb`, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 86400, cacheEverything: true },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`SSB svarte ${r.status}`);
  const d = await r.json();

  const alle = (d.codes || d.classificationItems || []).map((k) => {
    let kode = String(k.code || "");
    if (/^\d{5}$/.test(kode)) kode = kode.slice(0, 2) + "." + kode.slice(2);
    return { kode, navn: k.name || k.shortName || "", niva: Number(k.level) };
  });

  const divisjoner = {};
  alle.filter((k) => k.niva === 2).forEach((k) => { divisjoner[k.kode] = k.navn; });
  const under = alle.filter((k) => k.niva === 5 && /^\d{2}\.\d{3}$/.test(k.kode));

  if (!under.length) throw new Error("SSB ga ingen underbransjer");

  BRANSJE_MINNE = { divisjoner, under };
  BRANSJE_TID = Date.now();
  return BRANSJE_MINNE;
}

async function bransjeApi(url) {
  try {
    const { divisjoner, under } = await lastBransjer();
    const onsket = (url.searchParams.get("div") || "")
      .split(",").map((x) => x.trim()).filter(Boolean);

    const grupper = (onsket.length ? onsket : Object.keys(divisjoner).sort())
      .filter((d) => divisjoner[d])
      .map((d) => ({
        div: d,
        navn: divisjoner[d],
        koder: under.filter((k) => k.kode.slice(0, 2) === d)
                    .map((k) => ({ kode: k.kode, navn: k.navn })),
      }))
      .filter((g) => g.koder.length);

    return new Response(JSON.stringify({ grupper }), {
      headers: {
        "content-type": "application/json;charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  } catch (e) {
    return json({ feil: "Fikk ikke hentet bransjer fra SSB",
                  detalj: String(e.message || e) }, 502);
  }
}

/* ------------------------------------------------------------- gjett URL */

/* Ord som ikke hjelper i et domenenavn */
const FYLLORD = new Set([
  "as", "asa", "ans", "da", "sa", "ba", "nuf", "kf", "if", "ks",
  "avd", "avdeling", "norge", "norway", "gruppen", "group", "holding",
  "og", "the",
]);

function navnTilKandidater(navn) {
  const reint = String(navn || "")
    .toLowerCase()
    .replace(/[.,/()'"&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const ord = reint.split(" ").filter((o) => o && !FYLLORD.has(o));
  if (!ord.length) return [];

  /* To skrivemåter: æøå beholdt, og omskrevet slik folk flest gjør det */
  const varianter = (s) => {
    const beholdt = s.replace(/[^a-zæøå0-9]/g, "");
    const skrevet = s
      .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
      .replace(/[^a-z0-9]/g, "");
    return beholdt === skrevet ? [skrevet] : [skrevet, beholdt];
  };

  const stammer = new Set();
  [ord.join(""), ord[0], ord.slice(0, 2).join("")].forEach((s) => {
    if (s && s.length >= 3 && s.length <= 40) {
      varianter(s).forEach((v) => stammer.add(v));
    }
  });

  const ut = [];
  for (const s of stammer) {
    ut.push(`https://www.${s}.no`);
    ut.push(`https://${s}.no`);
  }
  for (const s of stammer) ut.push(`https://www.${s}.com`);

  return ut.slice(0, 10);
}

/* Sjekker om siden faktisk tilhører foretaket */
function tilhorer(html, navn) {
  const ord = String(navn || "").toLowerCase()
    .replace(/[.,/()'"&]/g, " ").split(/\s+/)
    .filter((o) => o.length >= 4 && !FYLLORD.has(o));
  if (!ord.length) return false;
  const lav = html.toLowerCase();
  return ord.some((o) => lav.includes(o));
}

async function gjettNettside(url) {
  const navn = url.searchParams.get("navn") || "";
  if (!navn) return json({ feil: "Mangler navn" }, 400);

  const kandidater = navnTilKandidater(navn);
  if (!kandidater.length) return json({ funnet: null, provde: [] });

  const provde = [];

  for (const k of kandidater) {
    try {
      const r = await fetch(k, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Bedriftssok/1.0)" },
        redirect: "follow",
        signal: AbortSignal.timeout(6000),
      });
      provde.push(k);
      if (!r.ok) continue;

      const html = (await r.text()).slice(0, 60000);
      const treff = tilhorer(html, navn);

      return json({
        funnet: r.url || k,
        sikker: treff,
        provde,
      });
    } catch {
      provde.push(k);
    }
  }

  return json({ funnet: null, provde });
}

/* --------------------------------------------------------------- profiler */

const TONER = {
  nokternt: "Nøktern og saklig. Ingen store ord, ingen superlativer.",
  varm: "Vennlig og personlig. Lokal tone, som en du møter på butikken.",
  direkte: "Kort og rett på sak. Ingen omveier, ingen oppvarming.",
  faglig: "Fagtung. Kunden kan bransjen fra før og trenger ikke forklaringer.",
};

const NESTE_STEG = {
  telefon: "en kort telefonsamtale senere",
  mote: "et møte på deres kontor",
  befaring: "en befaring på stedet",
  demo: "en demonstrasjon",
  tilbud: "å få sende et tilbud",
};

async function profilApi(request, env) {
  const url = new URL(request.url);
  const kode = url.searchParams.get("k") || "";
  if (env.PITCH_KODE && kode !== env.PITCH_KODE) {
    return json({
      feil: kode
        ? "Koden i adressen stemmer ikke med PITCH_KODE i Cloudflare"
        : "Mangler kode — legg ?k=dinkode bakerst i adressen",
    }, 403);
  }
  if (!env.PROFILER) {
    return json({ feil: "KV-lageret PROFILER er ikke koblet til" }, 500);
  }

  const id = (url.searchParams.get("id") || "").trim();

  if (request.method === "GET") {
    if (!id) {
      const liste = await env.PROFILER.list({ prefix: "profil:" });
      return json({ profiler: liste.keys.map((k) => k.name.slice(7)) });
    }
    const p = await env.PROFILER.get("profil:" + id, "json");
    return p ? json(p) : json({ feil: "Fant ingen profil" }, 404);
  }

  if (request.method === "PUT" || request.method === "POST") {
    if (!id) return json({ feil: "Mangler id" }, 400);
    let data;
    try { data = await request.json(); }
    catch { return json({ feil: "Ugyldig JSON" }, 400); }
    data.id = id;
    await env.PROFILER.put("profil:" + id, JSON.stringify(data));
    return json({ ok: true, id });
  }

  if (request.method === "DELETE") {
    if (!id) return json({ feil: "Mangler id" }, 400);
    await env.PROFILER.delete("profil:" + id);
    return json({ ok: true });
  }

  return json({ feil: "Ustøttet metode" }, 405);
}

const FELLES = `Skriv på norsk bokmål. Ingen utropstegn, ingen superlativer,
ingen "spennende muligheter". Skriv som en voksen som tar kontakt med en
annen voksen.

Du kjenner bare opplysningene i faktaboksen. Dikt aldri opp eiere, ansatte,
omsetning, hendelser eller hva mottakeren trenger. Er noe ukjent, la det
være ute.`;

const SYSTEM_EGET = `Du forbereder en norsk enkeltperson på en kald telefon
til en lokal bedrift om nettsiden deres.

${FELLES}

Viktigst: samtalen skal IKKE åpne med en liste over feil på nettsiden deres.
Ingen liker å bli ringt opp og fortalt at de har gjort noe dårlig. Åpningen
skal handle om noe de kjenner igjen fra egen hverdag — at folk ringer utenom
åpningstid, at de svarer på det samme om og om igjen, at de ikke vet hvor
kundene kommer fra. Nevn ingen tall fra analysen i åpningen.

Svar med gyldig JSON og ingenting annet:
{"apning":"...","sporsmal":["...","...","..."],"innvendinger":[{"de_sier":"...","du_svarer":"..."}],"neste_steg":"..."}

apning: 3-4 setninger til telefonen.
sporsmal: tre spørsmål som får dem til å beskrive problemet selv.
innvendinger: to sannsynlige innvendinger med et kort, ærlig svar på hver.
neste_steg: én setning om hva du foreslår til slutt.`;

function systemSelger(p) {
  const s = p.selger || {};
  const tone = TONER[p.tone] || TONER.nokternt;
  const steg = NESTE_STEG[p.booking?.onsker] || NESTE_STEG.telefon;

  const produkter = (p.produkter || [])
    .map((x) => `- ${x.navn}${x.pris ? ` (${x.pris})` : ""}${
      x.beskrivelse ? `: ${x.beskrivelse}` : ""}`)
    .join("\n") || "(ikke oppgitt)";

  const reise = p.reise?.besoker
    ? `\nAvsenderen reiser rundt og besøker ett område om gangen. Hvis
${p.reise.uke ? `han er i området i ${p.reise.uke}, ` : "han er i området, "}skal
det nevnes tidlig — det er timingen som gjør henvendelsen relevant, ikke
produktet.`
    : "";

  const unngaa = (p.unngaa_ord || []).length
    ? `\nBruk ALDRI disse ordene: ${p.unngaa_ord.join(", ")}.`
    : "";

  const egne = p.egne_vendinger
    ? `\nAvsenderen sier gjerne: «${p.egne_vendinger}». Bruk det hvis det passer.`
    : "";

  return `Du forbereder en norsk selger på å ta kontakt med en bedrift.

${FELLES}

AVSENDEREN
${s.navn || ""}, ${s.rolle || ""} i ${s.firma || ""}.
Jobber i ${s.omrade || "området"}.

SELGER
${p.tilbyr || ""}

PRODUKTER
${produkter}

TONE
${tone}${unngaa}${egne}${reise}

MÅLET MED SAMTALEN
Avsenderen ønsker ${steg}.${
  p.booking?.lenke ? ` Bookinglenke: ${p.booking.lenke}` : ""}

Svar med gyldig JSON og ingenting annet:
{"apning":"...","sporsmal":["...","...","..."],"innvendinger":[{"de_sier":"...","du_svarer":"..."}],"neste_steg":"...","epost_emne":"...","epost_tekst":"..."}

apning: 3-4 setninger til telefonen. Presenter avsenderen, si hvorfor akkurat
denne bedriften, be om noen minutter.
sporsmal: tre spørsmål som får mottakeren til å beskrive situasjonen selv.
innvendinger: to sannsynlige innvendinger med et kort, ærlig svar på hver.
neste_steg: én setning om hva avsenderen foreslår til slutt.
epost_emne: under 60 tegn, konkret, ikke klikkagn.
epost_tekst: 4-6 linjer. Avslutt med signaturen nedenfor, ordrett.

SIGNATUR
${p.signatur || `${s.navn || ""}\n${s.firma || ""}${s.telefon ? "\n" + s.telefon : ""}`}`;
}

/* ----------------------------------------------------------------- pitch */

/*
 * PRISENE DINE. Endre her, ingen andre steder.
 * Modellen velger ikke pris - den bare skriver hvordan du snakker om det.
 */
const TILTAK = {
  nettside:  { navn: "Enkel nettside", pris: 12000, timer: 10,
               hvorfor: "De har ingen egen side i dag" },
  mobil:     { navn: "Mobiltilpasning", pris: 6000, timer: 5,
               hvorfor: "Over halvparten av besøkene kommer fra telefon" },
  skjema:    { navn: "Kontaktskjema", pris: 2500, timer: 2,
               hvorfor: "Folk som ikke vil ringe, forsvinner i dag" },
  booking:   { navn: "Online booking", pris: 4500, timer: 4,
               hvorfor: "Kunden må ringe i åpningstiden for å bestille" },
  chat:      { navn: "AI-chat med bedriftens egen info", pris: 7500, timer: 6,
               hvorfor: "Svarer på pris og ledig time døgnet rundt",
               manedlig: 500 },
  seo:       { navn: "Søkeoptimalisering", pris: 3500, timer: 3,
               hvorfor: "Tittel og beskrivelse avgjør om noen klikker i Google" },
  schema:    { navn: "Strukturerte data", pris: 3500, timer: 3,
               hvorfor: "Google og AI-assistenter må få vite hva slags bedrift dette er" },
  ai:        { navn: "AI-synlighet", pris: 4500, timer: 4,
               hvorfor: "Så bedriften dukker opp når folk spør ChatGPT" },
  lokal:     { navn: "Lokal synlighet", pris: 2500, timer: 2,
               hvorfor: "Adresse, telefon og åpningstider må stå der maskinene leter" },
  bilder:    { navn: "Bildeoptimalisering", pris: 2000, timer: 2,
               hvorfor: "Bilder uten alt-tekst teller ikke i søk" },
  fart:      { navn: "Fart og ytelse", pris: 4000, timer: 4,
               hvorfor: "Treg side gjør at folk gir opp før den er lastet" },
  https:     { navn: "HTTPS", pris: 1500, timer: 1,
               hvorfor: "Nettleseren advarer besøkende mot usikrede sider" },
};

/* Hvilket funn utløser hvilket tiltak */
const KOBLING = {
  "Mobiltilpasset": "mobil",
  "Kontaktskjema": "skjema",
  "Online booking": "booking",
  "Chat": "chat",
  "Sidetittel": "seo",
  "Metabeskrivelse": "seo",
  "Overskrift (H1)": "seo",
  "Alt-tekst på bilder": "bilder",
  "Strukturerte data": "schema",
  "Bedriftsdata i schema": "schema",
  "llms.txt": "ai",
  "AI-roboter slipper inn": "ai",
  "Lesbar tekst uten JavaScript": "ai",
  "Telefon synlig": "lokal",
  "Adresse synlig": "lokal",
  "Kart eller veibeskrivelse": "lokal",
  "Åpningstider": "lokal",
  "Svartid": "fart",
  "HTTPS": "https",
};

function beregnTiltak(funn, harNettside) {
  const valgte = new Set();

  if (!harNettside) {
    valgte.add("nettside");
    valgte.add("skjema");
    valgte.add("lokal");
  } else {
    (funn || []).forEach((f) => {
      if (!f.ok && KOBLING[f.navn]) valgte.add(KOBLING[f.navn]);
    });
  }

  const liste = [...valgte].map((n) => ({ nokkel: n, ...TILTAK[n] }));
  const sum = liste.reduce((s, t) => s + t.pris, 0);
  const timer = liste.reduce((s, t) => s + t.timer, 0);
  const manedlig = liste.reduce((s, t) => s + (t.manedlig || 0), 0);

  /* Tre nivåer så kunden velger mellom ja og ja, ikke mellom ja og nei */
  const viktigst = ["nettside", "mobil", "booking", "skjema"];
  const liten = liste.filter((t) => viktigst.includes(t.nokkel));

  return {
    alle: liste,
    sum, timer, manedlig,
    pakker: [
      {
        navn: "Kom i gang",
        tiltak: liten.length ? liten : liste.slice(0, 2),
        pris: (liten.length ? liten : liste.slice(0, 2))
              .reduce((s, t) => s + t.pris, 0),
      },
      { navn: "Hele jobben", tiltak: liste, pris: sum },
    ],
  };
}

async function lagPitch(request, env) {
  if (request.method !== "POST") return json({ feil: "Krever POST" }, 405);

  const kode = new URL(request.url).searchParams.get("k") || "";
  if (env.PITCH_KODE && kode !== env.PITCH_KODE) {
    return json({
      feil: kode
        ? "Koden i adressen stemmer ikke med PITCH_KODE i Cloudflare"
        : "Mangler kode — legg ?k=dinkode bakerst i adressen",
    }, 403);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json({ feil: "Mangler ANTHROPIC_API_KEY som secret i Cloudflare" }, 500);
  }

  let inn;
  try { inn = await request.json(); }
  catch { return json({ feil: "Ugyldig JSON" }, 400); }

  const bedrift = inn.bedrift || {};
  const analyse = inn.analyse || null;

  /* Selgermodus hvis en profil er oppgitt, ellers Pers eget nettsidesalg */
  let profil = null;
  const profilId = (inn.profil || "").trim();
  if (profilId) {
    if (!env.PROFILER) return json({ feil: "KV-lageret PROFILER mangler" }, 500);
    profil = await env.PROFILER.get("profil:" + profilId, "json");
    if (!profil) return json({ feil: `Fant ingen profil «${profilId}»` }, 404);
  }

  const tiltak = profil ? null : beregnTiltak(analyse?.funn, !!bedrift.nettside);

  const fakta = [
    `Bedrift: ${bedrift.navn || "ukjent"}`,
    bedrift.bransje ? `Bransje: ${bedrift.bransje}` : "",
    bedrift.poststed ? `Sted: ${bedrift.poststed}` : "",
    bedrift.ansatte != null ? `Ansatte: ${bedrift.ansatte}` : "",
    bedrift.nettside ? `Nettside: ${bedrift.nettside}` : "Har ingen nettside",
    (!profil && analyse) ? `Score: ${analyse.poeng} av 100` : "",
    (!profil && analyse) ? `Mangler: ${analyse.funn.filter((f) => !f.ok)
                 .map((f) => f.navn).join(", ")}` : "",
  ].filter(Boolean).join("\n");

  const system = profil ? systemSelger(profil) : SYSTEM_EGET;
  const oppgave = profil
    ? `FAKTA OM MOTTAKEREN\n${fakta}\n\nSkriv samtaleopplegget og e-postutkastet.`
    : `FAKTA\n${fakta}\n\nSkriv samtaleopplegget.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1600,
        system,
        messages: [{ role: "user", content: oppgave }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!r.ok) {
      const t = await r.text();
      return json({ feil: `Claude svarte ${r.status}`, detalj: t.slice(0, 300) }, 502);
    }

    const d = await r.json();
    let tekst = (d.content || []).filter((b) => b.type === "text")
                  .map((b) => b.text).join("").trim();
    if (tekst.startsWith("```")) {
      tekst = tekst.split("```")[1].replace(/^json\s*/i, "").trim();
    }

    return json({ samtale: JSON.parse(tekst), tiltak, profil: profilId || null });
  } catch (e) {
    return json({ feil: "Klarte ikke lage pitch", detalj: String(e.message || e) }, 502);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/* ------------------------------------------------------------------ side */

const SIDE = `<!DOCTYPE html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Bedriftssøk</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;800&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --blekk:#17242C; --myk:#4A5A63;
  --papir:#E6E9E3; --dyp:#D8DDD4; --linje:#B9C0B6;
  --flate:#F5F7F3;
  --rod:#B3402E; --gronn:#2F6D5B;
}
@media (prefers-color-scheme: dark){
  :root{
    --blekk:#E4E8E2; --myk:#98A6A0;
    --papir:#121A1F; --dyp:#1C262C; --linje:#33424A;
    --flate:#18232A;
    --rod:#E0715C; --gronn:#6FBFA3;
  }
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--papir);color:var(--blekk);
  font:400 16px/1.55 "IBM Plex Sans",system-ui,sans-serif;
  padding:0 0 4rem;
}
.ramme{max-width:900px;margin:0 auto;padding:0 clamp(1rem,4vw,2rem)}

header{padding:clamp(1.8rem,6vw,3rem) 0 1.2rem}
.merke{
  font:600 11px/1 "IBM Plex Mono",monospace;letter-spacing:.15em;
  text-transform:uppercase;color:var(--myk);margin-bottom:.9rem;
}
h1{font-family:Archivo,sans-serif;font-weight:800;
   font-size:clamp(1.8rem,6vw,2.8rem);line-height:1;letter-spacing:-.03em}
.under{margin-top:.7rem;color:var(--myk);font-size:.95rem;max-width:52ch}

.faner{display:flex;border-bottom:1px solid var(--linje);margin-top:1.5rem}
.fane{background:none;border:none;cursor:pointer;color:var(--myk);
  font:600 .9rem/1 "IBM Plex Sans",sans-serif;padding:.85rem 1.1rem;
  border-bottom:3px solid transparent;margin-bottom:-1px}
.fane[aria-selected=true]{color:var(--blekk);border-bottom-color:var(--blekk)}

.panel{display:none;padding:1.4rem 0}
.panel.aktiv{display:block}
.rad{display:flex;flex-wrap:wrap;gap:.8rem;align-items:flex-end}
.gruppe{flex:1 1 180px;min-width:0}
label{display:block;font:600 10px/1 "IBM Plex Mono",monospace;
  letter-spacing:.1em;text-transform:uppercase;color:var(--myk);margin-bottom:.45rem}
input,select{width:100%;padding:.8rem .85rem;border-radius:0;
  font:400 1rem/1.2 "IBM Plex Sans",sans-serif;
  background:var(--flate);border:1px solid var(--linje);color:var(--blekk);
  -webkit-appearance:none;appearance:none}
input:focus,select:focus{outline:2px solid var(--blekk);outline-offset:-1px}

button.sok{flex:0 0 auto;background:var(--blekk);color:var(--papir);border:none;
  font:600 .93rem/1 "IBM Plex Sans",sans-serif;padding:.92rem 1.6rem;cursor:pointer}
button.sok:hover{background:var(--gronn)}
button:focus-visible{outline:2px solid var(--blekk);outline-offset:3px}

.status{margin:1.1rem 0;font-size:.92rem;color:var(--myk)}
.status.feil{color:var(--rod);background:var(--flate);
  border-left:3px solid var(--rod);padding:.9rem 1rem}

.kort{background:var(--flate);border:1px solid var(--linje);
  padding:1rem 1.1rem;margin-bottom:.85rem}
.kort h3{font:600 1.05rem/1.3 "IBM Plex Sans",sans-serif;
  margin-bottom:.3rem;word-break:break-word}
.meta{font-size:.85rem;color:var(--myk);line-height:1.5}
.meta .sk{opacity:.4;padding:0 .4rem}
.nr{font-family:"IBM Plex Mono",monospace;font-size:.8rem}

.handling{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.8rem}
.knapp-liten{background:none;border:1px solid var(--linje);color:var(--blekk);
  font:600 .8rem/1 "IBM Plex Sans",sans-serif;padding:.55rem .8rem;cursor:pointer;
  text-decoration:none;display:inline-block}
.knapp-liten:hover{border-color:var(--blekk)}
.knapp-liten[disabled]{opacity:.4;cursor:default}
.knapp-liten.primar{background:var(--blekk);color:var(--papir);border-color:var(--blekk)}
.manuell{display:flex;gap:.5rem;margin-top:.6rem;align-items:stretch}
.manuell input{flex:1;min-width:0;padding:.55rem .7rem;font-size:.85rem;
  background:var(--papir);border:1px solid var(--linje);color:var(--blekk)}

.merkelapp{display:inline-block;font:600 10px/1 "IBM Plex Mono",monospace;
  letter-spacing:.07em;text-transform:uppercase;padding:.3rem .5rem;margin:.5rem .35rem 0 0}
.merkelapp.ja{background:var(--gronn);color:var(--papir)}
.merkelapp.nei{background:var(--rod);color:var(--papir)}
.merkelapp.grå{background:var(--dyp);color:var(--myk)}

/* analyse */
.analyse{margin-top:1rem;padding-top:1rem;border-top:1px solid var(--linje)}
.poeng{display:flex;align-items:baseline;gap:.7rem;margin-bottom:.9rem}
.poeng b{font-family:Archivo,sans-serif;font-weight:800;font-size:2rem;
  line-height:1;letter-spacing:-.03em}
.poeng span{font-size:.87rem;color:var(--myk)}
.omrade{font:600 10px/1 "IBM Plex Mono",monospace;letter-spacing:.12em;
  text-transform:uppercase;color:var(--myk);margin:1rem 0 .5rem}
.sjekk{display:flex;gap:.6rem;align-items:flex-start;
  padding:.35rem 0;font-size:.88rem;line-height:1.45}
.ikon{flex:0 0 1.1rem;font-weight:700;line-height:1.45}
.ikon.ja{color:var(--gronn)}
.ikon.nei{color:var(--rod)}
.sjekk .notat{color:var(--myk);font-size:.83rem}
.vinkel{margin-top:1rem;padding:.8rem .9rem;background:var(--dyp);
  font-size:.9rem;font-weight:500}

/* pitch */
.pitch{margin-top:1rem;padding-top:1rem;border-top:1px solid var(--linje)}
.pitch h4{font:600 10px/1 "IBM Plex Mono",monospace;letter-spacing:.12em;
  text-transform:uppercase;color:var(--myk);margin:1.1rem 0 .5rem}
.sitat{border-left:3px solid var(--gronn);padding:.2rem 0 .2rem .9rem;
  font-size:.93rem;line-height:1.55}
.pitch ul{list-style:none}
.pitch ul li{padding:.3rem 0 .3rem 1.2rem;position:relative;font-size:.9rem}
.pitch ul li::before{content:"–";position:absolute;left:0;color:var(--myk)}
.innv{margin-bottom:.7rem;font-size:.89rem}
.innv b{display:block;color:var(--myk);font-weight:500;font-style:italic}
table.tiltak{width:100%;border-collapse:collapse;font-size:.88rem;margin-top:.3rem}
table.tiltak td{padding:.5rem 0;border-bottom:1px solid var(--linje);
  vertical-align:top}
table.tiltak td.pris{text-align:right;white-space:nowrap;
  font-family:"IBM Plex Mono",monospace;font-size:.85rem}
table.tiltak td small{display:block;color:var(--myk);font-size:.8rem;margin-top:.15rem}
table.tiltak tr.sum td{font-weight:600;border-bottom:none;padding-top:.7rem}
.pakke{background:var(--dyp);padding:.7rem .85rem;margin-top:.5rem;font-size:.89rem;
  display:flex;justify-content:space-between;gap:1rem}
.pakke b{font-family:"IBM Plex Mono",monospace;white-space:nowrap}
pre.epost{background:var(--flate);border:1px solid var(--linje);
  padding:.9rem 1rem;font:400 .88rem/1.6 "IBM Plex Sans",sans-serif;
  white-space:pre-wrap;word-break:break-word;margin-bottom:.6rem}

.lista{margin-top:2.2rem;border-top:3px solid var(--blekk);padding-top:1.2rem}
.lista h2{font:600 11px/1 "IBM Plex Mono",monospace;letter-spacing:.13em;
  text-transform:uppercase;color:var(--myk);margin-bottom:.9rem}
.lista li{display:flex;gap:.7rem;align-items:baseline;padding:.55rem 0;
  border-bottom:1px solid var(--linje);font-size:.91rem;list-style:none}
.lista li .n{flex:1;word-break:break-word}
.lista li button{background:none;border:none;color:var(--rod);
  cursor:pointer;font-size:1.1rem;padding:0 .3rem}
.tom{color:var(--myk);font-size:.9rem;font-style:italic}
.knapper{display:flex;gap:.7rem;flex-wrap:wrap;margin-top:1.2rem}
button.last{background:var(--gronn);color:var(--papir);border:none;
  font:600 .9rem/1 "IBM Plex Sans",sans-serif;padding:.88rem 1.4rem;cursor:pointer}
button.last:disabled{opacity:.4;cursor:default}
button.tomm{background:none;border:1px solid var(--linje);color:var(--myk);
  font:600 .9rem/1 "IBM Plex Sans",sans-serif;padding:.88rem 1.2rem;cursor:pointer}

footer{margin-top:2.5rem;padding-top:1.2rem;border-top:1px solid var(--linje);
  font-size:.83rem;color:var(--myk);max-width:58ch}
</style>
</head>
<body>
<div class="ramme">

<header>
  <p class="merke">Brønnøysund · SEO · AI-synlighet</p>
  <h1>Bedriftssøk</h1>
  <p class="under">Finn bedriften, se hva nettsiden mangler, ta med det som er verdt å ringe.</p>
</header>

<div class="faner" role="tablist">
  <button class="fane" role="tab" aria-selected="true" data-p="p1">Navn</button>
  <button class="fane" role="tab" aria-selected="false" data-p="p2">Bransje og kommune</button>
</div>

<div class="panel aktiv" id="p1">
  <div class="rad">
    <div class="gruppe">
      <label for="navn">Bedriftsnavn eller org.nr</label>
      <input type="text" id="navn" placeholder="Tyr frisør" autocomplete="off">
    </div>
    <button class="sok" id="s1">Søk</button>
  </div>
</div>

<div class="panel" id="p2">
  <div class="rad">
    <div class="gruppe">
      <label for="bransje">Bransje</label>
      <select id="bransje"></select>
    </div>
    <div class="gruppe">
      <label for="kommune">Kommune</label>
      <select id="kommune"></select>
    </div>
    <button class="sok" id="s2">Søk</button>
  </div>
</div>

<div class="status" id="status">Klar.</div>
<div id="profilrad" style="display:none;margin-bottom:1rem">
  <label for="profil">Skriv som</label>
  <select id="profil" style="max-width:340px"></select>
</div>
<div id="treff"></div>

<section class="lista">
  <h2>Lista di — <span id="antall">0</span></h2>
  <ol id="valgt"></ol>
  <p class="tom" id="tomtekst">Ingen valgt ennå.</p>
  <div class="knapper">
    <button class="last" id="lastned" disabled>Last ned CSV</button>
    <button class="tomm" id="tomknapp">Tøm</button>
  </div>
</section>

<footer>
  Opplysningene er offentlige, fra Enhetsregisteret. Analysen henter
  forsiden, robots.txt og llms.txt. CSV-fila har samme kolonner som
  leadmotor og kan mates rett inn i outreach.
</footer>

</div>
<script>
(function(){
"use strict";

var KOMMUNER=[["","Hele landet"],["5001","Trondheim"],["5006","Steinkjer"],
["5007","Namsos"],["5014","Frøya"],["5020","Osen"],["5021","Oppdal"],
["5022","Rennebu"],["5025","Røros"],["5026","Holtålen"],["5027","Midtre Gauldal"],
["5028","Melhus"],["5029","Skaun"],["5031","Malvik"],["5032","Selbu"],
["5033","Tydal"],["5034","Meråker"],["5035","Stjørdal"],["5036","Frosta"],
["5037","Levanger"],["5038","Verdal"],["5041","Snåsa"],["5042","Lierne"],
["5043","Røyrvik"],["5044","Namsskogan"],["5045","Grong"],["5046","Høylandet"],
["5047","Overhalla"],["5049","Flatanger"],["5052","Leka"],["5053","Inderøy"],
["5054","Indre Fosen"],["5055","Heim"],["5056","Hitra"],["5057","Ørland"],
["5058","Åfjord"],["5059","Orkland"],["5060","Nærøysund"],["5061","Rindal"]];

var valgt=[], sisteTreff=[];
var PITCHKODE=new URLSearchParams(location.search).get("k")||"";
function id(x){return document.getElementById(x);}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;")
  .replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}

function lastBransjer(sel,div,foretrukket){
  sel.innerHTML="";
  var v=document.createElement("option");v.value="";
  v.textContent="Henter bransjer fra SSB …";sel.appendChild(v);sel.disabled=true;
  fetch("/api/bransjer?div="+div).then(function(r){return r.json();}).then(function(d){
    sel.innerHTML="";
    if(d.feil||!d.grupper||!d.grupper.length){
      var f=document.createElement("option");f.value="";
      f.textContent="Fikk ikke hentet bransjer — last siden på nytt";
      sel.appendChild(f);sel.disabled=false;return;}
    var valgtOpt=null;
    d.grupper.forEach(function(g){
      var og=document.createElement("optgroup");og.label=g.navn;
      var alle=document.createElement("option");
      alle.value=g.koder.map(function(k){return k.kode;}).join(",");
      alle.textContent="Alle i "+g.navn.charAt(0).toLowerCase()+g.navn.slice(1);
      og.appendChild(alle);
      if(foretrukket===g.div)valgtOpt=alle;
      g.koder.forEach(function(k){
        var o=document.createElement("option");o.value=k.kode;o.textContent=k.navn;
        og.appendChild(o);
        if(!valgtOpt&&foretrukket&&foretrukket.length>2&&
           k.navn.toLowerCase().indexOf(foretrukket)>=0)valgtOpt=o;
      });
      sel.appendChild(og);
    });
    if(valgtOpt)valgtOpt.selected=true;
    sel.disabled=false;
  }).catch(function(){
    sel.innerHTML="";
    var f=document.createElement("option");f.value="";
    f.textContent="Fikk ikke kontakt med SSB";sel.appendChild(f);sel.disabled=false;
  });
}
lastBransjer(id("bransje"),
  "01,16,41,43,47,55,56,62,69,71,73,75,81,86,93,95,96","fris");
KOMMUNER.forEach(function(k){var o=document.createElement("option");
  o.value=k[0];o.textContent=k[1];if(k[0]==="5006")o.selected=true;
  id("kommune").appendChild(o);});

Array.prototype.forEach.call(document.querySelectorAll(".fane"),function(f){
  f.onclick=function(){
    Array.prototype.forEach.call(document.querySelectorAll(".fane"),function(x){
      x.setAttribute("aria-selected",String(x===f));});
    Array.prototype.forEach.call(document.querySelectorAll(".panel"),function(p){
      p.classList.toggle("aktiv",p.id===f.dataset.p);});
  };});

function status(t,feil){
  var s=id("status"); s.className="status"+(feil?" feil":""); s.innerHTML=t;}

function sok(q,beskrivelse){
  status("Søker …"); id("treff").innerHTML="";
  fetch("/api/sok?"+q).then(function(r){return r.json();}).then(function(d){
    if(d.feil){status(esc(d.feil),true);return;}
    if(!d.enheter.length){status("Ingen treff på "+esc(beskrivelse)+".");return;}
    status("Fant "+d.totalt+" — viser "+d.enheter.length+".");
    sisteTreff=d.enheter; tegnTreff();
  }).catch(function(e){status("Feil: "+esc(e.message),true);});
}

function tegnTreff(){
  var ut=id("treff"); ut.innerHTML="";
  sisteTreff.forEach(function(u,i){
    var k=document.createElement("div"); k.className="kort"; k.dataset.i=i;
    var d=[]; if(u.bransje)d.push(esc(u.bransje));
    if(u.form)d.push(esc(u.form));
    if(u.ansatte!=null)d.push(u.ansatte+" ansatte");

    var h="<h3>"+esc(u.navn)+"</h3>"+
      '<p class="meta">'+d.join('<span class="sk">·</span>')+"</p>";
    if(u.adresse)h+='<p class="meta">'+esc(u.adresse)+"</p>";
    var kontakt=[]; if(u.telefon)kontakt.push(esc(u.telefon));
    if(u.epost)kontakt.push(esc(u.epost));
    if(kontakt.length)h+='<p class="meta">'+kontakt.join('<span class="sk">·</span>')+"</p>";
    h+='<p class="meta nr">Org.nr '+esc(u.orgnr)+"</p>";

    if(!u.nettside)h+='<span class="merkelapp nei">Ingen nettside</span>';
    if(u.nettside&&u.gjettet==="usikkert")
      h+='<span class="merkelapp gr\u00e5">Gjettet adresse — sjekk</span>';
    if(!u.telefon)h+='<span class="merkelapp nei">Mangler telefon</span>';
    if(u.konkurs)h+='<span class="merkelapp grå">Konkurs</span>';
    if(u.avvikling)h+='<span class="merkelapp grå">Under avvikling</span>';

    h+='<div class="handling">';
    if(u.nettside){
      h+='<button class="knapp-liten primar" data-analyser="'+i+'">Sjekk nettsiden</button>';
      h+='<a class="knapp-liten" href="'+esc(u.nettside)+'" target="_blank" rel="noopener">Åpne</a>';
    } else {
      h+='<button class="knapp-liten primar" data-gjett="'+i+'">Finn nettsiden</button>';
    }
    var alt=valgt.some(function(v){return v.orgnr===u.orgnr;});
    h+='<button class="knapp-liten" data-legg="'+i+'"'+(alt?" disabled":"")+">"+
       (alt?"Lagt til":"Legg til")+"</button>";
    if(PITCHKODE)h+='<button class="knapp-liten" data-pitch="'+i+'">Lag pitch</button>';
    h+="</div>";
    h+='<div class="manuell"><input type="text" data-url="'+i+'" placeholder="'+
       (u.nettside?"bytt til en annen adresse":"lim inn adressen selv")+
       '" autocomplete="off">'+
       '<button class="knapp-liten" data-manuell="'+i+'">Bruk</button></div>';
    h+='<div class="analyse-plass"></div><div class="pitch-plass"></div>';

    k.innerHTML=h; ut.appendChild(k);
  });
}

id("treff").addEventListener("click",function(ev){
  var b=ev.target.closest("button"); if(!b)return;

  if(b.dataset.legg!=null){
    var u=sisteTreff[+b.dataset.legg];
    valgt.push({navn:u.navn,orgnr:u.orgnr,kategori:u.bransje,telefon:u.telefon,
      epost:u.epost,adresse:u.adresse,nettside:u.nettside,
      salgsvinkel:u.salgsvinkel||(u.nettside?"":"Ingen nettside registrert"),
      status:"Ikke kontaktet"});
    b.textContent="Lagt til"; b.disabled=true; tegnLista();
  }

  if(b.dataset.analyser!=null){
    var i=+b.dataset.analyser, u2=sisteTreff[i];
    var plass=b.closest(".kort").querySelector(".analyse-plass");
    b.disabled=true; b.textContent="Sjekker …";
    plass.innerHTML='<p class="meta" style="margin-top:.8rem">Henter nettsiden …</p>';
    fetch("/api/analyse?url="+encodeURIComponent(u2.nettside))
      .then(function(r){return r.json();})
      .then(function(a){
        b.disabled=false; b.textContent="Sjekk på nytt";
        if(a.feil){
          plass.innerHTML='<div class="analyse"><p class="meta" style="color:var(--rod)">'+
            esc(a.feil)+"</p></div>"; return;}
        u2.salgsvinkel=a.salgsvinkel;
        u2.analyse=a;
        plass.innerHTML=tegnAnalyse(a);
      })
      .catch(function(e){
        b.disabled=false; b.textContent="Prøv igjen";
        plass.innerHTML='<div class="analyse"><p class="meta">'+esc(e.message)+"</p></div>";
      });
  }

  if(b.dataset.pitch!=null){
    var pi=+b.dataset.pitch, pu=sisteTreff[pi];
    var pplass=b.closest(".kort").querySelector(".pitch-plass");
    b.disabled=true; b.textContent="Skriver …";
    pplass.innerHTML='<p class="meta" style="margin-top:.8rem">Forbereder samtalen …</p>';
    fetch("/api/pitch?k="+encodeURIComponent(PITCHKODE),{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({bedrift:pu,analyse:pu.analyse||null,
                           profil:(id("profil")||{}).value||""})
    }).then(function(r){return r.json();}).then(function(p){
      b.disabled=false; b.textContent="Lag pitch på nytt";
      if(p.feil){
        pplass.innerHTML='<div class="pitch"><p class="meta" style="color:var(--rod)">'+
          esc(p.feil)+(p.detalj?" — "+esc(p.detalj):"")+"</p></div>"; return;}
      pplass.innerHTML=tegnPitch(p);
    }).catch(function(e){
      b.disabled=false; b.textContent="Prøv igjen";
      pplass.innerHTML='<div class="pitch"><p class="meta">'+esc(e.message)+"</p></div>";
    });
  }

  if(b.dataset.gjett!=null){
    var gi=+b.dataset.gjett, gu=sisteTreff[gi];
    var gplass=b.closest(".kort").querySelector(".analyse-plass");
    b.disabled=true; b.textContent="Leter …";
    gplass.innerHTML='<p class="meta" style="margin-top:.8rem">Prøver vanlige adresser …</p>';
    fetch("/api/gjett?navn="+encodeURIComponent(gu.navn))
      .then(function(r){return r.json();})
      .then(function(g){
        if(!g.funnet){
          b.disabled=false; b.textContent="Fant ingen";
          gplass.innerHTML='<p class="meta" style="margin-top:.8rem">'+
            "Ingen av de vanlige adressene svarte. Lim inn adressen under hvis du vet den."+
            "</p>"; return;
        }
        gu.nettside=g.funnet;
        gu.gjettet=g.sikker?"":"usikkert";
        tegnTreff();
      })
      .catch(function(e){
        b.disabled=false; b.textContent="Prøv igjen";
        gplass.innerHTML='<p class="meta">'+esc(e.message)+"</p>";
      });
  }

  if(b.dataset.manuell!=null){
    var mi=+b.dataset.manuell;
    var felt=b.closest(".kort").querySelector('input[data-url="'+mi+'"]');
    var v=((felt&&felt.value)||"").trim();
    if(!v)return;
    if(!/^https?:\/\//i.test(v))v="https://"+v;
    sisteTreff[mi].nettside=v;
    sisteTreff[mi].gjettet="";
    sisteTreff[mi].analyse=null;
    tegnTreff();
    /* Sjekk den med det samme */
    var nyKnapp=id("treff").children[mi];
    if(nyKnapp){
      nyKnapp=nyKnapp.querySelector('[data-analyser="'+mi+'"]');
      if(nyKnapp)nyKnapp.click();
    }
  }
});

function kr(n){return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g," ")+" kr";}

function tegnPitch(p){
  var s=p.samtale||{}, t=p.tiltak||{alle:[],pakker:[],sum:0,timer:0};
  var h='<div class="pitch">';

  if(s.apning){
    h+="<h4>Slik åpner du</h4>";
    h+='<p class="sitat">'+esc(s.apning)+"</p>";
  }

  if(s.sporsmal&&s.sporsmal.length){
    h+="<h4>Spør om dette — ikke pitch før du har svar</h4><ul>";
    s.sporsmal.forEach(function(q){h+="<li>"+esc(q)+"</li>";});
    h+="</ul>";
  }

  if(s.innvendinger&&s.innvendinger.length){
    h+="<h4>Når de sier nei</h4>";
    s.innvendinger.forEach(function(i){
      h+='<div class="innv"><b>«'+esc(i.de_sier)+'»</b>'+esc(i.du_svarer)+"</div>";
    });
  }

  if(t.alle&&t.alle.length){
    h+="<h4>Tiltak og pris</h4><table class='tiltak'>";
    t.alle.forEach(function(x){
      h+="<tr><td>"+esc(x.navn)+"<small>"+esc(x.hvorfor)+"</small></td>"+
         "<td class='pris'>"+kr(x.pris)+"</td></tr>";
    });
    h+="<tr class='sum'><td>Sum · ca "+t.timer+" timer</td>"+
       "<td class='pris'>"+kr(t.sum)+"</td></tr></table>";
    if(t.manedlig)h+='<p class="meta" style="margin-top:.5rem">Pluss '+
      kr(t.manedlig)+" per måned i drift.</p>";

    (t.pakker||[]).forEach(function(pk){
      if(!pk.tiltak||!pk.tiltak.length)return;
      h+='<div class="pakke"><span>'+esc(pk.navn)+" — "+
         pk.tiltak.length+" tiltak</span><b>"+kr(pk.pris)+"</b></div>";
    });
  }

  if(s.epost_tekst){
    h+="<h4>E-postutkast"+(s.epost_emne?" — "+esc(s.epost_emne):"")+"</h4>";
    h+='<pre class="epost">'+esc(s.epost_tekst)+"</pre>";
    h+='<button class="knapp-liten" data-kopier="1">Kopier e-post</button>';
  }

  if(s.neste_steg){
    h+="<h4>Avslutt med</h4>";
    h+='<p class="sitat">'+esc(s.neste_steg)+"</p>";
  }

  return h+"</div>";
}

function tegnAnalyse(a){
  var omrader={};
  a.funn.forEach(function(f){(omrader[f.omrade]=omrader[f.omrade]||[]).push(f);});
  var h='<div class="analyse"><div class="poeng"><b>'+a.poeng+
    '</b><span>av 100 · '+a.antallMangler+" av "+a.antallFunn+" mangler</span></div>";
  Object.keys(omrader).forEach(function(o){
    h+='<p class="omrade">'+esc(o)+"</p>";
    omrader[o].forEach(function(f){
      h+='<div class="sjekk"><span class="ikon '+(f.ok?"ja":"nei")+'">'+
        (f.ok?"✓":"✕")+"</span><span>"+esc(f.navn)+
        (f.notat?' <span class="notat">— '+esc(f.notat)+"</span>":"")+"</span></div>";
    });
  });
  h+='<p class="vinkel">'+esc(a.salgsvinkel)+"</p></div>";
  return h;
}

function tegnLista(){
  id("antall").textContent=valgt.length;
  id("tomtekst").style.display=valgt.length?"none":"block";
  id("lastned").disabled=!valgt.length;
  var ol=id("valgt"); ol.innerHTML="";
  valgt.forEach(function(v,i){
    var li=document.createElement("li");
    var n=document.createElement("span"); n.className="n";
    n.textContent=v.navn+(v.telefon?"  ·  "+v.telefon:"");
    li.appendChild(n);
    var f=document.createElement("button"); f.textContent="×";
    f.setAttribute("aria-label","Fjern "+v.navn);
    f.onclick=function(){valgt.splice(i,1);tegnLista();tegnTreff();};
    li.appendChild(f); ol.appendChild(li);
  });
}

function felt(s){s=String(s==null?"":s);
  return /[",\\n;]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}

id("lastned").onclick=function(){
  var f=["navn","kategori","telefon","epost","adresse","nettside","salgsvinkel","status"];
  var l=[f.join(",")];
  valgt.forEach(function(v){l.push(f.map(function(x){return felt(v[x]);}).join(","));});
  var b=new Blob(["\\ufeff"+l.join("\\n")],{type:"text/csv;charset=utf-8"});
  var a=document.createElement("a"); a.href=URL.createObjectURL(b);
  a.download="bedrifter.csv"; document.body.appendChild(a); a.click();
  document.body.removeChild(a);
};

id("tomknapp").onclick=function(){valgt=[];tegnLista();tegnTreff();};

id("s1").onclick=function(){
  var q=id("navn").value.trim(); if(!q){status("Skriv inn et navn.");return;}
  var t=q.replace(/\\s/g,"");
  if(/^\\d{9}$/.test(t))sok("orgnr="+t,"org.nr "+t);
  else sok("navn="+encodeURIComponent(q),q);
};
id("navn").onkeydown=function(e){if(e.key==="Enter"){e.preventDefault();id("s1").click();}};

id("s2").onclick=function(){
  var k=id("bransje"), m=id("kommune");
  if(!k.value){status("Velg en bransje først.");return;}
  var q="naeringskode="+encodeURIComponent(k.value);
  if(m.value)q+="&kommunenummer="+m.value;
  sok(q,k.options[k.selectedIndex].text+" i "+m.options[m.selectedIndex].text);
};

tegnLista();

id("bransje").addEventListener("change",function(){id("s2").click();});
id("kommune").addEventListener("change",function(){id("s2").click();});

/* Henter profilene som ligger lagret, hvis vi har kode */
if(PITCHKODE){
  fetch("/api/profil?k="+encodeURIComponent(PITCHKODE))
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.profiler||!d.profiler.length)return;
      var s=id("profil");
      var o=document.createElement("option");
      o.value=""; o.textContent="Meg selv (nettsider)";
      s.appendChild(o);
      d.profiler.forEach(function(p){
        var x=document.createElement("option");
        x.value=p; x.textContent=p; s.appendChild(x);
      });
      id("profilrad").style.display="block";
    }).catch(function(){});
}

/* Kopier e-post */
document.addEventListener("click",function(ev){
  var b=ev.target.closest("[data-kopier]"); if(!b)return;
  var pre=b.parentNode.querySelector("pre.epost"); if(!pre)return;
  navigator.clipboard.writeText(pre.textContent).then(function(){
    var f=b.textContent; b.textContent="Kopiert";
    setTimeout(function(){b.textContent=f;},1500);
  }).catch(function(){b.textContent="Marker og kopier selv";});
});
})();
</script>
</body>
</html>`;

/* -------------------------------------------------------------- oppsett */

const OPPSETT = `<!DOCTYPE html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Selgerprofiler</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@800&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--blekk:#17242C;--myk:#4A5A63;--papir:#E6E9E3;--dyp:#D8DDD4;
  --linje:#B9C0B6;--flate:#F5F7F3;--rod:#B3402E;--gronn:#2F6D5B}
@media(prefers-color-scheme:dark){:root{--blekk:#E4E8E2;--myk:#98A6A0;
  --papir:#121A1F;--dyp:#1C262C;--linje:#33424A;--flate:#18232A;
  --rod:#E0715C;--gronn:#6FBFA3}}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--papir);color:var(--blekk);
  font:400 16px/1.55 "IBM Plex Sans",system-ui,sans-serif;padding:0 0 4rem}
.ramme{max-width:760px;margin:0 auto;padding:0 clamp(1rem,4vw,2rem)}
header{padding:clamp(1.8rem,6vw,3rem) 0 1.2rem}
.merke{font:600 11px/1 "IBM Plex Mono",monospace;letter-spacing:.15em;
  text-transform:uppercase;color:var(--myk);margin-bottom:.9rem}
h1{font-family:Archivo,sans-serif;font-weight:800;
  font-size:clamp(1.8rem,6vw,2.6rem);line-height:1;letter-spacing:-.03em}
.under{margin-top:.7rem;color:var(--myk);font-size:.95rem;max-width:52ch}
label{display:block;font:600 10px/1 "IBM Plex Mono",monospace;
  letter-spacing:.1em;text-transform:uppercase;color:var(--myk);
  margin:1.3rem 0 .45rem}
input,textarea,select{width:100%;padding:.8rem .85rem;border-radius:0;
  font:400 .95rem/1.5 "IBM Plex Sans",sans-serif;background:var(--flate);
  border:1px solid var(--linje);color:var(--blekk);-webkit-appearance:none}
textarea{min-height:340px;font-family:"IBM Plex Mono",monospace;font-size:.82rem}
input:focus,textarea:focus,select:focus{outline:2px solid var(--blekk);outline-offset:-1px}
.knapper{display:flex;gap:.7rem;flex-wrap:wrap;margin-top:1.2rem}
button{border:none;cursor:pointer;font:600 .92rem/1 "IBM Plex Sans",sans-serif;
  padding:.9rem 1.5rem}
button.lagre{background:var(--gronn);color:var(--papir)}
button.hent{background:none;border:1px solid var(--linje);color:var(--blekk)}
button.slett{background:none;border:1px solid var(--rod);color:var(--rod)}
button:focus-visible{outline:2px solid var(--blekk);outline-offset:3px}
.melding{margin-top:1rem;font-size:.9rem;padding:.8rem .9rem;background:var(--flate);
  border-left:3px solid var(--gronn)}
.melding.feil{border-left-color:var(--rod);color:var(--rod)}
.liste{margin-top:2rem;padding-top:1.2rem;border-top:1px solid var(--linje)}
.liste h2{font:600 11px/1 "IBM Plex Mono",monospace;letter-spacing:.13em;
  text-transform:uppercase;color:var(--myk);margin-bottom:.8rem}
.liste button{background:none;border:1px solid var(--linje);color:var(--blekk);
  padding:.5rem .8rem;font-size:.85rem;margin:0 .4rem .4rem 0}
details{margin-top:1.5rem;font-size:.9rem;color:var(--myk)}
summary{cursor:pointer;font-weight:500;color:var(--blekk)}
pre{background:var(--flate);border:1px solid var(--linje);padding:.9rem;
  overflow-x:auto;font-size:.78rem;line-height:1.5;margin-top:.7rem}
</style>
</head>
<body><div class="ramme">
<header>
  <p class="merke">Oppsett</p>
  <h1>Selgerprofiler</h1>
  <p class="under">Lim inn profilen slik den er fylt ut. Verktøyet skriver
  da samtalekort og e-poster i denne selgerens stemme.</p>
</header>

<label for="id">Kort navn på profilen</label>
<input type="text" id="id" placeholder="forsikring-namdalen" autocomplete="off">

<label for="data">Profil som JSON</label>
<textarea id="data" spellcheck="false"></textarea>

<div class="knapper">
  <button class="lagre" id="lagre">Lagre</button>
  <button class="hent" id="hent">Hent</button>
  <button class="hent" id="mal">Sett inn mal</button>
  <button class="slett" id="slett">Slett</button>
</div>

<div id="melding"></div>

<div class="liste">
  <h2>Lagrede profiler</h2>
  <div id="profiler"></div>
</div>

<details>
  <summary>Hvilke felter finnes?</summary>
  <pre>tone       nokternt | varm | direkte | faglig
booking.onsker  telefon | mote | befaring | demo | tilbud
unngaa_ord      ord som aldri skal brukes
egne_vendinger  noe selgeren alltid sier
reise.besoker   true hvis han reiser rundt
reise.uke       "uke 12" - nevnes tidlig i e-posten
signatur        brukes ordrett nederst i e-posten</pre>
</details>

</div>
<script>
(function(){
var K=new URLSearchParams(location.search).get("k")||"";
function id(x){return document.getElementById(x);}
function si(t,feil){var m=id("melding");
  m.className="melding"+(feil?" feil":"");m.textContent=t;}

var MAL={
  selger:{navn:"",rolle:"",firma:"",telefon:"",epost:"",omrade:""},
  tilbyr:"",
  kunder:{hvem:"",signaler:[],ikke_aktuelt:""},
  produkter:[{navn:"",pris:"",beskrivelse:""}],
  tone:"nokternt",
  unngaa_ord:[],
  egne_vendinger:"",
  booking:{onsker:"telefon",lenke:""},
  reise:{besoker:false,uke:"",per_dag:5},
  signatur:""
};

id("mal").onclick=function(){
  id("data").value=JSON.stringify(MAL,null,2);
  si("Mal satt inn. Fyll ut og lagre.");
};

id("lagre").onclick=function(){
  var i=id("id").value.trim();
  if(!i){si("Gi profilen et kort navn.",true);return;}
  var d;
  try{d=JSON.parse(id("data").value);}
  catch(e){si("JSON-feil: "+e.message,true);return;}
  fetch("/api/profil?k="+encodeURIComponent(K)+"&id="+encodeURIComponent(i),
    {method:"PUT",headers:{"content-type":"application/json"},
     body:JSON.stringify(d)})
    .then(function(r){return r.json();})
    .then(function(s){
      if(s.feil){si(s.feil,true);return;}
      si("Lagret som «"+s.id+"».");last();})
    .catch(function(e){si(e.message,true);});
};

id("hent").onclick=function(){
  var i=id("id").value.trim();
  if(!i){si("Skriv inn navnet først.",true);return;}
  fetch("/api/profil?k="+encodeURIComponent(K)+"&id="+encodeURIComponent(i))
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.feil){si(d.feil,true);return;}
      id("data").value=JSON.stringify(d,null,2);si("Hentet.");})
    .catch(function(e){si(e.message,true);});
};

id("slett").onclick=function(){
  var i=id("id").value.trim();
  if(!i)return;
  if(!confirm("Slette profilen «"+i+"»?"))return;
  fetch("/api/profil?k="+encodeURIComponent(K)+"&id="+encodeURIComponent(i),
    {method:"DELETE"}).then(function(r){return r.json();})
    .then(function(){si("Slettet.");id("data").value="";last();})
    .catch(function(e){si(e.message,true);});
};

function last(){
  fetch("/api/profil?k="+encodeURIComponent(K))
    .then(function(r){return r.json();})
    .then(function(d){
      var u=id("profiler");u.innerHTML="";
      if(d.feil){u.textContent=d.feil;return;}
      if(!d.profiler||!d.profiler.length){u.textContent="Ingen ennå.";return;}
      d.profiler.forEach(function(p){
        var b=document.createElement("button");
        b.textContent=p;
        b.onclick=function(){id("id").value=p;id("hent").click();};
        u.appendChild(b);});
    }).catch(function(){});
}
last();
})();
</script>
</body>
</html>`;

/* ------------------------------------------------------------------ møte */

const MOTE = `<!DOCTYPE html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Møte</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@800&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--blekk:#17242C;--myk:#4A5A63;--papir:#E6E9E3;--dyp:#D8DDD4;
  --linje:#B9C0B6;--flate:#F5F7F3;--rod:#B3402E;--gronn:#2F6D5B}
@media(prefers-color-scheme:dark){:root{--blekk:#E4E8E2;--myk:#98A6A0;
  --papir:#121A1F;--dyp:#1C262C;--linje:#33424A;--flate:#18232A;
  --rod:#E0715C;--gronn:#6FBFA3}}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--papir);color:var(--blekk);
  font:400 16px/1.55 "IBM Plex Sans",system-ui,sans-serif;padding-bottom:4rem}
.ramme{max-width:1180px;margin:0 auto;padding:0 clamp(1rem,4vw,2rem)}
header{padding:clamp(1.6rem,5vw,2.8rem) 0 1.4rem;border-bottom:1px solid var(--linje)}
.merke{font:600 11px/1 "IBM Plex Mono",monospace;letter-spacing:.15em;
  text-transform:uppercase;color:var(--myk);margin-bottom:.8rem}
h1{font-family:Archivo,sans-serif;font-weight:800;
  font-size:clamp(1.8rem,5.5vw,2.8rem);line-height:1;letter-spacing:-.03em}
.under{margin-top:.6rem;color:var(--myk);font-size:.95rem;max-width:60ch}

.oppsett{display:grid;grid-template-columns:minmax(0,1fr);gap:2rem;margin-top:1.6rem}
@media(min-width:980px){.oppsett{grid-template-columns:minmax(0,1fr) minmax(0,1fr);
  align-items:start}.hoyre{position:sticky;top:1rem}}

section{margin-bottom:1.8rem}
h2{font:600 11px/1 "IBM Plex Mono",monospace;letter-spacing:.13em;
  text-transform:uppercase;color:var(--myk);margin-bottom:.9rem;
  padding-bottom:.55rem;border-bottom:1px solid var(--linje)}
label.felt{display:block;font-size:.88rem;font-weight:500;margin:.9rem 0 .35rem}
input[type=text],input[type=number],textarea,select{width:100%;
  padding:.7rem .8rem;border-radius:0;font:400 .95rem/1.45 "IBM Plex Sans",sans-serif;
  background:var(--flate);border:1px solid var(--linje);color:var(--blekk);
  -webkit-appearance:none;appearance:none}
textarea{min-height:78px;resize:vertical}
input:focus,textarea:focus,select:focus{outline:2px solid var(--blekk);outline-offset:-1px}
.to{display:grid;grid-template-columns:1fr 1fr;gap:.7rem}
.to label.felt{margin-top:.6rem}

.valg{display:flex;flex-wrap:wrap;gap:.45rem}
.valg label{display:inline-flex;align-items:center;gap:.45rem;cursor:pointer;
  font-size:.87rem;padding:.5rem .7rem;border:1px solid var(--linje);
  background:var(--flate);user-select:none}
.valg input{accent-color:var(--gronn);width:15px;height:15px;margin:0}
.valg label:has(input:checked){border-color:var(--gronn);
  box-shadow:inset 3px 0 0 var(--gronn)}
.hjelp{font-size:.8rem;color:var(--myk);margin-top:.5rem;line-height:1.45}

.kort{background:var(--flate);border:1px solid var(--linje);padding:1.2rem 1.25rem;
  margin-bottom:1.2rem}
.kort h3{font:600 11px/1 "IBM Plex Mono",monospace;letter-spacing:.12em;
  text-transform:uppercase;color:var(--myk);margin-bottom:.8rem}
.regel{font-size:.95rem;line-height:1.55}
.regel ol{padding-left:1.3rem;margin-top:.5rem}
.regel li{margin:.25rem 0}
.tid{margin-top:1rem;padding-top:.9rem;border-top:1px solid var(--linje)}
.tid b{font-family:Archivo,sans-serif;font-weight:800;font-size:2rem;
  letter-spacing:-.03em;color:var(--gronn);display:block;line-height:1}
.tid span{font-size:.87rem;color:var(--myk)}
.tom{color:var(--myk);font-style:italic;font-size:.9rem}

.knapper{display:flex;flex-wrap:wrap;gap:.55rem;margin-top:1rem}
button{border:none;cursor:pointer;font:600 .87rem/1 "IBM Plex Sans",sans-serif;
  padding:.8rem 1.1rem}
button.fylt{background:var(--blekk);color:var(--papir)}
button.fylt:hover{background:var(--gronn)}
button.linje{background:none;border:1px solid var(--linje);color:var(--blekk)}
button.fare{background:none;border:1px solid var(--rod);color:var(--rod)}
button:focus-visible{outline:2px solid var(--blekk);outline-offset:3px}
button:disabled{opacity:.5;cursor:default}

.sokrad{display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-bottom:.6rem}
.status{font-size:.88rem;color:var(--myk);margin:.8rem 0}
.status.feil{color:var(--rod)}
.lead{padding:.75rem 0;border-bottom:1px solid var(--linje)}
.lead:last-child{border-bottom:none}
.lead-topp{display:flex;justify-content:space-between;gap:.8rem;align-items:baseline}
.lead b{font-weight:600;font-size:.94rem;word-break:break-word}
.poeng{font:600 .8rem/1 "IBM Plex Mono",monospace;color:var(--gronn);white-space:nowrap}
.lead .meta{font-size:.82rem;color:var(--myk);margin-top:.2rem}
.grunn{display:inline-block;font:600 10px/1 "IBM Plex Mono",monospace;
  letter-spacing:.05em;text-transform:uppercase;padding:.28rem .45rem;
  margin:.4rem .3rem 0 0;background:var(--dyp);color:var(--blekk)}
.lagret{font-size:.78rem;color:var(--myk);margin-top:.6rem}
.merknad{font-size:.8rem;color:var(--myk);margin-top:1rem;line-height:1.5}
</style>
</head>
<body>
<div class="ramme">

<header>
  <p class="merke">Møtenotat · salgsverktøy</p>
  <h1>Hva trenger du for å selge mer?</h1>
  <p class="under">Fyll ut underveis. Høyre side viser hvordan verktøyet
  vil prioritere kundene dine — og søker dem opp med en gang.</p>
</header>

<div class="oppsett">

<div class="venstre">

<section>
  <h2>Deg</h2>
  <div class="to">
    <div><label class="felt" for="navn">Navn</label><input type="text" id="navn"></div>
    <div><label class="felt" for="firma">Firma</label><input type="text" id="firma"></div>
    <div><label class="felt" for="telefon">Telefon</label><input type="text" id="telefon"></div>
    <div><label class="felt" for="epost">E-post</label><input type="text" id="epost"></div>
  </div>
  <label class="felt" for="omrade">Området du jobber i</label>
  <input type="text" id="omrade" placeholder="Steinkjer, Inderøy, Snåsa …">
</section>

<section>
  <h2>Hva du selger</h2>
  <div class="valg" id="produkter"></div>
  <label class="felt" for="annet">Annet</label>
  <input type="text" id="annet" placeholder="skill med komma">
</section>

<section>
  <h2>Hvem som er verdt å ringe</h2>
  <div class="valg" id="signaler"></div>
  <p class="hjelp">Det du krysser av her styrer rekkefølgen til høyre.</p>
  <label class="felt" for="ikke">Hvem er ikke aktuelle?</label>
  <input type="text" id="ikke" placeholder="for eksempel enkeltpersonforetak uten ansatte">
</section>

<section>
  <h2>Fra praten</h2>
  <label class="felt" for="finner">Hvordan finner du kunder i dag?</label>
  <textarea id="finner"></textarea>
  <label class="felt" for="timer">Timer i uka på å finne og forberede kunder</label>
  <input type="number" id="timer" min="0" max="40" inputmode="numeric" placeholder="for eksempel 8">
  <label class="felt" for="utloser">Hva får en bedrift til å kjøpe?</label>
  <textarea id="utloser" placeholder="tilsyn, ny ansatt, brann i nabobygget, krav fra forsikring …"></textarea>
  <label class="felt" for="nei">Hva sier de når de sier nei?</label>
  <textarea id="nei"></textarea>
</section>

<section>
  <h2>Slik vil du høres ut</h2>
  <div class="valg" id="tone"></div>
  <label class="felt">Hva skal samtalen ende med?</label>
  <div class="valg" id="mal"></div>
  <label class="felt">Reiser du rundt?</label>
  <div class="valg">
    <label><input type="checkbox" id="reiser"> Besøker ett område om gangen</label>
  </div>
</section>

<section>
  <h2>Avtalt</h2>
  <textarea id="avtalt" placeholder="neste steg, hvem gjør hva, når"></textarea>
</section>

<p class="lagret" id="lagret">Lagres automatisk på denne enheten.</p>

</div>

<div class="hoyre">

<div class="kort">
  <h3>Slik prioriterer verktøyet</h3>
  <div class="regel" id="regel"></div>
  <div class="tid" id="tid" style="display:none"></div>
</div>

<div class="kort">
  <h3>Finn kundene nå</h3>
  <div class="sokrad">
    <select id="bransje" aria-label="Bransje"></select>
    <select id="kommune" aria-label="Kommune"></select>
  </div>
  <button class="fylt" id="sok">Søk i Brønnøysund</button>
  <div class="status" id="status"></div>
  <div id="treff"></div>
</div>

<div class="kort">
  <h3>Ta med videre</h3>
  <div class="knapper">
    <button class="fylt" id="kopierOpps">Kopier oppsummering</button>
    <button class="linje" id="kopierProfil">Kopier profil</button>
    <button class="fare" id="tom">Tøm</button>
  </div>
  <p class="merknad">Oppsummeringen kan sendes ham etter møtet.
  Profilen limes inn på /oppsett.</p>
  <p class="merknad">Lovhenvisningene er et utgangspunkt. La selgeren
  bekrefte — han kan faget bedre.</p>
</div>

</div>
</div>
</div>

<script>
(function(){
"use strict";
var NL=String.fromCharCode(10);
function id(x){return document.getElementById(x);}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;")
  .replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}

var PRODUKTER=[
  ["brann","Brannslukkere og kontroll"],
  ["leder","HMS-kurs for daglig leder"],
  ["verneombud","Verneombudskurs, 40 timer"],
  ["forstehjelp","Førstehjelpskurs"],
  ["brannvern","Brannvernkurs"],
  ["varme","Varme arbeider"],
  ["internkontroll","Internkontroll og HMS-system"],
  ["bht","Bedriftshelsetjeneste"]
];

/* Signaler. Bransjegruppene er de to foerste sifrene i naeringskoden. */
var SIGNALER=[
  ["ny","Nyregistrert siste år",{type:"ny",vekt:3,
    grunn:"Nyregistrert — starter fra null"}],
  ["a50","50 eller flere ansatte",{type:"ansatte",min:50,vekt:3,
    grunn:"50+ ansatte — krav om AMU"}],
  ["a10","10 eller flere ansatte",{type:"ansatte",min:10,vekt:2,
    grunn:"10+ ansatte — verneombud"}],
  ["a5","5 eller flere ansatte",{type:"ansatte",min:5,vekt:1,
    grunn:"5+ ansatte"}],
  ["bygg","Bygg og anlegg",{type:"bransje",pre:["41","42","43"],vekt:2,
    grunn:"Bygg og anlegg"}],
  ["industri","Industri og verksted",{type:"bransje",
    pre:["10","11","13","14","15","16","17","18","20","22","23","24","25",
         "26","27","28","29","30","31","32","33","95"],vekt:2,
    grunn:"Industri og verksted"}],
  ["mat","Restaurant og servering",{type:"bransje",pre:["55","56"],vekt:2,
    grunn:"Servering — brannfare på kjøkken"}],
  ["transport","Transport",{type:"bransje",pre:["49","50","51","52","53"],vekt:2,
    grunn:"Transport"}],
  ["landbruk","Landbruk",{type:"bransje",pre:["01","02","03"],vekt:2,
    grunn:"Landbruk"}],
  ["helse","Helse og omsorg",{type:"bransje",pre:["86","87","88"],vekt:2,
    grunn:"Helse og omsorg"}],
  ["renhold","Renhold og service",{type:"bransje",pre:["81"],vekt:2,
    grunn:"Renhold"}]
];

var TONER=[["nokternt","Nøktern"],["varm","Varm"],["direkte","Direkte"],["faglig","Faglig"]];
var MAL=[["telefon","Ny telefon"],["mote","Møte"],["befaring","Befaring"],
         ["demo","Demonstrasjon"],["tilbud","Sende tilbud"]];

var KOMMUNER=[["5006","Steinkjer"],["5053","Inderøy"],["5041","Snåsa"],
  ["5037","Levanger"],["5038","Verdal"],["5007","Namsos"],["5047","Overhalla"],
  ["5045","Grong"],["5035","Stjørdal"],["5001","Trondheim"],["5054","Indre Fosen"],
  ["5060","Nærøysund"],["","Hele landet"]];

function lagValg(boks,liste,type,navn){
  liste.forEach(function(v){
    var l=document.createElement("label");
    var i=document.createElement("input");
    i.type=type; i.value=v[0]; i.name=navn; i.dataset.gruppe=navn;
    l.appendChild(i); l.appendChild(document.createTextNode(" "+v[1]));
    id(boks).appendChild(l);
  });
}
lagValg("produkter",PRODUKTER,"checkbox","produkter");
lagValg("signaler",SIGNALER,"checkbox","signaler");
lagValg("tone",TONER,"radio","tone");
lagValg("mal",MAL,"radio","mal");

function lastBransjer(sel,div,foretrukket){
  sel.innerHTML="";
  var v=document.createElement("option");v.value="";
  v.textContent="Henter bransjer fra SSB …";sel.appendChild(v);sel.disabled=true;
  fetch("/api/bransjer?div="+div).then(function(r){return r.json();}).then(function(d){
    sel.innerHTML="";
    if(d.feil||!d.grupper||!d.grupper.length){
      var f=document.createElement("option");f.value="";
      f.textContent="Fikk ikke hentet bransjer — last siden på nytt";
      sel.appendChild(f);sel.disabled=false;return;}
    var valgtOpt=null;
    d.grupper.forEach(function(g){
      var og=document.createElement("optgroup");og.label=g.navn;
      var alle=document.createElement("option");
      alle.value=g.koder.map(function(k){return k.kode;}).join(",");
      alle.textContent="Alle i "+g.navn.charAt(0).toLowerCase()+g.navn.slice(1);
      og.appendChild(alle);
      if(foretrukket===g.div)valgtOpt=alle;
      g.koder.forEach(function(k){
        var o=document.createElement("option");o.value=k.kode;o.textContent=k.navn;
        og.appendChild(o);
        if(!valgtOpt&&foretrukket&&foretrukket.length>2&&
           k.navn.toLowerCase().indexOf(foretrukket)>=0)valgtOpt=o;
      });
      sel.appendChild(og);
    });
    if(valgtOpt)valgtOpt.selected=true;
    sel.disabled=false;
  }).catch(function(){
    sel.innerHTML="";
    var f=document.createElement("option");f.value="";
    f.textContent="Fikk ikke kontakt med SSB";sel.appendChild(f);sel.disabled=false;
  });
}
lastBransjer(id("bransje"),
  "01,02,16,25,41,42,43,47,49,55,56,81,86,87,88,95","41");
KOMMUNER.forEach(function(k){var o=document.createElement("option");
  o.value=k[0];o.textContent=k[1];id("kommune").appendChild(o);});

var FELT=["navn","firma","telefon","epost","omrade","annet","ikke","finner",
          "timer","utloser","nei","avtalt"];

function avkrysset(gruppe){
  return Array.prototype.map.call(
    document.querySelectorAll('input[data-gruppe="'+gruppe+'"]:checked'),
    function(i){return i.value;});
}

function data(){
  var d={};
  FELT.forEach(function(f){d[f]=id(f).value;});
  d.produkter=avkrysset("produkter");
  d.signaler=avkrysset("signaler");
  d.tone=avkrysset("tone")[0]||"";
  d.mal=avkrysset("mal")[0]||"";
  d.reiser=id("reiser").checked;
  return d;
}

/* ---- lagring ---- */
var NOKKEL="mote-notater";
function lagre(){
  try{localStorage.setItem(NOKKEL,JSON.stringify(data()));
    id("lagret").textContent="Lagret "+new Date().toLocaleTimeString("nb-NO",
      {hour:"2-digit",minute:"2-digit"})+" på denne enheten.";}
  catch(e){id("lagret").textContent="Kunne ikke lagre — kopier før du lukker.";}
}
function hent(){
  var d=null;
  try{d=JSON.parse(localStorage.getItem(NOKKEL)||"null");}catch(e){}
  if(!d)return;
  FELT.forEach(function(f){if(d[f]!=null)id(f).value=d[f];});
  ["produkter","signaler","tone","mal"].forEach(function(g){
    var verdier=[].concat(d[g]||[]);
    Array.prototype.forEach.call(
      document.querySelectorAll('input[data-gruppe="'+g+'"]'),function(i){
        i.checked=verdier.indexOf(i.value)>=0;});
  });
  id("reiser").checked=!!d.reiser;
}

/* ---- prioritering ---- */
function aktiveSignaler(){
  var valgt=avkrysset("signaler");
  if(!valgt.length)valgt=SIGNALER.map(function(s){return s[0];});
  return SIGNALER.filter(function(s){return valgt.indexOf(s[0])>=0;});
}

function vurder(e){
  var poeng=0, grunner=[];
  var aktive=aktiveSignaler();
  var ansatte=e.ansatte||0;
  var kode=(e.naeringskode||"").replace(".","");
  var to=kode.slice(0,2);

  var aar=new Date(); aar.setFullYear(aar.getFullYear()-1);
  var ny=e.registrert && new Date(e.registrert)>aar;

  var besteAnsatte=null;
  aktive.forEach(function(s){
    var r=s[2];
    if(r.type==="ny"&&ny){poeng+=r.vekt;grunner.push(r.grunn);}
    if(r.type==="ansatte"&&ansatte>=r.min){
      if(!besteAnsatte||r.min>besteAnsatte.min)besteAnsatte=r;}
    if(r.type==="bransje"&&r.pre.indexOf(to)>=0){
      poeng+=r.vekt;grunner.push(r.grunn);}
  });
  if(besteAnsatte){poeng+=besteAnsatte.vekt;grunner.push(besteAnsatte.grunn);}
  return {poeng:poeng,grunner:grunner};
}

function tegnRegel(){
  var aktive=aktiveSignaler();
  var egne=avkrysset("signaler").length>0;
  var sortert=aktive.slice().sort(function(a,b){return b[2].vekt-a[2].vekt;});
  var h="<p>"+(egne?"Kundene rangeres etter det du krysset av:"
                 :"Ingenting krysset av ennå — viser standardoppsettet:")+"</p><ol>";
  sortert.forEach(function(s){
    h+="<li>"+esc(s[1])+' <span style="color:var(--myk)">· '+s[2].vekt+
       " poeng</span></li>";});
  h+="</ol>";
  var ikke=id("ikke").value.trim();
  if(ikke)h+='<p style="margin-top:.6rem;color:var(--myk)">Hopper over: '+esc(ikke)+"</p>";
  id("regel").innerHTML=h;

  var t=parseFloat(id("timer").value);
  var boks=id("tid");
  if(t>0){
    var dager=Math.round(t*0.6*45/7.5);
    boks.style.display="block";
    boks.innerHTML="<b>"+dager+" arbeidsdager</b><span>i året han kan bruke på salg "+
      "i stedet for leting — regnet med at 6 av 10 timer kan kuttes.</span>";
  } else boks.style.display="none";
}

/* ---- søk ---- */
var sisteTreff=[];
id("sok").onclick=function(){
  var b=id("bransje"), k=id("kommune");
  if(!b.value){id("status").className="status";
    id("status").textContent="Velg en bransje først.";return;}
  var q="naeringskode="+encodeURIComponent(b.value);
  if(k.value)q+="&kommunenummer="+k.value;
  id("status").className="status"; id("status").textContent="Søker …";
  id("treff").innerHTML=""; id("sok").disabled=true;

  fetch("/api/sok?"+q).then(function(r){return r.json();}).then(function(d){
    id("sok").disabled=false;
    if(d.feil){id("status").className="status feil";
      id("status").textContent=d.feil;return;}
    sisteTreff=(d.enheter||[]).filter(function(e){return !e.konkurs&&!e.avvikling;});
    tegnTreff(b.options[b.selectedIndex].text,k.options[k.selectedIndex].text);
  }).catch(function(e){
    id("sok").disabled=false;
    id("status").className="status feil";
    id("status").textContent="Fikk ikke kontakt: "+e.message;
  });
};

function tegnTreff(bransje,kommune){
  if(!sisteTreff.length){
    id("status").textContent="Ingen aktive foretak i "+kommune.toLowerCase()+".";
    id("treff").innerHTML=""; return;}
  var rangert=sisteTreff.map(function(e){
    var v=vurder(e); return {e:e,poeng:v.poeng,grunner:v.grunner};})
    .sort(function(a,b){return b.poeng-a.poeng||
      ((b.e.ansatte||0)-(a.e.ansatte||0));});
  var med=rangert.filter(function(r){return r.poeng>0;}).length;
  id("status").textContent=rangert.length+" foretak — "+bransje.toLowerCase()+
    " i "+kommune+". "+med+" treffer signalene dine.";
  var h="";
  rangert.slice(0,15).forEach(function(r){
    var e=r.e, meta=[];
    if(e.ansatte!=null)meta.push(e.ansatte+" ansatte");
    if(e.poststed)meta.push(e.poststed);
    if(e.telefon)meta.push(e.telefon);
    h+='<div class="lead"><div class="lead-topp"><b>'+esc(e.navn)+
       '</b><span class="poeng">'+r.poeng+" p</span></div>"+
       '<p class="meta">'+esc(meta.join(" · "))+"</p>";
    r.grunner.forEach(function(g){h+='<span class="grunn">'+esc(g)+"</span>";});
    h+="</div>";
  });
  if(rangert.length>15)h+='<p class="meta" style="margin-top:.7rem">+ '+
    (rangert.length-15)+" til</p>";
  id("treff").innerHTML=h;
}

/* ---- eksport ---- */
function tekstUt(){
  var d=data(), L=[];
  var prodNavn=PRODUKTER.filter(function(p){return d.produkter.indexOf(p[0])>=0;})
    .map(function(p){return p[1];});
  if(d.annet)prodNavn=prodNavn.concat(d.annet.split(",").map(function(s){return s.trim();})
    .filter(Boolean));
  var sigNavn=aktiveSignaler().slice().sort(function(a,b){return b[2].vekt-a[2].vekt;})
    .map(function(s){return s[1];});

  L.push("Oppsummering fra møtet"+(d.navn?" med "+d.navn:""));
  L.push("");
  if(prodNavn.length){L.push("Du selger:");
    prodNavn.forEach(function(p){L.push("  - "+p);});L.push("");}
  L.push("Verktøyet prioriterer kundene slik:");
  sigNavn.forEach(function(s,i){L.push("  "+(i+1)+". "+s);});
  if(d.ikke)L.push("  Hopper over: "+d.ikke);
  L.push("");
  if(d.omrade){L.push("Område: "+d.omrade);L.push("");}
  var t=parseFloat(d.timer);
  if(t>0){L.push("Du bruker rundt "+t+" timer i uka på å finne kunder. "+
    "Kutter vi 6 av 10, er det "+Math.round(t*0.6*45/7.5)+
    " arbeidsdager i året til salg i stedet.");L.push("");}
  if(d.utloser){L.push("Det som får kundene til å kjøpe:");L.push("  "+d.utloser);L.push("");}
  if(d.avtalt){L.push("Avtalt:");L.push("  "+d.avtalt);}
  return L.join(NL);
}

function profilUt(){
  var d=data();
  var prod=PRODUKTER.filter(function(p){return d.produkter.indexOf(p[0])>=0;})
    .map(function(p){return {navn:p[1],pris:"",beskrivelse:""};});
  if(d.annet)d.annet.split(",").map(function(s){return s.trim();}).filter(Boolean)
    .forEach(function(s){prod.push({navn:s,pris:"",beskrivelse:""});});
  return {
    selger:{navn:d.navn,rolle:"",firma:d.firma,telefon:d.telefon,
            epost:d.epost,omrade:d.omrade},
    tilbyr:"HMS for bedrifter: "+prod.map(function(p){return p.navn;}).join(", "),
    kunder:{hvem:"",
      signaler:aktiveSignaler().map(function(s){return s[1];}),
      ikke_aktuelt:d.ikke},
    produkter:prod,
    tone:d.tone||"nokternt",
    unngaa_ord:[],
    egne_vendinger:"",
    booking:{onsker:d.mal||"telefon",lenke:""},
    reise:{besoker:d.reiser,uke:"",per_dag:5},
    signatur:[d.navn,d.firma,d.telefon].filter(Boolean).join(NL),
    notater:{finner_kunder:d.finner,timer_per_uke:d.timer,
             utlosere:d.utloser,innvendinger:d.nei}
  };
}

function kopier(tekst,knapp){
  var f=knapp.textContent;
  navigator.clipboard.writeText(tekst).then(function(){
    knapp.textContent="Kopiert";
    setTimeout(function(){knapp.textContent=f;},1500);
  }).catch(function(){
    var t=document.createElement("textarea");
    t.value=tekst; t.style.minHeight="240px";
    knapp.parentNode.parentNode.appendChild(t); t.select();
    knapp.textContent="Marker og kopier";
  });
}
id("kopierOpps").onclick=function(){kopier(tekstUt(),this);};
id("kopierProfil").onclick=function(){kopier(JSON.stringify(profilUt(),null,2),this);};
id("tom").onclick=function(){
  if(!confirm("Tømme alle notater fra dette møtet?"))return;
  try{localStorage.removeItem(NOKKEL);}catch(e){}
  location.reload();
};

/* ---- koble alt sammen ---- */
var tidtaker;
document.addEventListener("input",function(ev){
  tegnRegel();
  var t=ev.target&&ev.target.id;
  if(t==="bransje"||t==="kommune")return;
  if(sisteTreff.length)tegnTreff(
    id("bransje").options[id("bransje").selectedIndex].text,
    id("kommune").options[id("kommune").selectedIndex].text);
  clearTimeout(tidtaker); tidtaker=setTimeout(lagre,500);
});

id("bransje").addEventListener("change",function(){id("sok").click();});
id("kommune").addEventListener("change",function(){id("sok").click();});

hent();
tegnRegel();
})();
</script>
</body>
</html>`;
