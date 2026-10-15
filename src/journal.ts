// Agent call journal: every WebMCP tool call that reaches the server is recorded per agent session,
// and the session is linked to the PayPal order it produced. receipt(orderId) = the agent's trail
// for that order (what it searched, what it chose, what it paid) — usable later as dispute evidence.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
  ts: string;
  session: string;
  tool: string;
  args: unknown;
  ok: boolean;
  summary: string;
  orderId?: string;
  ms?: number;
}

const SENSITIVE = /pass|secret|token|authorization|card|cvv/i;
const SESSION_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function sanitizeArgs(v: unknown, depth = 0): unknown {
  if (depth > 3) return "[depth]";
  if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => sanitizeArgs(x, depth + 1));
  if (typeof v === "object" && v) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v).slice(0, 20)) out[k] = SENSITIVE.test(k) ? "***" : sanitizeArgs(val, depth + 1);
    return out;
  }
  return undefined;
}

export function validSession(s: unknown): s is string {
  return typeof s === "string" && SESSION_RE.test(s);
}

export class AgentJournal {
  private entries: JournalEntry[] = [];
  private orderSession = new Map<string, string>();
  private file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  record(e: Omit<JournalEntry, "ts" | "args"> & { args: unknown }, now: Date = new Date()): JournalEntry {
    const entry: JournalEntry = { ...e, ts: now.toISOString(), args: sanitizeArgs(e.args) };
    this.entries.push(entry);
    if (entry.orderId && !this.orderSession.has(entry.orderId)) this.orderSession.set(entry.orderId, entry.session);
    if (this.file) appendFileSync(this.file, JSON.stringify(entry) + "\n");
    return entry;
  }

  /** All calls of the agent session that created the order, up to and including calls about that order. */
  receipt(orderId: string): { orderId: string; session: string | null; calls: JournalEntry[] } {
    const session = this.orderSession.get(orderId) ?? null;
    if (!session) return { orderId, session: null, calls: [] };
    const calls = this.entries.filter((e) => e.session === session && (!e.orderId || e.orderId === orderId));
    return { orderId, session, calls };
  }

  stats(): { calls: number; sessions: number; orders: number } {
    return { calls: this.entries.length, sessions: new Set(this.entries.map((e) => e.session)).size, orders: this.orderSession.size };
  }
}
