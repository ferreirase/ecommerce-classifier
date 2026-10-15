import { isSet } from "@/lib/data";
import { isVariant } from "@/lib/audience";
import { cancelJob, JobRunningError, snapshot, startJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ set: string }> };

async function setFrom(ctx: Ctx) {
  const { set } = await ctx.params;
  return isSet(set) ? set : null;
}

export async function GET(_req: Request, ctx: Ctx) {
  const set = await setFrom(ctx);
  if (!set) return Response.json({ error: "unknown set" }, { status: 404 });
  return Response.json(snapshot(set));
}

export async function POST(req: Request, ctx: Ctx) {
  const set = await setFrom(ctx);
  if (!set) return Response.json({ error: "unknown set" }, { status: 404 });
  const { variant = "off", concurrency } = await req.json().catch(() => ({}));
  if (!isVariant(variant)) return Response.json({ error: "unknown variant" }, { status: 400 });
  // Optional override, for load tests; bounded so one request can't open thousands of sockets.
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 512)) {
    return Response.json({ error: "concurrency must be an integer from 1 to 512" }, { status: 400 });
  }
  try {
    return Response.json(await startJob(set, variant, concurrency), { status: 202 });
  } catch (error) {
    if (error instanceof JobRunningError) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: String((error as Error).message) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const set = await setFrom(ctx);
  if (!set) return Response.json({ error: "unknown set" }, { status: 404 });
  return Response.json({ cancelled: cancelJob(set) });
}
