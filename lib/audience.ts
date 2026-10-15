/**
 * Audience experiment: a Noul asked in the same request as the category Choice (parallel, no extra
 * latency). Code then swaps between the adult and the kids' version of the category.
 * "brands" adds kids' brand names; 4 of them were taken from the Posthaus data itself, so its
 * Posthaus score is optimistic (leakage).
 */
export const VARIANTS = ["off", "generic", "brands", "image"] as const;
export type Variant = (typeof VARIANTS)[number];
export const isVariant = (v: unknown): v is Variant => (VARIANTS as readonly unknown[]).includes(v);

const CHILD_SIGNS =
  "Children's or juvenile item. Signs: children's sizes given as numbers or ages (for example " +
  "'tamanho 2 ao 14', '4 anos', '36M'); words such as infantil, juvenil, kids, menino, menina, bebê, " +
  "'para as pequenas', 'para os pequenos'; playful child-oriented wording (fofura, magia, descobertas).";
const KIDS_BRANDS =
  " Children's brands also count as a sign: Rovi Kids, Trick Nick, Alakazoo, Molekinho, Brandili, Kyly, " +
  "Hering Kids, Malwee Kids, Lilica Ripilica, Tigor T. Tigre, Marisol.";

export const audienceQuestion = (variant: Exclude<Variant, "off">) => ({
  type: "noul" as const,
  instructions: "Is `product` made for children or teens (a kids' or juvenile line) rather than for adults?",
  criteria: {
    true: CHILD_SIGNS + (variant === "brands" ? KIDS_BRANDS : ""),
    false:
      "Adult item: adult sizes (PP to GG, 36 to 48), words such as mulher, homem, adulto, or no sign of a " +
      "child audience. 'Feminina' or 'masculina' alone does not mean adult: stores also use these words " +
      "for girls' and boys' clothes.",
  },
});

const ADULT_TO_KIDS: Record<string, string> = {
  "Roupas Femininas": "Roupas Infantis",
  "Roupas Masculinas": "Roupas Infantis",
  "Lingerie e Moda Íntima": "Roupas Infantis",
  "Calçados Femininos": "Calçados Infantis",
  "Calçados Masculinos": "Calçados Infantis",
  "Bolsas, Carteiras e Acessórios Femininos": "Acessórios Infantis",
  "Acessórios Masculinos": "Acessórios Infantis",
};
// ponytail: fixed 0.5 cut; tune on a labeled sample from other kids' stores.
const CHILD_THRESHOLD = 0.5;

/**
 * Swap an adult category to its kids' version when the audience Noul says child. One direction
 * only: on Posthaus the reverse swap (kids' → adult when the Noul is low) caused every regression
 * (school shirt, licensed character set, kids' brand), while the Choice alone already gets
 * explicit kid cues right.
 */
export function applyAudience(category: string, children: number): string {
  return children >= CHILD_THRESHOLD ? (ADULT_TO_KIDS[category] ?? category) : category;
}
