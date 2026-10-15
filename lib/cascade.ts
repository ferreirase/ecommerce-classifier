import type { Product } from "./data";
import { fetchImagePart } from "./images";
import { categories, classify, productText, systemOneJson, type Category, type Classification } from "./jev";
import { FatalError, RetryableError } from "./pool";

/**
 * Image-first cascade. Stage 1 sends the photo and picks one of the category groups (Moda Feminina,
 * Moda Infantil, Bebês, ...); the photo is what tells a girl's dress from a woman's. When the group
 * is clear, stage 2 picks among that group's few categories from text, or is skipped when the group
 * has one category. When the group is unclear or the photo is unusable, the product falls back to
 * the text configuration (51-category Choice + audience Noul). Most products never ask every question.
 */
const GROUPS = new Map<string, Category[]>();
for (const c of categories) GROUPS.set(c.category_group, [...(GROUPS.get(c.category_group) ?? []), c]);

// ponytail: one fixed cut; tune on a labeled sample (it trades fallback rate against group errors).
const GROUP_CONFIDENCE = 0.8;

const groupQuestion = {
  type: "choice" as const,
  instructions:
    "Which store department does `product` belong to? Look at `photo` to see what the item is and who it " +
    "is for: Moda Infantil and Bebês are for children, Moda Feminina and Moda Masculina are for adults.",
  criteria: Object.fromEntries([...GROUPS].map(([group, cs]) => [group, `Categorias: ${cs.map((c) => c.name).join("; ")}`])),
};

const categoryQuestion = (options: Category[]) => ({
  type: "choice" as const,
  instructions: "Which store category best fits `product`? Decide by what the item actually is.",
  criteria: Object.fromEntries(options.map((c) => [c.name, c.description])),
});

const top3 = (probs: Record<string, number> = {}) =>
  Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, p]) => ({ category, p }));

export async function classifyCascade(product: Product, signal: AbortSignal): Promise<Classification> {
  const started = Date.now();
  const fallback = async (reason: string, spent = 0, extra: Partial<Classification> = {}) => {
    const r = await classify(product, signal, "generic");
    return { ...r, ...extra, path: "text" as const, fallbackReason: reason, cost: r.cost + spent, ms: Date.now() - started };
  };

  const photo = await fetchImagePart(product.image_url, signal);
  if ("problem" in photo) return fallback(photo.problem);

  let s1;
  try {
    s1 = await systemOneJson(
      { state: { product: productText(product), photo }, questions: { group: groupQuestion } },
      signal,
    );
  } catch (error) {
    // Jev can still reject a photo that passes the documented limits ("Invalid image dimensions" on a
    // 569×276 progressive JPEG). Transient and fatal errors go up to the pool; anything else → text.
    if (signal.aborted || error instanceof RetryableError || error instanceof FatalError) throw error;
    const reason = [...(error as Error).message.matchAll(/message\\?":\\?"([^"\\]+)/g)].at(-1)?.[1] ?? "erro";
    return fallback(`imagem recusada pelo Jev (${reason})`);
  }
  const group = s1.answers.group!.choice!;
  const groupConfidence = s1.answers.group!.confidence ?? 0;
  const seen = { group, groupConfidence };
  if (groupConfidence < GROUP_CONFIDENCE) {
    return fallback(`grupo incerto na imagem (${group}, ${groupConfidence.toFixed(2)})`, s1.cost, seen);
  }

  const options = GROUPS.get(group)!;
  const done = { ...seen, path: "image" as const, model: s1.model };
  if (options.length === 1) {
    return { ...done, category: options[0]!.name, confidence: groupConfidence,
      top: [{ category: options[0]!.name, p: groupConfidence }], cost: s1.cost, ms: Date.now() - started };
  }

  // ponytail: a retryable failure here re-runs the whole cascade (download + stage 1); fine at this volume.
  const s2 = await systemOneJson(
    { state: { product: productText(product) }, questions: { category: categoryQuestion(options) } },
    signal,
  );
  const a = s2.answers.category!;
  return { ...done, category: a.choice!, confidence: a.confidence ?? 0, top: top3(a.probabilities),
    cost: s1.cost + s2.cost, ms: Date.now() - started };
}
