// src/index.js — YATI Worker (Cloudflare Workers)
// - Cron: detecta sismo nuevo (XOR), consulta Railway /alerta/v1, filtra targets y envía por Twilio
// - ✅ Genera/actualiza HTML público en KV llamando a Railway /build-public (cuando hay alerta)
// - ✅ /public: sirve el HTML liviano desde KV (para miles/millones de consultas)
// - ✅ /refresh-public: fuerza regeneración (protegido con token)
// - Guarda en KV:
//    - last_seen_event_id, last_seen_mag, last_seen_at
//    - last_alerted_event_id, last_alerted_payload_id, last_alerted_mag, last_alerted_at

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkForNewEvent(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health
    if (url.pathname === "/") {
      return new Response("YATI Worker activo");
    }

    // ✅ PUBLIC: HTML liviano servido desde KV (Cloudflare)
    if (url.pathname === "/public") {
      return servePublicHtml(env);
    }

    // ✅ Refresh manual del HTML público (protegido)
    // Headers: Authorization: Bearer <BUILD_PUBLIC_TOKEN>
    if (url.pathname === "/refresh-public") {
      const ok = await authorizeBearer(request, env.BUILD_PUBLIC_TOKEN);
      if (!ok) return new Response("Unauthorized", { status: 401 });

      ctx.waitUntil(refreshPublicFromRailway(env, { reason: "manual" }));
      return new Response("OK - refresh-public triggered");
    }

    // 🔒 TEST ALERT (protegido por ENABLE_TEST_ALERT)
    if (url.pathname === "/test-alert") {
      if (env.ENABLE_TEST_ALERT !== "1") {
        return new Response("Not Found", { status: 404 });
      }

      const pin = url.searchParams.get("pin") || "";
      if (!env.TEST_ALERT_PIN || pin !== env.TEST_ALERT_PIN) {
        return new Response("Unauthorized", { status: 401 });
      }

      const to = url.searchParams.get("to") || env.TEST_ALERT_TO || "";
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

function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/* ===============================
   LOG HELPER (más explícito)
================================= */
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

/* ===============================
   PUBLIC HTML (KV)
================================= */

function publicKvKey(env) {
  return String(env.PUBLIC_HTML_KV_KEY || "public_html_v1");
}

function publicCacheTtl(env) {
  const n = parseInt(env.PUBLIC_CACHE_TTL_SECONDS || "60", 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

// Sirve el HTML público desde KV. Si no existe, muestra aviso.
async function servePublicHtml(env) {
  if (!env.YATI_KV) {
    return new Response("Falta binding KV env.YATI_KV", { status: 500 });
  }

  const key = publicKvKey(env);
  const html = await env.YATI_KV.get(key);

  if (!html) {
    const msg = `Aún no se ha generado el HTML público.
El Worker lo generará cuando haya un evento que dispare alerta, o puedes generarlo manualmente llamando /refresh-public (protegido).`;
    return new Response(msg, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }

  // Cache CDN (edge) para aguantar picos masivos.
  // Ojo: igual estás sirviendo desde Cloudflare, el origin NO es Railway.
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": `public, max-age=${publicCacheTtl(env)}`
    }
  });
}

// Llama a Railway /build-public, y luego descarga el HTML desde /public_static/index.html
async function refreshPublicFromRailway(env, { reason = "auto", eventId = "", mag = "" } = {}) {
  const RAILWAY_BASE_URL = env.RAILWAY_BASE_URL;
  const token = env.BUILD_PUBLIC_TOKEN;

  if (!env.YATI_KV) {
    log(env, "[YATI] KV missing: env.YATI_KV");
    return;
  }
  if (!RAILWAY_BASE_URL) {
    log(env, "[YATI] No puedo refrescar public: falta env.RAILWAY_BASE_URL");
    return;
  }
  if (!token) {
    log(env, "[YATI] No puedo refrescar public: falta env.BUILD_PUBLIC_TOKEN");
    return;
  }

  const base = RAILWAY_BASE_URL.replace(/\/$/, "");
  const buildUrl = `${base}/build-public`;
  const htmlUrl = `${base}/public_static/index.html`;

  log(env, "[YATI] Refresh public: llamando /build-public", { reason, eventId, mag, buildUrl });

  // 1) gatilla build
  let buildJson;
  try {
    const r = await fetch(buildUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": "YATI-Worker/1.0"
      }
    });
    const t = await safeText(r);
    if (!r.ok) {
      log(env, "[YATI] build-public no OK", { status: r.status, body: t.slice(0, 300) });
      return;
    }
    try { buildJson = JSON.parse(t); } catch { buildJson = { raw: t }; }
  } catch (e) {
    log(env, "[YATI] Error llamando build-public", { err: String(e) });
    return;
  }

  // 2) descarga HTML listo
  let html;
  try {
    const r2 = await fetch(htmlUrl, {
      method: "GET",
      headers: { "User-Agent": "YATI-Worker/1.0" }
    });
    const t2 = await safeText(r2);
    if (!r2.ok) {
      log(env, "[YATI] No pude descargar HTML público", { status: r2.status, body: t2.slice(0, 200), htmlUrl });
      return;
    }
    html = t2;
  } catch (e) {
    log(env, "[YATI] Error descargando HTML público", { err: String(e), htmlUrl });
    return;
  }

  // 3) guarda en KV
  const key = publicKvKey(env);
  await env.YATI_KV.put(key, html);
  await env.YATI_KV.put("public_html_last_update", new Date().toISOString());
  await env.YATI_KV.put("public_html_last_reason", String(reason));
  if (eventId) await env.YATI_KV.put("public_html_last_event_id", String(eventId));
  if (mag !== "") await env.YATI_KV.put("public_html_last_mag", String(mag));

  log(env, "[YATI] Public HTML actualizado en KV", {
    key,
    bytes: html.length,
    reason,
    eventId,
    mag,
    build: buildJson?.ok ?? buildJson?.status ?? "unknown"
  });
}

