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

      // Si no está habilitado → 404 como si no existiera
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

    // TwiML para llamadas
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
   FLUJO AUTOMÁTICO (CRON)
================================= */

async function checkForNewEvent(env) {

  const XOR_URL = env.XOR_API_URL || "https://api.xor.cl/sismo/recent";
  const RAILWAY_BASE_URL = env.RAILWAY_BASE_URL;

  const MIN_EVENT_MAGNITUDE = parseFloat(env.MIN_EVENT_MAGNITUDE || "4");
  const MIN_INTENSITY_TO_SHOW = parseInt(env.MIN_INTENSITY_TO_SHOW || "3", 10);
  const ALERTA_TOP = parseInt(env.ALERTA_TOP || "10", 10);
  const CANAL = (env.ALERTA_CANAL || "sms").toLowerCase();

  if (!RAILWAY_BASE_URL) {
    console.log("[YATI] Falta env.RAILWAY_BASE_URL");
    return;
  }

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

  const magRaw = latest?.magnitude;
  const magVal =
    typeof magRaw === "object" && magRaw !== null
      ? magRaw.value
      : (latest?.magnitud ?? latest?.mag ?? latest?.magnitude);

  const M = parseFloat(String(magVal).replace(",", "."));
  if (!Number.isFinite(M)) {
    console.log("[YATI] No pude parsear magnitud para id:", latestId);
    return;
  }

  const storedId = await env.YATI_KV.get("last_alerted_event_id");

  if (storedId === latestId) {
    console.log("[YATI] Sin cambio (ya alertado):", latestId);
    return;
  }

  if (M < MIN_EVENT_MAGNITUDE) {
    console.log(`[YATI] Nuevo id ${latestId} pero M=${M} < ${MIN_EVENT_MAGNITUDE}. No alerto.`);
    return;
  }

  console.log(`[YATI] Nuevo sismo detectado: ${latestId} (M=${M}). Consultando Railway /alerta/v1...`);

  let payload;
  try {
    const u = new URL(RAILWAY_BASE_URL.replace(/\/$/, "") + "/alerta/v1");
    u.searchParams.set("min_mag", String(MIN_EVENT_MAGNITUDE));
    u.searchParams.set("min_int", String(MIN_INTENSITY_TO_SHOW));
    u.searchParams.set("top", String(ALERTA_TOP));

    const r = await fetch(u.toString(), { headers: { "User-Agent": "YATI-Worker/1.0" } });
    if (!r.ok) {
      console.log("[YATI] Railway /alerta/v1 no OK:", r.status);
      return;
    }
    payload = await r.json();
  } catch (e) {
    console.log("[YATI] Error Railway:", String(e));
    return;
  }

  const evento = payload?.evento || {};
  const mag = Number(evento?.magnitud ?? M);
  const locs = Array.isArray(payload?.localidades) ? payload.localidades : [];

  const locNames = new Set(
    locs.map(x => String(x?.localidad || "").toLowerCase()).filter(Boolean)
  );

  const targets = await loadTargets(env);
  if (!targets.length) return;

  const selected = targets.filter(t => {
    if (!t.enabled) return false;
    if (mag < Number(t.min_mag ?? 0)) return false;

    const loc = String(t.localidad || "").trim();
    if (!loc) return true;

    return locNames.has(loc.toLowerCase());
  });

  if (!selected.length) {
    await markAlerted(env, latestId, mag);
    return;
  }

  const message = buildMessage({ evento, locs, top: ALERTA_TOP });

  let okCount = 0;

  for (const t of selected) {
    try {
      if (CANAL === "call") {
        await twilioCall(env, t.phone, message);
      } else {
        await twilioSms(env, t.phone, message);
      }
      okCount++;
    } catch (e) {
      console.log("[YATI] Error Twilio:", String(e));
    }
  }

  if (okCount > 0) {
    await markAlerted(env, latestId, mag);
  }
}

/* ===============================
   TEST ALERT
================================= */

async function testManualAlert(env, forceTo = "", customMsg = "") {

  const msg =
    (customMsg && customMsg.trim())
      ? customMsg.trim()
      : "YATI - Sistema de Alerta Sismica. Prueba manual de envio SMS.";

  const toFixed = (forceTo || "").trim();

  if (toFixed) {
    await twilioSms(env, toFixed, msg);
    return;
  }

  const targets = await loadTargets(env);
  for (const t of targets) {
    if (t.enabled) {
      await twilioSms(env, t.phone, msg);
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
  } catch {
    return [];
  }
}

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
    // Twilio devuelve JSON con code/message normalmente
    throw new Error(`Twilio SMS no OK: ${r.status} ${txt?.slice(0, 300)}`);
  }

  return txt;
}


async function twilioCall(env, to, text) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM_NUMBER;
  const base = env.WORKER_PUBLIC_URL;

  const twimlUrl = new URL(base.replace(/\/$/, "") + "/twiml");
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

  if (!r.ok) throw new Error("Twilio CALL error");
}

async function markAlerted(env, eventId, mag) {
  await env.YATI_KV.put("last_alerted_event_id", String(eventId));
  await env.YATI_KV.put("last_alerted_mag", String(mag));
  await env.YATI_KV.put("last_alerted_at", new Date().toISOString());
}

