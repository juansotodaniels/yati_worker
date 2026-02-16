// src/index.js — YATI Worker (Cloudflare Workers)

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkForNewEvent(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ✅ Proxy estáticos (logo, mercalli, etc) hacia Railway
    if (url.pathname.startsWith("/static/")) {
      return proxyStaticFromRailway(request, env);
    }

    // Health
    if (url.pathname === "/") {
      return new Response("YATI Worker activo");
    }

    // ✅ PUBLIC (sirve HTML desde KV; self-healing si falta)
    if (url.pathname === "/public") {
      return servePublicHtml(env, ctx, { reason: "public-hit" });
    }

    // 🔒 TEST ALERT (protegido por ENABLE_TEST_ALERT)
    if (url.pathname === "/test-alert") {
      if (env.ENABLE_TEST_ALERT !== "1") {
        return new Response("Not Found", { status: 404 });
      }

      const pin = url.searchParams.get("pin") || "";

      const pinSecret = await getEnvValue(env, "TEST_ALERT_PIN");
      if (!pinSecret || pin !== pinSecret) {
        return new Response("Unauthorized", { status: 401 });
      }

      const defaultTo = await getEnvValue(env, "TEST_ALERT_TO");
      const to = url.searchParams.get("to") || defaultTo || "";
      const customMsg = url.searchParams.get("msg") || "";

      ctx.waitUntil(testManualAlert(env, to, customMsg));
      return new Response("OK - test alert triggered");
    }

    // TwiML para llamadas (si en el futuro usas ALERTA_CANAL=call)
    if (url.pathname === "/twiml") {
      const text = url.searchParams.get("text") || "Alerta sismica YATI.";
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-CL" voice="alice">${escapeXml(text)}</Say>
</Response>`;
      return new Response(xml, {
        headers: { "Content-Type": "text/xml; charset=utf-8" }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};

/* ===============================
   ✅ Proxy /static/* desde Railway
================================= */
async function proxyStaticFromRailway(request, env) {
  const RAILWAY_BASE_URL = env.RAILWAY_BASE_URL;
  if (!RAILWAY_BASE_URL) {
    return new Response("Missing RAILWAY_BASE_URL", { status: 500 });
  }

  const url = new URL(request.url);
  const target = `${RAILWAY_BASE_URL.replace(/\/$/, "")}${url.pathname}${url.search}`;

  // Traer el asset desde Railway
  const r = await fetch(target, {
    headers: {
      "User-Agent": "YATI-Worker/1.0"
    }
  });

  // Copiar headers (content-type, cache-control, etc.)
  const headers = new Headers(r.headers);

  // Cache razonable para imágenes estáticas
  // (si Railway ya manda cache-control, lo respetamos)
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(r.body, { status: r.status, headers });
}

function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function log(env, msg, extra) {
  const lvl = String(env.LOG_LEVEL || "info").toLowerCase();
  if (lvl === "silent") return;

  if (extra === undefined) {
    console.log(msg);
    return;
  }
  try {
    console.log(`${msg} ${JSON.stringify(extra)}`);
  } catch {
    console.log(`${msg} ${String(extra)}`);
  }
}

async function getEnvValue(env, name) {
  const v = env?.[name];
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.get === "function") {
    try {
      const got = await v.get();
      return typeof got === "string" ? got : "";
    } catch {
      return "";
    }
  }
  return "";
}

/* ===============================
   PUBLIC HTML (KV) + SELF-HEALING
================================= */

async function servePublicHtml(env, ctx, { reason }) {
  if (!env.YATI_KV) {
    return new Response("KV not bound (YATI_KV)", { status: 500 });
  }

  const key = "public_html_v1";
  const lastAtKey = "public_html_last_at";

  let html = await env.YATI_KV.get(key);
  const lastAt = await env.YATI_KV.get(lastAtKey);

  const forceOnEmpty = String(env.PUBLIC_REFRESH_FORCE_ON_EMPTY || "1") === "1";
  if ((!html || html.length < 200) && forceOnEmpty) {
    log(env, "[YATI] KV sin public_html_v1 -> self-healing", { reason });

    ctx.waitUntil(refreshPublicHtml(env, { reason: "self-heal-empty" }));

    return new Response(buildPublicPlaceholder(env, lastAt, "Generando pagina..."), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      status: 200
    });
  }

  const refreshMin = parseInt(env.PUBLIC_REFRESH_MINUTES || "0", 10);
  if (refreshMin > 0 && shouldRefresh(lastAt, refreshMin)) {
    ctx.waitUntil(refreshPublicHtml(env, { reason: "periodic-refresh" }));
  }

  if (!html) {
    return new Response(buildPublicPlaceholder(env, lastAt, "Pagina aun no generada."), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      status: 200
    });
  }

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=20"
    },
    status: 200
  });
}

function shouldRefresh(lastAtIso, minutes) {
  if (!lastAtIso) return true;
  const t = Date.parse(lastAtIso);
  if (!Number.isFinite(t)) return true;
  return (Date.now() - t) > minutes * 60 * 1000;
}

function buildPublicPlaceholder(env, lastAt, why) {
  const workerUrl = env.WORKER_PUBLIC_URL || "";
  const publicUrl = workerUrl ? `${workerUrl.replace(/\/$/, "")}/public` : "/public";
  const last = lastAt ? lastAt : "No disponible";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>YATI</title>
</head>
<body style="font-family:Arial,sans-serif; padding:18px; max-width:900px; margin:0 auto;">
  <div style="padding:16px; border:1px solid #ddd; background:#fafafa; border-radius:12px;">
    <div style="font-size:18px; font-weight:700;">${escapeHtml(why)}</div>
    <div style="margin-top:10px; color:#555; font-size:13px;">
      Ultima marca en KV: <b>${escapeHtml(last)}</b><br/>
      Recarga en 15-30 segundos: <a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a>
    </div>
  </div>
</body>
</html>`;
}

async function refreshPublicHtml(env, meta) {
  const RAILWAY_BASE_URL = env.RAILWAY_BASE_URL;
  const token = await getEnvValue(env, "RAILWAY_BUILD_PUBLIC_TOKEN");

  if (!env.YATI_KV) return log(env, "[YATI] refreshPublicHtml: falta KV");
  if (!RAILWAY_BASE_URL) return log(env, "[YATI] refreshPublicHtml: falta RAILWAY_BASE_URL");
  if (!token) return log(env, "[YATI] refreshPublicHtml: falta RAILWAY_BUILD_PUBLIC_TOKEN");

  const buildUrl = `${RAILWAY_BASE_URL.replace(/\/$/, "")}/build-public`;
  log(env, "[YATI] Refresh public: llamando /build-public", { ...meta, buildUrl });

  const r = await fetch(buildUrl, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "User-Agent": "YATI-Worker/1.0"
    }
  });

  const txt = await safeText(r);
  if (!r.ok) {
    log(env, "[YATI] /build-public no OK", { status: r.status, body: txt.slice(0, 250) });
    return;
  }

  const publicRailwayUrl = `${RAILWAY_BASE_URL.replace(/\/$/, "")}/public`;
  const h = await fetch(publicRailwayUrl, { headers: { "User-Agent": "YATI-Worker/1.0" } });
  let html = await safeText(h);

  if (!h.ok || !html || html.length < 200) {
    log(env, "[YATI] No pude leer HTML desde Railway /public", { status: h.status, bytes: html?.length || 0 });
    return;
  }

  // (opcional) si quieres seguir reescribiendo igual:
  html = absolutizeAssets(html, RAILWAY_BASE_URL);

  await env.YATI_KV.put("public_html_v1", html);
  await env.YATI_KV.put("public_html_last_at", new Date().toISOString());

  log(env, "[YATI] Public HTML actualizado en KV", {
    key: "public_html_v1",
    bytes: html.length,
    reason: meta?.reason || "unknown"
  });
}

