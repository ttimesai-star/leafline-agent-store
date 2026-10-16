// Clean the demo order book before recording (E2E runs leave abandoned test orders behind).
//
// Usage (stop the store first: a running server keeps its own copy in memory and would write it back):
//   node scripts/reset_demo_data.ts                    dry run: what would be kept / dropped
//   node scripts/reset_demo_data.ts --apply            keep paid / refunded orders, their claims and agent trails
//   node scripts/reset_demo_data.ts --apply --wipe     start from an empty order book and journal
//   node scripts/reset_demo_data.ts --export-seed demo/seed   also write the cleaned set as a deployment seed
// Options: --data <dir> (default data/), --url <store url> to check it is stopped (default http://localhost:$PORT|8787),
//          --force (skip the running-server check).
// Nothing is deleted: the previous files are moved to <data>/archive/<timestamp>/.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanDemoData, readDemoData, writeDemoData, ORDERS_FILE, JOURNAL_FILE } from "../src/demo_data.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dataDir = resolve(opt("--data") ?? join(HERE, "..", "data"));
const apply = args.includes("--apply");
const mode = args.includes("--wipe") ? "wipe" : "paid";
const seedDir = opt("--export-seed");
const url = (opt("--url") ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, "");

async function serverRunning(): Promise<boolean> {
  try {
    const r = await fetch(url + "/api/health", { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

const before = readDemoData(dataDir);
const after = cleanDemoData(before, mode);
const count = (d: { orders: unknown[]; claims: unknown[]; journal: unknown[] }) => `${d.orders.length} orders, ${d.claims.length} claims, ${d.journal.length} journal entries`;
console.log(`data: ${dataDir}`);
console.log(`now:   ${count(before)}`);
console.log(`after: ${count(after)} (mode ${mode}; drops ${after.dropped.orders} orders, ${after.dropped.claims} claims, ${after.dropped.journal} journal entries)`);

if (seedDir) {
  writeDemoData(resolve(seedDir), after);
  console.log(`seed written to ${resolve(seedDir)}`);
}

if (!apply) {
  console.log("dry run: nothing changed (add --apply)");
  process.exit(0);
}
if (!args.includes("--force") && (await serverRunning())) {
  console.error(`the store answers on ${url}: stop it first (it would write its in-memory copy back), or pass --force`);
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archive = join(dataDir, "archive", stamp);
mkdirSync(archive, { recursive: true });
for (const f of [ORDERS_FILE, JOURNAL_FILE]) if (existsSync(join(dataDir, f))) renameSync(join(dataDir, f), join(archive, f));
writeDemoData(dataDir, after);
console.log(`applied; previous files moved to ${archive}`);
