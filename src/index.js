// src/index.js — YATI Worker (Cloudflare Workers)
// - Cron: detecta sismo nuevo (XOR), consulta Railway /alerta/v1, filtra targets y envía por Twilio
// - Guarda en KV:
//    - last_seen_event_id, last_seen_mag, last_seen_at
//    - last_alerted_event_id, last_alerted_payload_id, last_alerted_mag, last_alerted_at
// - Endpoint manual: /test-alert (protegido por ENABLE_TEST_ALERT + PIN)
// - Endpoint TwiML: /twiml (para llamadas, opcional)
//
// ✅ MODS (Trial-friendly):
//   - Mensaje compacto estilo: "YATI M3.9 | 14-Feb 21:09 | Ref | Talca(4), ..."
//   - ASCII-only (sin tildes) para evitar UCS-2
//   - Máximo 7 localidades (configurable por env ALERTA_TOP, default 7)
//   - Corte duro por longitud (env SMS_MAX_LEN, default 155)
//   - Limpieza de caracteres raros y acortado de nombres
//
// ✅ NUEVO (Problema 1: Self-healing HTML):
//   - Endpoint /public que sirve HTML desde KV (public_html_v1)
//   - Si KV está vacío: llama Railway /build-public y luego lee Railway /public para poblar KV
//   - Opcional refresco periódico: PUBLIC_REFRESH_MINUTES (0 desactiva)
//
// ✅ NUEVO (Problema 2: signos raros en SMS):
//   - Elimina ¿ ¡ ? ! del SMS para evitar caracteres “problemáticos” en algunos equipos/carriers

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

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ===============================
   LOG HELPER (más explícito)
================================= */
function log(env, msg, extra) {
  // LOG_LEVEL opcional: "debug" | "info" (default) | "silent"
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

  // ✅ Si falta, disparar self-healing (no bloqueante)
  const forceOnEmpty = String(env.PUBLIC_REFRESH_FORCE_ON_EMPTY || "1") === "1";
  if ((!html || html.length < 200) && forceOnEmpty) {
    log(env, "[YATI] KV sin public_html_v1 -> self-healing", { reason });

    ctx.waitUntil(refreshPublicHtml(env, { reason: "self-heal-empty" }));

    return new Response(buildPublicPlaceholder(env, lastAt, "Generando pagina..."), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      status: 200
    });
  }

  // ✅ Refresco periódico opcional aunque exista HTML
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
  const token = env.RAILWAY_BUILD_PUBLIC_TOKEN; // ✅ SECRET

  if (!env.YATI_KV) return log(env, "[YATI] refreshPublicHtml: falta KV");
  if (!RAILWAY_BASE_URL) return log(env, "[YATI] refreshPublicHtml: falta RAILWAY_BASE_URL");
  if (!token) return log(env, "[YATI] refreshPublicHtml: falta RAILWAY_BUILD_PUBLIC_TOKEN");

  const buildUrl = `${RAILWAY_BASE_URL.replace(/\/$/, "")}/build-public`;
  log(env, "[YATI] Refresh public: llamando /build-public", { ...meta, buildUrl });

  // 1) Disparar build en Railway (protegido)
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

  // 2) Leer HTML desde Railway /public (snapshot liviano)
  const publicRailwayUrl = `${RAILWAY_BASE_URL.replace(/\/$/, "")}/public`;
  const h = await fetch(publicRailwayUrl, { headers: { "User-Agent": "YATI-Worker/1.0" } });
  const html = await safeText(h);

  if (!h.ok || !html || html.length < 200) {
    log(env, "[YATI] No pude leer HTML desde Railway /public", { status: h.status, bytes: html?.length || 0 });
    return;
  }

  await env.YATI_KV.put("public_html_v1", html);
  await env.YATI_KV.put("public_html_last_at", new Date().toISOString());

  log(env, "[YATI] Public HTML actualizado en KV", {
    key: "public_html_v1",
    bytes: html.length,
    reason: meta?.reason || "unknown"
  });
}

/* ===============================
   FLUJO AUTOMÁTICO (CRON)
================================= */