async function authorizeBearer(request, expectedToken) {
  if (!expectedToken) return false;
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1].trim() === String(expectedToken).trim();
}

/* ===============================
   FLUJO AUTOMÁTICO (CRON)
================================= */

async function checkForNewEvent(env) {
  const XOR_URL = env.XOR_API_URL || "https://api.xor.cl/sismo/recent";
  const RAILWAY_BASE_URL = env.RAILWAY_BASE_URL;

  const MIN_EVENT_MAGNITUDE = parseFloat(env.MIN_EVENT_MAGNITUDE || "4");
  const MIN_INTENSITY_TO_SHOW = parseInt(env.MIN_INTENSITY_TO_SHOW || "3", 10);
  const ALERTA_TOP = parseInt(env.ALERTA_TOP || "10", 10);
  const CANAL = (env.ALERTA_CANAL || "sms").toLowerCase(); // "sms" o "call"

  if (!RAILWAY_BASE_URL) {
    console.log("[YATI] Falta env.RAILWAY_BASE_URL");
    return;
  }
  if (!env.YATI_KV) {
    console.log("[YATI] Falta binding KV env.YATI_KV");
    return;
  }

  log(env, "[YATI] Cron tick", {
    minMagGlobal: MIN_EVENT_MAGNITUDE,
    minIntToShow: MIN_INTENSITY_TO_SHOW,
    top: ALERTA_TOP,
    canal: CANAL
  });

  // --- 1) Revisar XOR ---
  let data;
  try {
    const resp = await fetch(XOR_URL, { cf: { cacheTtl: 0, cacheEverything: false } });
    if (!resp.ok) {
      log(env, "[YATI] XOR no OK", { status: resp.status });
      return;
    }
    data = await resp.json();
  } catch (e) {
    log(env, "[YATI] Error fetch XOR", { err: String(e) });
    return;
  }

  const events = Array.isArray(data) ? data : (data?.events || data?.data || data?.results || []);
  if (!Array.isArray(events) || events.length === 0) {
    log(env, "[YATI] XOR sin events");
    return;
  }

  const latest = events[0];
  const latestId = String(latest?.id ?? "");
  if (!latestId) {
    log(env, "[YATI] event sin id (XOR)");
    return;
  }

  // Magnitud robusta
  const magRaw = latest?.magnitude;
  const magVal =
    typeof magRaw === "object" && magRaw !== null
      ? magRaw.value
      : (latest?.magnitud ?? latest?.mag ?? latest?.magnitude);

  const M = parseFloat(String(magVal).replace(",", "."));
  if (!Number.isFinite(M)) {
    log(env, "[YATI] No pude parsear magnitud", { latestId, magVal });
    return;
  }

  // ✅ 2) last_seen (siempre que cambie el latestId)
  const prevSeen = await env.YATI_KV.get("last_seen_event_id");
  if (prevSeen !== latestId) {
    await markSeen(env, latestId, M);
    log(env, "[YATI] Nuevo evento visto (last_seen actualizado)", { latestId, M, prevSeen });
  } else {
    log(env, "[YATI] Último evento visto sin cambios", { latestId, M });
  }

  // ✅ 3) last_alerted: evita repetir alertas del MISMO evento
  const storedAlerted = await env.YATI_KV.get("last_alerted_event_id");
  if (storedAlerted === latestId) {
    log(env, "[YATI] Ya alertado, no repito", { latestId, M });
    return;
  }

  // Filtro global de magnitud
  if (M < MIN_EVENT_MAGNITUDE) {
    log(env, "[YATI] Evento nuevo pero bajo umbral global, no alerto", {
      latestId,
      M,
      minMagGlobal: MIN_EVENT_MAGNITUDE
    });
    return;
  }

  log(env, "[YATI] Evento candidato a alerta (pasa umbral global)", { latestId, M });

  // --- 4) Consultar Railway /alerta/v1 ---
  let payload;
  let railwayUrl = "";
  try {
    const u = new URL(RAILWAY_BASE_URL.replace(/\/$/, "") + "/alerta/v1");
    u.searchParams.set("min_mag", String(MIN_EVENT_MAGNITUDE));
    u.searchParams.set("min_int", String(MIN_INTENSITY_TO_SHOW));
    u.searchParams.set("top", String(ALERTA_TOP));
    railwayUrl = u.toString();

    const r = await fetch(railwayUrl, { headers: { "User-Agent": "YATI-Worker/1.0" } });
    if (!r.ok) {
      const t = await safeText(r);
      log(env, "[YATI] Railway /alerta/v1 no OK", { status: r.status, body: t.slice(0, 200) });
      return;
    }
    payload = await r.json();
  } catch (e) {
    log(env, "[YATI] Error Railway", { err: String(e), railwayUrl });
    return;
  }

  const evento = payload?.evento || {};
  const mag = Number(evento?.magnitud ?? M);
  const locs = Array.isArray(payload?.localidades) ? payload.localidades : [];

  // payloadId (si Railway trae id; si no, usa latestId)
  const payloadId = String(
    evento?.id ??
    evento?.event_id ??
    evento?.evento_id ??
    evento?.ID ??
    latestId
  );

  log(env, "[YATI] Railway OK", {
    latestId,
    payloadId,
    mag,
    locCount: locs.length
  });

  const locNames = new Set(
    locs.map(x => String(x?.localidad || "").toLowerCase()).filter(Boolean)
  );

  // --- 5) Targets desde KV ---
  const targets = await loadTargets(env);
  log(env, "[YATI] Targets cargados", { count: targets.length });

  if (!targets.length) {
    log(env, "[YATI] No hay targets (alert_targets_v1 vacío). No envío.");
    return;
  }

  // --- 6) Filtrado targets ---
  const selected = targets.filter(t => {
    if (!t.enabled) return false;

    const minMagUser = Number(t.min_mag ?? 0);
    if (mag < minMagUser) return false;

    const loc = String(t.localidad || "").trim();
    if (!loc) return true;

    return locNames.has(loc.toLowerCase());
  });

  log(env, "[YATI] Targets seleccionados", { selected: selected.length, total: targets.length });

  if (!selected.length) {
    // Marcamos alertado para no repetir cada minuto si no hay destinatarios aplicables
    await markAlerted(env, latestId, mag, payloadId);
    log(env, "[YATI] Sin targets aplicables: marco last_alerted para no repetir", { latestId, mag, payloadId });

    // Igual podemos refrescar HTML público (opcional). Si no quieres, comenta esta línea:
    // await refreshPublicFromRailway(env, { reason: "no-targets", eventId: latestId, mag: String(mag) });

    return;
  }

  // --- 7) Mensaje ---
  // ✅ IMPORTANTE: ahora mandamos link a Cloudflare /public (no Railway)
  const publicUrl = (env.WORKER_PUBLIC_URL || "").replace(/\/$/, "") + "/public";

  const message = buildMessage({
    evento,
    locs,
    top: ALERTA_TOP,
    minInt: MIN_INTENSITY_TO_SHOW,
    publicUrl
  });

  // --- 8) Envío Twilio ---
  let okCount = 0;
  for (const t of selected) {
    const to = String(t.phone || "").trim();
    if (!to) continue;

    try {
      if (CANAL === "call") {
        await twilioCall(env, to, message);
      } else {
        await twilioSms(env, to, message);
      }
      okCount++;
      log(env, "[YATI] SMS enviado OK", { to });
    } catch (e) {
      log(env, "[YATI] Error Twilio", { to, err: String(e) });
    }
  }

  // --- 9) Marcar alertado ---
  if (okCount > 0) {
    await markAlerted(env, latestId, mag, payloadId);
    log(env, "[YATI] Alerta finalizada OK (last_alerted actualizado)", { okCount, latestId, mag, payloadId });

    // ✅ 10) Refrescar HTML público en Cloudflare KV (para que la gente consulte /public)
    await refreshPublicFromRailway(env, { reason: "alert-sent", eventId: latestId, mag: String(mag) });

  } else {
    log(env, "[YATI] No se pudo enviar a nadie (okCount=0). No marco alertado.", { latestId, mag, payloadId });
  }
}

