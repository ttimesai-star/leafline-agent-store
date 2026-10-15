import { test } from "node:test";
import assert from "node:assert/strict";
import { searchProducts, priceOrder } from "../src/catalog.ts";

test("search ranks by matched terms and respects max price", () => {
  const r = searchProducts("green tea");
  assert.equal(r[0].sku, "TEA-SENCHA-80");
  assert.ok(searchProducts("tea", { maxPrice: 12 }).every((p) => Number(p.price) <= 12));
  assert.equal(searchProducts("zzz-nothing").length, 0);
  assert.ok(searchProducts("", { limit: 100 }).length <= 20);
});

test("priceOrder computes totals server-side and merges duplicate lines", () => {
  const r = priceOrder([
    { sku: "TEA-SENCHA-80", quantity: 2 },
    { sku: "MUG-STONE-350", quantity: 1 },
    { sku: "TEA-SENCHA-80", quantity: 1 },
  ]);
  assert.equal(r.total, "52.50");
  assert.equal(r.items.length, 2);
  assert.equal(r.items.find((i) => i.sku === "TEA-SENCHA-80")!.quantity, 3);
});

test("priceOrder rejects bad input", () => {
  assert.throws(() => priceOrder([]), /non-empty/);
  assert.throws(() => priceOrder([{ sku: "NOPE", quantity: 1 }]), /unknown sku/);
  assert.throws(() => priceOrder([{ sku: "TEA-SENCHA-80", quantity: 0 }]), /quantity/);
  assert.throws(() => priceOrder([{ sku: "TEA-SENCHA-80", quantity: 1.5 }]), /quantity/);
  assert.throws(() => priceOrder([{ sku: "TEA-SENCHA-80", quantity: 6 }, { sku: "TEA-SENCHA-80", quantity: 6 }]), /quantity/);
  assert.throws(() => priceOrder([{ sku: "KETTLE-GOOSE-1L", quantity: 6 }]), /exceeds demo cap|stock/);
  assert.throws(() => priceOrder("x" as any), /non-empty/);
});
