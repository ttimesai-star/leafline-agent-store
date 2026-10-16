// Demo data housekeeping. The store mirrors its order book to data/orders.json and the agent journal to
// data/agent_journal.jsonl. Browser E2E runs leave many abandoned orders (created, never approved) behind;
// before recording a demo they are filtered out, and the remaining real sandbox orders can be exported as a
// seed for a fresh deployment (Render's disk is empty after every deploy / restart).
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { OrderRecord, ClaimRecord } from "./orders.ts";
import type { JournalEntry } from "./journal.ts";

export type CleanMode = "paid" | "wipe";

export interface DemoData {
  orders: OrderRecord[];
  claims: ClaimRecord[];
  journal: JournalEntry[];
}

/** Orders that took money (or gave it back) are kept; abandoned / cancelled checkouts are test noise. */
const KEEP_STATUSES = new Set(["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED"]);

export function cleanDemoData(d: DemoData, mode: CleanMode): DemoData & { dropped: { orders: number; claims: number; journal: number } } {
  if (mode === "wipe") {
    return { orders: [], claims: [], journal: [], dropped: { orders: d.orders.length, claims: d.claims.length, journal: d.journal.length } };
  }
  const orders = d.orders.filter((o) => KEEP_STATUSES.has(o.status) || Boolean(o.captureId));
  const kept = new Set(orders.map((o) => o.orderId));
  const claims = d.claims.filter((c) => kept.has(c.orderId));
  // Agent sessions that produced a kept order stay whole (searches, refusals by the mandate, the order itself):
  // that trail is the order's evidence. Sessions that never produced a paid order are dropped.
  const sessions = new Set(orders.map((o) => o.session).filter((s): s is string => Boolean(s)));
  for (const e of d.journal) if (e.orderId && kept.has(e.orderId)) sessions.add(e.session);
  const journal = d.journal.filter((e) => sessions.has(e.session));
  return {
    orders,
    claims,
    journal,
    dropped: { orders: d.orders.length - orders.length, claims: d.claims.length - claims.length, journal: d.journal.length - journal.length },
  };
}

export const ORDERS_FILE = "orders.json";
export const JOURNAL_FILE = "agent_journal.jsonl";

export function readDemoData(dir: string): DemoData {
  const of = join(dir, ORDERS_FILE);
  const jf = join(dir, JOURNAL_FILE);
  const book = existsSync(of) ? JSON.parse(readFileSync(of, "utf8")) : {};
  const journal: JournalEntry[] = [];
  if (existsSync(jf)) {
    for (const line of readFileSync(jf, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        journal.push(JSON.parse(line));
      } catch {
        // partial line: skip
      }
    }
  }
  return { orders: book.orders ?? [], claims: book.claims ?? [], journal };
}

function safeReplaceFileSync(tmp: string, target: string) {
  try {
    renameSync(tmp, target);
  } catch (e: any) {
    if (e?.code === "EXDEV" || e?.code === "EPERM" || e?.code === "EBUSY" || e?.code === "EEXIST") {
      copyFileSync(tmp, target);
      try { unlinkSync(tmp); } catch {}
    } else {
      throw e;
    }
  }
}

export function writeDemoData(dir: string, d: DemoData): void {
  mkdirSync(dir, { recursive: true });
  const of = join(dir, ORDERS_FILE);
  const jf = join(dir, JOURNAL_FILE);
  writeFileSync(of + ".tmp", JSON.stringify({ orders: d.orders, claims: d.claims }));
  safeReplaceFileSync(of + ".tmp", of);
  const jContent = d.journal.map((e) => JSON.stringify(e)).join("\n") + (d.journal.length ? "\n" : "");
  writeFileSync(jf + ".tmp", jContent);
  safeReplaceFileSync(jf + ".tmp", jf);
}

/**
 * Fresh deployment: when the data directory has no order book yet, copy the seed (real sandbox orders exported
 * by scripts/reset_demo_data.ts --export-seed). Returns how many orders were seeded (0 = nothing done).
 */
export function seedIfEmpty(dataDir: string, seedDir: string | undefined): number {
  if (!seedDir || existsSync(join(dataDir, ORDERS_FILE)) || !existsSync(join(seedDir, ORDERS_FILE))) return 0;
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(join(seedDir, ORDERS_FILE), join(dataDir, ORDERS_FILE));
  const targetJournal = join(dataDir, JOURNAL_FILE);
  const seedJournal = join(seedDir, JOURNAL_FILE);
  if (!existsSync(targetJournal) && existsSync(seedJournal)) {
    copyFileSync(seedJournal, targetJournal);
  }
  try {
    return (JSON.parse(readFileSync(join(dataDir, ORDERS_FILE), "utf8")).orders ?? []).length;
  } catch {
    return 0;
  }
}
