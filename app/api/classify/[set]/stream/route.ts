import { isSet } from "@/lib/data";
import { snapshot, subscribe, type JobEvent } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** SSE: full snapshot on connect (so reconnects and extra tabs catch up), then live events. */
export async function GET(req: Request, { params }: { params: Promise<{ set: string }> }) {
  const { set } = await params;
  if (!isSet(set)) return Response.json({ error: "unknown set" }, { status: 404 });

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: JobEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          cleanup(); // stream already closed
        }
      };
      send(snapshot(set));
      const unsubscribe = subscribe(set, send);
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 15_000);
      cleanup = () => {
        unsubscribe();
        clearInterval(heartbeat);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
