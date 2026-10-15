import { readFile } from "node:fs/promises";
import path from "node:path";

export const SETS = ["baseline", "posthaus", "validacao", "carga"] as const;
export type SetName = (typeof SETS)[number];

export const isSet = (s: string): s is SetName => (SETS as readonly string[]).includes(s);

export interface Product {
  id: string;
  advertiser_name: string;
  marketplace_name: string;
  marketplace_category_name: string;
  title: string;
  brand_name: string;
  description: string;
  short_description: string;
  image_url: string;
  price: number | null;
  /** Category assigned by the current embeddings + rerank classifier. */
  category_name: string;
  validation_mode: string;
}

const cache = new Map<SetName, Promise<Product[]>>();

/** Datasets are generated once by `npm run import`. */
export function loadProducts(set: SetName): Promise<Product[]> {
  let p = cache.get(set);
  if (!p) {
    p = readFile(path.join(process.cwd(), "data", `${set}.json`), "utf8").then(JSON.parse);
    p.catch(() => cache.delete(set));
    cache.set(set, p);
  }
  return p;
}
