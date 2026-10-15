import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAudience } from "./audience.ts";

test("adult category flips to kids' version when the audience Noul says child", () => {
  assert.equal(applyAudience("Roupas Femininas", 0.9), "Roupas Infantis");
  assert.equal(applyAudience("Calçados Masculinos", 0.5), "Calçados Infantis");
  assert.equal(applyAudience("Roupas Femininas", 0.2), "Roupas Femininas");
});

test("kids' category is never flipped to adult, even with a low Noul", () => {
  assert.equal(applyAudience("Roupas Infantis", 0.1), "Roupas Infantis");
  assert.equal(applyAudience("Calçados Infantis", 0.0), "Calçados Infantis");
});

test("categories without an age counterpart never change", () => {
  assert.equal(applyAudience("Pet Shop", 0.99), "Pet Shop");
  assert.equal(applyAudience("Esportes e Fitness", 0.99), "Esportes e Fitness");
});
