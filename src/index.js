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

    // Disparo manual de prueba: /test-alert?pin=123456&to=%2B569...&msg=...
    if (url.pathname === "/test-alert") {
      const pin = url.searchParams.get("pin") || "";
      if (!env.TEST_ALERT_PIN || pin !== env.TEST_ALERT_PIN) {
        return new Response("Forbidden", { status: 403 });
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

async function checkForNewEvent(env) {
  const XOR_URL = env.XOR_API_URL || "https://api.xor.cl/sismo/recent";
  const RAILWAY_BASE_URL = env.RAILWAY_BASE_URL;

  // Config general (Worker)
  const MIN_EVENT_MAGNITUDE = parseFloat(env.MIN_EVENT_MAGNITUDE || "4");
  const MIN_INTENSITY_TO_SHOW = parseInt(env.MIN_INTENSITY_TO_SHOW || "3", 10);
  const ALERTA_TOP = parseInt(env.ALERTA_TOP || "10", 10);

  const CANAL = (env.ALERTA_CANAL || "sms").toLowerCase(); // "sms" o "call"

  if (!RAILWAY_BASE_URL) {
    console.log("[YATI] Falta env.RAILWAY_BASE_URL");
    return;
  }

  // --- 1) Revisar XOR para detectar evento nuevo (con id) ---
  let data;
  try {
    const resp = await fetch(XOR_URL, { cf: { cacheTtl: 0, cacheEverything: false } });
    if (!resp.ok) {
      console.log("[YATI] XOR no OK:", resp.status);
      return;
    }
    data = await resp.json();
  } catch (e) {
    console.log("[YATI] Error fetch XOR:", String(e));
    return;
  }

  const events = Array.isArray(data) ? data : (data?.events || data?.data || data?.results || []);
  if (!Array.isArray(events) || events.length === 0) {
    console.log("[YATI] XOR sin events");
    return;
  }

  const latest = events[0];
  const latestId = String(latest?.id ?? "");
  if (!latestId) {
    console.log("[YATI] event sin id");
    return;
  }

  // Magnitud robusta: puede venir como number, string o {value:...}
  const magRaw = latest?.magnitude;
  const magVal =
    typeof magRaw === "object" && magRaw !== null
      ? magRaw.value
      : (latest?.magnitud ?? latest?.mag ?? latest?.magnitude);

  const M = parseFloat(String(magVal).replace(",", "."));
  if (!Number.isFinite(M)) {
    console.log("[YATI] No pude parsear magnitud para id:", latestId, "raw:", magVal);
    return;
  }

  // Guardamos el último id alertado (no solo visto), para evitar llamadas repetidas
  const storedId = await env.YATI_KV.get("last_alerted_event_id");

  // Si ya alertamos este id, no hacemos nada
  if (storedId === latestId) {
    console.log("[YATI] Sin cambio (ya alertado):", latestId);
    return;
  }

  // Si es nuevo PERO no cumple magnitud mínima, NO alertamos ni guardamos
  if (M < MIN_EVENT_MAGNITUDE) {
    console.log(`[YATI] Nuevo id ${latestId} pero M=${M} < ${MIN_EVENT_MAGNITUDE}. No alerto.`);
    return;
  }

  // --- 2) Traer payload desde Railway (evento + intensidades) ---
  console.log(`[YATI] Nuevo sismo detectado: ${latestId} (M=${M}). Consultando Railway /alerta/v1...`);

  let payload;
  try {
    const u = new URL(RAILWAY_BASE_URL.replace(/\/$/, "") + "/alerta/v1");
    u.searchParams.set("min_mag", String(MIN_EVENT_MAGNITUDE));
    u.searchParams.set("min_int", String(MIN_INTENSITY_TO_SHOW));
    u.searchParams.set("top", String(ALERTA_TOP));

    const r = await fetch(u.toString(), { headers: { "User-Agent": "YATI-Worker/1.0" } });
    if (!r.ok) {
      console.log("[YATI] Railway /alerta/v1 no OK:", r.status, (await safeText(r)).slice(0, 200));
      return;
    }
    payload = await r.json();
  } catch (e) {
    console.log("[YATI] Error llamando Railway /alerta/v1:", String(e));
    return;
  }

  const evento = payload?.evento || {};
  const mag = Number(evento?.magnitud ?? M);

  const locs = Array.isArray(payload?.localidades) ? payload.localidades : [];
  const locNames = new Set(locs.map(x => String(x?.localidad || "").toLowerCase()).filter(Boolean));

  // --- 3) Cargar targets desde KV ---
  const targets = await loadTargets(env);
  if (!targets.length) {
    console.log("[YATI] No hay targets (alert_targets_v1 vacío). No envío.");
    return;
  }

  // --- 4) Filtrar targets según reglas ---
  const selected = targets.filter(t => {
    if (!t.enabled) return false;

    const minMagUser = Number(t.min_mag ?? 0);
    if (mag < minMagUser) return false;

    const loc = String(t.localidad || "").trim();
    if (!loc) return true; // sin localidad => a todas

    return locNames.has(loc.toLowerCase());
  });

  if (!selected.length) {
    console.log("[YATI] Evento nuevo pero no hay targets que calcen reglas. No envío.");
    // Marcamos alertado para no repetir cada minuto si no hay destinatarios aplicables
    await markAlerted(env, latestId, mag);
    return;
  }

  // --- 5) Armar mensaje (Institucional, sin ID) ---
  const message = buildMessage({ evento, locs, top: ALERTA_TOP });

  // --- 6) Enviar por Twilio ---
  console.log(`[YATI] Enviando alerta a ${selected.length} targets via ${CANAL}...`);

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
    } catch (e) {
      console.log("[YATI] Error Twilio para", to, String(e));
    }
  }

  // --- 7) Solo si enviamos al menos 1, marcamos como alertado ---
  if (okCount > 0) {
    await markAlerted(env, latestId, mag);
    console.log("[YATI] OK enviados:", okCount, "event_id:", latestId);
  } else {
    console.log("[YATI] No se pudo enviar a nadie (okCount=0). No marco alertado.");
  }
}

