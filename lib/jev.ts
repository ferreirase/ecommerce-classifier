import { readFileSync } from "node:fs";
import path from "node:path";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  TypeSafeClient,
  type ChoiceQuestion,
  type ChoiceResponse,
  type NoulResponse,
  type Questions,
} from "@typesafe-ai/sdk";
import type { Product } from "./data";
import { applyAudience, audienceQuestion, type Variant } from "./audience";
import { FatalError, RetryableError } from "./pool";

export interface Category {
  name: string;
  description: string;
  category_group: string;
  is_enabled: boolean;
}

export const categories: Category[] = JSON.parse(
  readFileSync(path.join(process.cwd(), "categorias.txt"), "utf8"),
).filter((c: Category) => c.is_enabled);

/** Same question for every product: one Choice over every enabled category. */
const categoryQuestion: ChoiceQuestion = {
  type: "choice",
  instructions:
    "Which store category best fits `product`? Decide by what the item actually is and who it is for " +
    "(women, men, children, babies), using the title first and the description as support.",
  criteria: Object.fromEntries(
    categories.map((c) => [c.name, { group: c.category_group, description: c.description }]),
  ),
};

export const MODEL = process.env.JEV_MODEL ?? "jev-latest";
export const PRICE_PER_INPUT_TOKEN = 0.042 / 1_000_000;
const BASE_URL = process.env.JEV_BASE_URL ?? "https://openrouter.ai/api";

let client: TypeSafeClient | undefined;
function getClient() {
  if (!process.env.OPENROUTER_API_KEY) throw new FatalError("OPENROUTER_API_KEY not set in .env.local");
  // Retries are disabled here: the pool owns them so a 429 pauses every worker, not just one.
  client ??= new TypeSafeClient({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: BASE_URL,
    retry: { maxRetries: 0 },
    timeout: 30_000,
  });
  return client;
}

/** The text Jev sees. category_name is the label under test: never send it. */
export function productText(product: Product) {
  return {
    title: product.title,
    description: product.description || product.short_description,
    brand: product.brand_name,
    store: product.advertiser_name || product.marketplace_name,
    store_category: product.marketplace_category_name,
  };
}

export interface Classification {
  category: string;
  confidence: number;
  top: { category: string; p: number }[];
  model: string;
  cost: number;
  ms: number;
  /** Audience experiment only: P(made for children) and the category before the swap. */
  children?: number;
  adjustedFrom?: string;
  /** Image cascade only: which path answered, and why it fell back to text. */
  path?: "image" | "text";
  fallbackReason?: string;
  group?: string;
  groupConfidence?: number;
}

export async function classify(product: Product, signal: AbortSignal, variant: Variant = "off"): Promise<Classification> {
  const started = Date.now();
  try {
    const questions: Questions = { category: categoryQuestion };
    if (variant !== "off") questions.children = audienceQuestion(variant);
    const res = await getClient().systemOne(
      {
        model: MODEL,
        state: { product: productText(product) },
        questions,
      },
      { signal },
    );
    const answer = res.answers.category as ChoiceResponse;
    const probs = answer.probabilities as Record<string, number>;
    const usage = res.usage as { input_tokens: number | null; cost?: number };
    const children = (res.answers.children as NoulResponse | undefined)?.noul;
    const category = children === undefined ? answer.choice : applyAudience(answer.choice, children);
    return {
      category,
      confidence: answer.confidence,
      ...(children !== undefined && { children, ...(category !== answer.choice && { adjustedFrom: answer.choice }) }),
      top: Object.entries(probs)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([category, p]) => ({ category, p })),
      model: res.model,
      cost: usage.cost ?? (usage.input_tokens ?? 0) * PRICE_PER_INPUT_TOKEN,
      ms: Date.now() - started,
    };
  } catch (error) {
    throw mapError(error);
  }
}

function mapError(error: unknown): unknown {
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return new RetryableError(error.message);
  }
  if (!(error instanceof APIError)) return error;
  return mapStatus(error.status, error.headers, error.body, error.message);
}

function mapStatus(status: number, headers: Headers, body: unknown, message: string): Error {
  const retryAfterMs =
    Number(headers.get("retry-after-ms")) || Number(headers.get("retry-after")) * 1_000 || undefined;
  const inFlightBudget = status === 402 && JSON.stringify(body ?? "").includes("openrouter_in_flight_budget");
  if (status === 408 || status === 429 || status >= 500 || inFlightBudget) {
    return new RetryableError(`Jev ${status}`, retryAfterMs, status);
  }
  if (status === 401 || status === 402 || status === 403) {
    return new FatalError(`Jev ${status}: ${message}`);
  }
  return new Error(`Jev ${status}: ${message}`);
}

export interface RawResult {
  model: string;
  answers: Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number; noul?: number }>;
  cost: number;
}

/**
 * Plain JSON call to the System One endpoint, used for requests with images. The SDK uploads
 * images as multipart, which OpenRouter rejects; Jev reads `image_url` parts placed in `state`.
 */
export async function systemOneJson(
  body: { state: unknown; questions: Questions },
  signal: AbortSignal,
): Promise<RawResult> {
  if (!process.env.OPENROUTER_API_KEY) throw new FatalError("OPENROUTER_API_KEY not set in .env.local");
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${BASE_URL}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "TypeSafe-Danger-Zone-Images": "true",
      },
      body: JSON.stringify({ model: MODEL, ...body }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    text = await res.text();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new RetryableError(`Jev request failed: ${(error as Error).message}`);
  }
  if (!res.ok) throw mapStatus(res.status, res.headers, text, text.slice(0, 200));
  const json = JSON.parse(text);
  return {
    model: json.model,
    answers: json.answers,
    cost: json.usage?.cost ?? (json.usage?.input_tokens ?? 0) * PRICE_PER_INPUT_TOKEN,
  };
}
