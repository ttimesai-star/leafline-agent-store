// Demo catalog. Prices are decided server-side only; clients (humans or agents) send sku + quantity.

export interface Product {
  sku: string;
  name: string;
  description: string;
  price: string; // USD, two decimals
  stock: number;
  tags: string[];
}

export const CURRENCY = "USD";
export const MAX_QTY = 10;
export const MAX_ORDER_CENTS = 200_00; // sandbox demo cap

export const PRODUCTS: Product[] = [
  { sku: "TEA-OOLONG-100", name: "Milk Oolong Tea, 100 g", description: "Loose-leaf Taiwanese oolong with a creamy finish.", price: "14.00", stock: 25, tags: ["tea", "oolong", "loose-leaf"] },
  { sku: "TEA-SENCHA-80", name: "Organic Sencha, 80 g", description: "Japanese green tea, first flush, steamed.", price: "11.50", stock: 40, tags: ["tea", "green", "organic"] },
  { sku: "MUG-STONE-350", name: "Stoneware Mug 350 ml", description: "Hand-glazed mug, dishwasher safe.", price: "18.00", stock: 12, tags: ["mug", "ceramic", "gift"] },
  { sku: "KETTLE-GOOSE-1L", name: "Gooseneck Kettle 1 L", description: "Stainless steel pour-over kettle with thermometer.", price: "39.00", stock: 6, tags: ["kettle", "pour-over", "coffee", "tea"] },
  { sku: "COFFEE-ETH-250", name: "Ethiopia Yirgacheffe Beans, 250 g", description: "Light roast, floral and citrus notes.", price: "16.50", stock: 30, tags: ["coffee", "beans", "light-roast"] },
  { sku: "GIFT-CARD-25", name: "Gift Card 25 USD", description: "Digital gift card delivered by email.", price: "25.00", stock: 999, tags: ["gift", "digital"] },
];

export function findProduct(sku: string): Product | undefined {
  return PRODUCTS.find((p) => p.sku === sku);
}

export function searchProducts(query: string, opts: { maxPrice?: number; limit?: number } = {}): Product[] {
  const terms = String(query ?? "").toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
  const scored = PRODUCTS.map((p) => {
    const hay = `${p.name} ${p.description} ${p.tags.join(" ")} ${p.sku}`.toLowerCase();
    const score = terms.length ? terms.filter((t) => hay.includes(t)).length : 1;
    return { p, score };
  })
    .filter(({ p, score }) => score > 0 && p.stock > 0 && (opts.maxPrice === undefined || Number(p.price) <= opts.maxPrice))
    .sort((a, b) => b.score - a.score || Number(a.p.price) - Number(b.p.price));
  return scored.slice(0, limit).map(({ p }) => p);
}

export interface PricedLine {
  sku: string;
  name: string;
  unitPrice: string;
  quantity: number;
}

const toCents = (s: string) => Math.round(Number(s) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);

/** Validate requested lines against the catalog and compute the total. Throws on any invalid input. */
export function priceOrder(lines: Array<{ sku?: unknown; quantity?: unknown }>): { items: PricedLine[]; total: string; currency: string } {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 10) throw new Error("items must be a non-empty array (max 10 lines)");
  const merged = new Map<string, number>();
  for (const l of lines) {
    const sku = typeof l?.sku === "string" ? l.sku : "";
    const qty = Number(l?.quantity ?? 1);
    if (!findProduct(sku)) throw new Error(`unknown sku: ${sku.slice(0, 40)}`);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new Error(`quantity must be an integer 1..${MAX_QTY}`);
    merged.set(sku, (merged.get(sku) ?? 0) + qty);
  }
  let cents = 0;
  const items: PricedLine[] = [];
  for (const [sku, quantity] of merged) {
    const p = findProduct(sku)!;
    if (quantity > MAX_QTY) throw new Error(`quantity must be an integer 1..${MAX_QTY}`);
    if (quantity > p.stock) throw new Error(`not enough stock for ${sku}`);
    cents += toCents(p.price) * quantity;
    items.push({ sku, name: p.name, unitPrice: p.price, quantity });
  }
  if (cents > MAX_ORDER_CENTS) throw new Error(`order total exceeds demo cap ${fromCents(MAX_ORDER_CENTS)} ${CURRENCY}`);
  return { items, total: fromCents(cents), currency: CURRENCY };
}
