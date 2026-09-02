// Cloudflare Pages Function — kjører på /api/stats
// Åpne: https://hookfabrikken.../api/stats?token=DITT_APP_PASSWORD

export async function onRequestGet({ request, env }) {
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