async function checkForNewEvent(env) {
  const XOR_URL = env.XOR_API_URL || "https://api.xor.cl/sismo/recent";
  const RAILWAY_BASE_URL = env.RAILWAY_BASE_URL;

  const MIN_EVENT_MAGNITUDE = parseFloat(env.MIN_EVENT_MAGNITUDE || "4");
  const MIN_INTENSITY_TO_SHOW = parseInt(env.MIN_INTENSITY_TO_SHOW || "3", 10);

  // ✅ default 7 (como pediste)
  const ALERTA_TOP = parseInt(env.ALERTA_TOP || "7", 10);

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
    log(env, "[YATI] Ultimo evento visto sin cambios", { latestId, M });
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

    // ✅ Self-healing: si KV no tiene HTML, lo generamos igual
    const html = await env.YATI_KV.get("public_html_v1");
    if ((!html || html.length < 200) && String(env.PUBLIC_REFRESH_FORCE_ON_EMPTY || "1") === "1") {
      await refreshPublicHtml(env, { reason: "self-heal-under-threshold", eventId: latestId, mag: String(M) });
    }

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
    log(env, "[YATI] No hay targets (alert_targets_v1 vacio). No envio.");

    // ✅ Igual refrescamos HTML publico para que se vea el evento
    await refreshPublicHtml(env, { reason: "no-targets-refresh", eventId: latestId, mag: String(mag) });

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
    await markAlerted(env, latestId, mag, payloadId);
    log(env, "[YATI] Sin targets aplicables: marco last_alerted para no repetir", { latestId, mag, payloadId });

    // ✅ Igual refrescamos HTML publico
    await refreshPublicHtml(env, { reason: "no-selected-refresh", eventId: latestId, mag: String(mag) });

    return;
  }

  // --- 7) Mensaje (compacto + ASCII + corte seguro) ---
  const message = buildMessageCompact(env, {
    evento,
    locs,
    top: ALERTA_TOP
  });

  // --- 8) Envio Twilio ---
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

    // ✅ Self-healing / refresh público cuando se envió alerta
    await refreshPublicHtml(env, { reason: "alert-sent", eventId: latestId, mag: String(mag) });

  } else {
    log(env, "[YATI] No se pudo enviar a nadie (okCount=0). No marco alertado.", { latestId, mag, payloadId });
  }
}

/* ===============================
   TEST ALERT
================================= */

