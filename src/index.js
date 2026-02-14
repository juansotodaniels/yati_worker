export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkForNewEvent(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("YATI Worker activo");
    }

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
  if (!latestId) return;

  const magRaw = latest?.magnitude;
  const magVal =
    typeof magRaw === "object" && magRaw !== null
      ? magRaw.value
      : (latest?.magnitud ?? latest?.mag ?? latest?.magnitude);

  const M = parseFloat(String(magVal).replace(",", "."));
  if (!Number.isFinite(M)) return;

  const storedId = await env.YATI_KV.get("last_alerted_event_id");

  if (storedId === latestId) return;

  if (M < MIN_EVENT_MAGNITUDE) return;

  let payload;
  try {
    const u = new URL(RAILWAY_BASE_URL.replace(/\/$/, "") + "/alerta/v1");
    u.searchParams.set("min_mag", String(MIN_EVENT_MAGNITUDE));
    u.searchParams.set("min_int", String(MIN_INTENSITY_TO_SHOW));
    u.searchParams.set("top", String(ALERTA_TOP));

    const r = await fetch(u.toString(), { headers: { "User-Agent": "YATI-Worker/1.0" } });
    if (!r.ok) return;

    payload = await r.json();
  } catch {
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

  const message = buildMessage({
    evento,
    locs,
    top: ALERTA_TOP,
    minInt: MIN_INTENSITY_TO_SHOW
  });

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
   HELPERS
================================= */

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
