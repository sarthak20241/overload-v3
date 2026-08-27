// THROWAWAY. Phase 4 M1 risk probe: does a Supabase edge function actually
// stream, and does the Expo client actually receive chunks as they are sent?
//
// The whole Fast/Smart/Super design rests on the answer. If bytes are buffered
// anywhere - the edge runtime, the CDN in front of it, or expo/fetch on the
// device - then a "progressive card" is a lie and the plan needs rewriting
// before a single line of it is built. Prove it before building on it.
//
// Delete once the real SSE transport lands.

const enc = new TextEncoder();

Deno.serve((req: Request) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const t0 = Date.now();
  const stream = new ReadableStream({
    async start(controller) {
      // 10 events, 400ms apart. If they arrive in one lump at ~4s, something
      // between here and the client is buffering.
      for (let i = 1; i <= 10; i++) {
        const payload = JSON.stringify({ n: i, ms_since_start: Date.now() - t0 });
        controller.enqueue(enc.encode(`event: tick\ndata: ${payload}\n\n`));
        await new Promise((r) => setTimeout(r, 400));
      }
      controller.enqueue(enc.encode(`event: end\ndata: {"total_ms":${Date.now() - t0}}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      ...cors,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Nginx-style proxies buffer by default; this asks them not to.
      "X-Accel-Buffering": "no",
    },
  });
});