async function testManualAlert(env, forceTo = "", customMsg = "") {
  // Si envias custom, igual lo “sanitizamos” para evitar Unicode y exceso
  const defaultMsg = "YATI TEST | 14-Feb 21:09 | Test manual | OK";
  const msgRaw =
    (customMsg && customMsg.trim())
      ? customMsg.trim()
      : defaultMsg;

  // ✅ ASCII + sin ¿¡!? + clamp
  const msg = clampSmsAscii(env, toAscii(stripPunct(msgRaw)));

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

/* ===============================
   MENSAJE COMPACTO (Trial-friendly)
   Formato:
   YATI M3.9 | 14-Feb 21:09 | Ref | Talca(4), SanJ(3), ...
================================= */

function buildMessageCompact(env, { evento, locs, top }) {
  const M = safeNum(evento?.magnitud);
  const magStr = Number.isFinite(M) ? M.toFixed(1) : String(evento?.magnitud ?? "").trim();

  const dt = formatFechaHora(evento?.FechaHora);
  const ref = compactRef(evento?.Referencia);

  // Lista localidades: max 7 (o top si menor)
  const maxLoc = Math.max(0, Math.min(parseInt(top || 0, 10) || 0, 7)) || 7;

  const list = (Array.isArray(locs) ? locs : [])
    .slice(0, maxLoc)
    .map(x => {
      const name = shortenName(String(x?.localidad || ""), 6); // "SanJ" style
      const I = String(x?.intensidad_predicha ?? "").trim();
      return `${name}(${I})`;
    })
    .filter(Boolean)
    .join(", ");

  let msg = `YATI M${magStr} | ${dt} | ${ref}`;
  if (list) msg += ` | ${list}`;

  // ✅ Quitar ¿¡!? + ASCII-only + clamp
  msg = stripPunct(msg);
  msg = toAscii(msg);
  msg = clampSmsAscii(env, msg);

  return msg;
}

function stripPunct(s) {
  // Problema 2: eliminar ¿ ¡ ? !
  return String(s || "")
    .replaceAll("¿", "")
    .replaceAll("¡", "")
    .replaceAll("?", "")
    .replaceAll("!", "");
}

function safeNum(x) {
  const n = parseFloat(String(x ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function formatFechaHora(fechaStr) {
  // Entrada esperada: "DD-MM-YYYY HH:MM:SS" (de tu app.py)
  // Salida: "14-Feb 21:09"
  const s = String(fechaStr || "").trim();
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})(?::\d{2})?$/);
  if (!m) return "NA";

  const dd = m[1];
  const mm = m[2];
  const hh = m[4];
  const mi = m[5];

  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const idx = parseInt(mm, 10) - 1;
  const mon = months[idx] || "NA";

  return `${dd}-${mon} ${hh}:${mi}`;
}

function compactRef(ref) {
  // Mantener corto, sin tildes, y evitar pipes
  let s = String(ref || "NoRef").trim();
  s = s.replaceAll("|", " ");
  s = s.replace(/\s+/g, " ");

  // Intenta acortar típico: "12 km al SE de Talca" -> "12 km SE Talca"
  s = s
    .replace(/\bal\s+/gi, " ")
    .replace(/\bde\s+/gi, " ")
    .replace(/\bdel\s+/gi, " ")
    .replace(/\bkm\s+al\s+/gi, "km ")
    .replace(/\bkm\s+a\s+/gi, "km ")
    .replace(/\bNoreste\b/gi, "NE")
    .replace(/\bNoroeste\b/gi, "NW")
    .replace(/\bSureste\b/gi, "SE")
    .replace(/\bSuroeste\b/gi, "SW");

  // "al SE de" variantes
  s = s.replace(/\b(SE|SW|NE|NW)\s+de\s+/gi, "$1 ");

  // Tope por largo
  s = s.length > 32 ? (s.slice(0, 32).trim() + "...") : s;
  return toAscii(stripPunct(s));
}

function shortenName(name, maxLen = 6) {
  // Quita tildes, deja A-Z0-9, saca espacios
  let s = toAscii(stripPunct(String(name || "").trim()));
  s = s.replace(/[^A-Za-z0-9 ]/g, "");
  s = s.replace(/\s+/g, " ").trim();

  if (!s) return "";

  // Heurística: si tiene varias palabras, usa primera + inicial(es)
  const parts = s.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0];
    const second = parts[1];
    const candidate = (first.slice(0, Math.max(3, Math.min(4, first.length))) + second[0]).slice(0, maxLen);
    return candidate;
  }

  // Una palabra: corta
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

function toAscii(input) {
  // Remueve diacríticos y reemplaza algunos caracteres raros
  let s = String(input || "");
  // Normaliza y quita tildes
  try {
    s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch {
    // Si el runtime no soporta normalize, igual seguimos
  }
  // Reemplazos comunes
  s = s.replaceAll("ñ", "n").replaceAll("Ñ", "N");
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // También evitar guiones raros
  s = s.replace(/[–—]/g, "-");
  return s;
}

function clampSmsAscii(env, body) {
  const maxLen = parseInt(env.SMS_MAX_LEN || "155", 10);
  let s = String(body || "");

  // Limpieza final: espacios
  s = s.replace(/\s+/g, " ").trim();

  if (s.length <= maxLen) return s;

  // Corte duro, pero intenta no cortar en medio de palabra
  let cut = s.slice(0, maxLen);
  const lastComma = cut.lastIndexOf(",");
  const lastBar = cut.lastIndexOf("|");
  const lastSpace = cut.lastIndexOf(" ");

  // Preferimos cortar en separadores “naturales”
  const pivot = Math.max(lastComma, lastBar, lastSpace);
  if (pivot > 40) cut = cut.slice(0, pivot).trim();

  return cut;
}

/* ===============================
   TWILIO
================================= */

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

/* ===============================
   KV: last_seen / last_alerted
================================= */

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