/* ===============================
   TEST ALERT
================================= */

async function testManualAlert(env, forceTo = "", customMsg = "") {
  const msg =
    (customMsg && customMsg.trim())
      ? customMsg.trim()
      : "YATI - Sistema de Alerta de Intensidad Sismica. Prueba manual de envio SMS.";

  const toFixed = (forceTo || "").trim();

  if (toFixed) {
    await twilioSms(env, toFixed, msg);
    console.log("[TEST] Enviado a (forceTo):", toFixed);
    return;
  }

  const targets = await loadTargets(env);
  for (const t of targets) {
    if (t.enabled) {
      await twilioSms(env, t.phone, msg);
      console.log("[TEST] Enviado a:", t.phone);
    }
  }
}

/* ===============================
   HELPERS
================================= */

async function loadTargets(env) {
  try {
    const raw = await env.YATI_KV.get("alert_targets_v1");
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(x => ({
      user: x.user || "",
      phone: x.phone || "",
      min_mag: x.min_mag ?? 0,
      localidad: x.localidad || "",
      enabled: Boolean(x.enabled)
    }));
  } catch (e) {
    console.log("[YATI] Error leyendo alert_targets_v1:", String(e));
    return [];
  }
}

// Mensaje (incluye texto cuando no hay localidades sobre umbral)
function buildMessage({ evento, locs, top, minInt, publicUrl }) {
  const mag = evento?.magnitud ?? "";
  const fecha = evento?.FechaHora ?? "";
  const ref = evento?.Referencia ?? "";

  const list = (locs || [])
    .slice(0, Math.min(top, 6))
    .map(x => `${x.localidad}(I=${x.intensidad_predicha})`)
    .join(", ");

  const link = publicUrl ? ` Ver detalles: ${publicUrl}` : "";

  if (!list) {
    return `YATI - Alerta. Magnitud ${mag}. Fecha y hora: ${fecha}. Referencia: ${ref}. No hay localidades con intensidad sobre umbral ${minInt}.${link}`;
  }

  return `YATI - Alerta. Magnitud ${mag}. Fecha y hora: ${fecha}. Referencia: ${ref}. Localidades: ${list}.${link}`;
}