function absolutizeAssets(html, baseUrl) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  if (!base) return html;

  // Maneja src="/static/..." y src='/static/...'
  html = html.replace(/src="\/(.*?)"/g, `src="${base}/$1"`);
  html = html.replace(/src='\/(.*?)'/g, `src='${base}/$1'`);

  // Maneja href="/..." y href='/...'
  html = html.replace(/href="\/(.*?)"/g, `href="${base}/$1"`);
  html = html.replace(/href='\/(.*?)'/g, `href='${base}/$1'`);

  // Maneja src="static/..." y src='static/...'
  html = html.replace(/src="static\/(.*?)"/g, `src="${base}/static/$1"`);
  html = html.replace(/src='static\/(.*?)'/g, `src='${base}/static/$1'`);

  // Maneja href="static/..." y href='static/...'
  html = html.replace(/href="static\/(.*?)"/g, `href="${base}/static/$1"`);
  html = html.replace(/href='static\/(.*?)'/g, `href='${base}/static/$1'`);

  return html;
}

/* ===============================
   TODO lo demás: tu código existente
   (checkForNewEvent, twilio, helpers, etc.)
   👇👇👇
================================= */

// --- PEGA AQUÍ el resto de tus funciones tal cual las tienes ---
// checkForNewEvent, testManualAlert, loadTargets, buildMessageCompact,
// stripPunct, safeNum, formatFechaHora, compactRef, shortenName,
// toAscii, clampSmsAscii, twilioSms, twilioCall, markSeen, markAlerted, safeText

// ⚠️ Para no duplicar 500 líneas acá, pega desde tu archivo actual
// TODO lo que está DESPUÉS de refreshPublicHtml() y safeText().
// (Si quieres, te lo devuelvo 100% completo con todo incluido, pero ya sería exactamente lo mismo + proxy /static.)
async function safeText(resp) {
  try { return await resp.text(); } catch { return ""; }
}
