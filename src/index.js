export default {
  async scheduled(event, env, ctx) {
    await checkForNewEvent(env);
  },

  async fetch(request, env, ctx) {
    return new Response("YATI Worker activo");
  }
};

async function checkForNewEvent(env) {
  const response = await fetch(env.XOR_API_URL);
  const data = await response.json();

  if (!data.events || data.events.length === 0) {
    return;
  }

  const latest = data.events[0];
  const latestId = latest.id;

  const storedId = await env.YATI_KV.get("last_event_id");

  if (storedId !== latestId) {
    console.log("Nuevo sismo detectado:", latestId);

    await env.YATI_KV.put("last_event_id", latestId);

    await fetch(env.RAILWAY_ENDPOINT);
  }
}
