// src/index.js — YATI Worker (Cloudflare Workers)
// - Cron: detecta sismo nuevo (XOR), consulta Railway /alerta/v1, filtra targets y envía por Twilio
// - Guarda en KV:
//    - last_seen_event_id, last_seen_mag, last_seen_at
//    - last_alerted_event_id, last_alerted_payload_id, last_alerted_mag, last_alerted_at
// - Endpoint manual: /test-alert (protegido por ENABLE_TEST_ALERT + PIN)
// - Endpoint TwiML: /twiml (para llamadas, opcional)

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
    return;
  }

  // --- 7) Mensaje ---
  const message = buildMessage({
    evento,
    locs,
    top: ALERTA_TOP,
    minInt: MIN_INTENSITY_TO_SHOW
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
function buildMessage({ evento, locs, top, minInt }) {
  const mag = evento?.magnitud ?? "";
  const fecha = evento?.FechaHora ?? "";
  const ref = evento?.Referencia ?? "";

  const list = (locs || [])
    .slice(0, Math.min(top, 6))
    .map(x => `${x.localidad}(I=${x.intensidad_predicha})`)
    .join(", ");

  if (!list) {
    return `YATI - Sistema de Alerta de Intensidad Sismica. Magnitud ${mag}. Fecha y hora: ${fecha}. Referencia: ${ref}. No hay localidades con intensidad estimada sobre el umbral ${minInt}.`;
  }

  return `YATI - Sistema de Alerta de Intensidad Sismica. Magnitud ${mag}. Fecha y hora: ${fecha}. Referencia: ${ref}. Localidades con intensidad estimada: ${list}.`;
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