// ---- TEST ALERT (manual) ----
async function testManualAlert(env, forceTo = "", customMsg = "") {
  const msg =
    (customMsg && customMsg.trim())
      ? customMsg.trim()
      : "YATI - Sistema de Alerta Sismica. Prueba manual de envio SMS (Twilio).";

  // Si se define TEST_ALERT_TO (o query param to=), mandamos solo a ese numero
  const toFixed = (forceTo || "").trim();

  if (toFixed) {
    try {
      await twilioSms(env, toFixed, msg);
      console.log("[TEST] Enviado a (forceTo):", toFixed);
    } catch (e) {
      console.log("[TEST] Error enviando a (forceTo):", toFixed, String(e));
    }
    return;
  }

  // Si no, enviamos a todos los targets habilitados
  const targets = await loadTargets(env);
  if (!targets.length) {
    console.log("[TEST] No hay targets en KV (alert_targets_v1)");
    return;
  }

  let sent = 0;
  for (const t of targets) {
    if (!t.enabled) continue;
    const to = String(t.phone || "").trim();
    if (!to) continue;

    try {
      await twilioSms(env, to, msg);
      console.log("[TEST] Enviado a:", to);
      sent++;
    } catch (e) {
      console.log("[TEST] Error enviando a:", to, String(e));
    }
  }
  console.log("[TEST] Total enviados:", sent);
}

// ---- TARGETS desde KV ----
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

// ---- MENSAJE (Institucional, sin ID, ASCII-friendly) ----
function buildMessage({ evento, locs, top }) {
  const mag = evento?.magnitud ?? "";
  const fecha = evento?.FechaHora ?? "";
  const ref = evento?.Referencia ?? "";

  const list = (locs || [])
    .slice(0, Math.min(top, 6))
    .map(x => `${x.localidad}(I=${x.intensidad_predicha})`)
    .join(", ");

  const locPart = list ? ` Localidades con intensidad estimada: ${list}.` : "";

  return `YATI - Sistema de Alerta Sismica. Magnitud ${mag}. Fecha y hora: ${fecha}. Referencia: ${ref}.${locPart}`;
}

// ---- TWILIO SMS ----
async function twilioSms(env, to, body) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) throw new Error("Faltan credenciales Twilio (SID/TOKEN/FROM).");

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  const form = new URLSearchParams();
  form.set("To", to);
  form.set("From", from);
  form.set("Body", body);

  const auth = btoa(`${sid}:${token}`);

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  if (!r.ok) throw new Error(`Twilio SMS no OK: ${r.status} ${(await safeText(r)).slice(0, 200)}`);
}

// ---- TWILIO CALL (opcional futuro) ----
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
  form.set("To", to);
  form.set("From", from);
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

  if (!r.ok) throw new Error(`Twilio CALL no OK: ${r.status} ${(await safeText(r)).slice(0, 200)}`);
}

// ---- KV: marcar alertado ----
async function markAlerted(env, eventId, mag) {
  await env.YATI_KV.put("last_alerted_event_id", String(eventId));
  await env.YATI_KV.put("last_alerted_mag", String(mag));
  await env.YATI_KV.put("last_alerted_at", new Date().toISOString());
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ""; }
}

