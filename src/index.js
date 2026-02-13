export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkForNewEvent(env));
  },

  async fetch(request, env, ctx) {
    // Endpoint simple para probar que el worker está vivo
    return new Response("YATI Worker activo");
  }
};

async function checkForNewEvent(env) {
  const XOR_URL = env.XOR_API_URL || "https://api.xor.cl/sismo/recent";
  const RAILWAY = env.RAILWAY_ENDPOINT; // endpoint que dispara regeneración/alerta en Railway

  // Configurable:
  // - ideal: setear MIN_EVENT_MAGNITUDE en Cloudflare (Variables and Secrets)
  // - fallback: 4.0
  const MIN_EVENT_MAGNITUDE = parseFloat(env.MIN_EVENT_MAGNITUDE || "4");

  if (!RAILWAY) {
    console.log("[YATI] Falta env.RAILWAY_ENDPOINT");
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

  // XOR puede venir como {events:[...]} o como lista
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

  // Si es nuevo PERO no cumple magnitud mínima, NO llamamos a Railway
  if (M < MIN_EVENT_MAGNITUDE) {
    console.log(`[YATI] Nuevo id ${latestId} pero M=${M} < ${MIN_EVENT_MAGNITUDE}. No llamo Railway.`);
    // Ojo: NO guardamos como "alertado", para que si después aparece otro id mayor sí se procese.
    // (Si quieres guardar "last_seen_event_id" aparte, también se puede.)
    return;
  }

  // ✅ Nuevo + cumple magnitud: llamamos a Railway
  console.log(`[YATI] Nuevo sismo detectado: ${latestId} (M=${M}). Llamando Railway...`);

  try {
    // Recomendación: que Railway tenga un endpoint específico para "regenerar cache/HTML"
    // Ej: https://tu-railway.app/refresh
    const r = await fetch(RAILWAY, {
      method: "GET",
      headers: { "User-Agent": "YATI-Worker/1.0" }
    });

    console.log("[YATI] Railway status:", r.status);

    // Solo si Railway respondió OK, marcamos el id como alertado
    if (r.ok) {
      await env.YATI_KV.put("last_alerted_event_id", latestId);
      await env.YATI_KV.put("last_alerted_mag", String(M));
      await env.YATI_KV.put("last_alerted_at", new Date().toISOString());
      console.log("[YATI] KV actualizado last_alerted_event_id =", latestId);
    } else {
      const txt = await safeText(r);
      console.log("[YATI] Railway no OK body:", txt?.slice(0, 300));
    }
  } catch (e) {
    console.log("[YATI] Error llamando Railway:", String(e));
  }
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ""; }
}