// Twilio SMS
async function twilioSms(env, to, body) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    throw new Error("Faltan credenciales Twilio (SID/TOKEN/FROM).");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  const form = new URLSearchParams();
  form.set("To", String(to).trim());
  form.set("From", String(from).trim());
  form.set("Body", String(body));

  const auth = btoa(`${sid}:${token}`);

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  const txt = await safeText(r);
  if (!r.ok) {
    throw new Error(`Twilio SMS no OK: ${r.status} ${txt?.slice(0, 300)}`);
  }
  return txt;
}

// Twilio Call (opcional futuro)
async function twilioCall(env, to, text) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) throw new Error("Faltan credenciales Twilio (SID/TOKEN/FROM).");
  if (!env.WORKER_PUBLIC_URL) throw new Error("Falta env.WORKER_PUBLIC_URL (ej: https://tu-worker.workers.dev)");

  const twimlUrl = new URL(env.WORKER_PUBLIC_URL.replace(/\/$/, "") + "/twiml");
  twimlUrl.searchParams.set("text", text);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`;

  const form = new URLSearchParams();
  form.set("To", String(to).trim());
  form.set("From", String(from).trim());
  form.set("Url", twimlUrl.toString());

  const auth = btoa(`${sid}:${token}`);

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  const txt = await safeText(r);
  if (!r.ok) throw new Error(`Twilio CALL no OK: ${r.status} ${txt?.slice(0, 300)}`);
}

// ✅ last_seen: trazabilidad (aunque no alerte)
async function markSeen(env, eventId, mag) {
  await env.YATI_KV.put("last_seen_event_id", String(eventId));
  await env.YATI_KV.put("last_seen_mag", String(mag));
  await env.YATI_KV.put("last_seen_at", new Date().toISOString());
}

// last_alerted: cuando decidimos “no repetir este evento”
async function markAlerted(env, eventId, mag, payloadId) {
  await env.YATI_KV.put("last_alerted_event_id", String(eventId));
  await env.YATI_KV.put("last_alerted_payload_id", String(payloadId || eventId));
  await env.YATI_KV.put("last_alerted_mag", String(mag));
  await env.YATI_KV.put("last_alerted_at", new Date().toISOString());
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ""; }
}

