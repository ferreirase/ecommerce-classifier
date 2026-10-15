import { isSet, loadProducts } from "@/lib/data";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ set: string }> }) {
  const { set } = await params;
  if (!isSet(set)) return Response.json({ error: "unknown set" }, { status: 404 });
  return Response.json(await loadProducts(set));
}
