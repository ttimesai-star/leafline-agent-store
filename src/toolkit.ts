// Merchant-side PayPal calls through the official PayPal Agent Toolkit (@paypal/agent-toolkit 1.11.0).
//
// What goes through the Toolkit: order status (get_order), PayPal disputes (list_disputes, get_dispute,
// accept_dispute_claim) and refunds (create_refund, get_refund). The Toolkit's allow-list is the single place
// that says which PayPal operations this server may perform at all: 6 of its ~45 tools.
//
// What stays on our own Orders v2 client (src/paypal.ts) and why: the Toolkit's create_order has no
// custom_id / reference_id / item sku, so an order could not carry the agent session and mandate it was
// created under; its pay_order (capture) sends no PayPal-Request-Id, so a reloaded return URL could not be
// made idempotent.
//
// Three behaviours of Toolkit 1.11.0 (read from its source, not its README) that this wrapper guards:
//  1. PayPalAPI.run / handleToolCall execute ANY method name; the configured actions only filter the tool
//     list. We refuse names outside our allow-list before calling run().
//  2. The access token is cached for the life of the instance and never refreshed. We pass our own
//     refreshed OAuth token (src/paypal.ts) and rebuild the Toolkit API when the token changes.
//  3. run() never throws: errors come back as a JSON string ({ok:false,status,code,message} or
//     {error:{message}}). We turn them into PayPalError so callers see a failure, not a "result".
// Idempotency: PayPal-Request-Id is taken from the Toolkit context (request_id), so each refund gets its own
// short-lived PayPalAPI with request_id = refund-<claimId>.
import { PayPalAPI, PayPalMCPToolkit } from "@paypal/agent-toolkit/mcp";
import { PayPalError, assertOrderId, redact } from "./paypal.ts";

export const TOOLKIT_VERSION = "1.11.0";

/** Toolkit configuration: the only PayPal operations the merchant side may perform through the Toolkit. */
export const MERCHANT_ACTIONS = {
  orders: { get: true },
  disputes: { list: true, get: true, create: true }, // create = accept_dispute_claim in Toolkit 1.11.0
  payments: { createRefund: true, getRefunds: true },
} as const;

export const MERCHANT_TOOLS = ["get_order", "list_disputes", "get_dispute", "accept_dispute_claim", "create_refund", "get_refund"] as const;
export type MerchantTool = (typeof MERCHANT_TOOLS)[number];

const CAPTURE_ID_RE = /^[A-Z0-9]{8,32}$/;
const REFUND_ID_RE = /^[A-Z0-9]{8,32}$/;
const DISPUTE_ID_RE = /^PP-[A-Z0-9-]{6,40}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,108}$/;

export interface ToolkitCall {
  at: string;
  tool: MerchantTool;
  ok: boolean;
  ms: number;
  status?: number;
  note?: string;
}

/** Minimal surface of the Toolkit's PayPalAPI we rely on (lets tests inject a fake). */
export interface ToolkitApi {
  run(method: string, arg: unknown): Promise<string>;
}

export interface ToolkitOptions {
  /** Returns a valid sandbox OAuth token (our PayPalClient refreshes it). */
  token: () => Promise<string>;
  /** Builds a Toolkit API for a token (+ optional PayPal-Request-Id). Default: the real Toolkit, sandbox. */
  makeApi?: (token: string, requestId?: string) => ToolkitApi;
  /** Secrets to strip from error text. */
  secrets?: Array<string | undefined>;
  logSize?: number;
}

/** The tool names our configuration enables, as computed by the Toolkit itself (so a Toolkit upgrade that
 * renames or regroups a tool shows up as a failing check, not as a silently missing capability). */
export function enabledToolkitTools(): string[] {
  const kit = new PayPalMCPToolkit({ accessToken: "unused", configuration: { actions: MERCHANT_ACTIONS as any, context: { sandbox: true } } });
  return kit.getTools().map((t) => t.method);
}

export function realToolkitApi(token: string, requestId?: string): ToolkitApi {
  const api = new PayPalAPI(token, { sandbox: true, ...(requestId ? { request_id: requestId } : {}) });
  const base = api.paypalClient.getBaseUrl();
  // Defence in depth: the Toolkit picks its host from context.sandbox; refuse anything that is not sandbox.
  if (!/^https:\/\/api(-m)?\.sandbox\.paypal\.com$/.test(base)) throw new Error(`PayPal Agent Toolkit is not on sandbox (${base})`);
  return api;
}

export class ToolkitPayments {
  private opts: Required<Omit<ToolkitOptions, "secrets">> & { secrets: Array<string | undefined> };
  private cached: { token: string; api: ToolkitApi } | null = null;
  private log: ToolkitCall[] = [];

  constructor(opts: ToolkitOptions) {
    this.opts = { makeApi: realToolkitApi, logSize: 200, secrets: [], ...opts };
  }

  private async api(requestId?: string): Promise<ToolkitApi> {
    const token = await this.opts.token();
    if (requestId) return this.opts.makeApi(token, requestId);
    if (!this.cached || this.cached.token !== token) this.cached = { token, api: this.opts.makeApi(token) };
    return this.cached.api;
  }

  /** Run one allowed Toolkit tool and return its parsed result; failures become PayPalError. */
  async call(tool: MerchantTool, args: Record<string, unknown>, requestId?: string): Promise<any> {
    if (!(MERCHANT_TOOLS as readonly string[]).includes(tool)) throw new Error(`Toolkit tool not allowed: ${String(tool).slice(0, 40)}`);
    if (requestId !== undefined && !REQUEST_ID_RE.test(requestId)) throw new Error("invalid PayPal-Request-Id");
    const started = Date.now();
    const done = (ok: boolean, status?: number, note?: string) => {
      this.log.push({ at: new Date().toISOString(), tool, ok, ms: Date.now() - started, status, note });
      if (this.log.length > this.opts.logSize) this.log.splice(0, this.log.length - this.opts.logSize);
    };
    let raw: string;
    try {
      raw = await (await this.api(requestId)).run(tool, args);
    } catch (e) {
      const msg = this.clean(`${tool} failed: ${(e as Error)?.message ?? e}`);
      done(false, 0, msg.slice(0, 120));
      throw new PayPalError(msg, 0);
    }
    let out: any;
    try {
      out = JSON.parse(raw);
    } catch {
      done(false, 0, "non-JSON Toolkit result");
      throw new PayPalError(`${tool}: non-JSON Toolkit result`, 0);
    }
    const err = toolkitError(out);
    if (err) {
      const msg = this.clean(`${tool}: ${err.status ? "HTTP " + err.status + " " : ""}${err.message}`);
      done(false, err.status, msg.slice(0, 120));
      // A stale token surfaces as 401: drop the cached API so the next call rebuilds it.
      if (err.status === 401) this.cached = null;
      throw new PayPalError(msg, err.status ?? 0, undefined, err.code);
    }
    done(true);
    return out;
  }

  private clean(s: string): string {
    return redact(s, [...this.opts.secrets, this.cached?.token]);
  }

  /** Recent Toolkit calls (tool, ok, latency) for the merchant panel. No arguments or results are kept. */
  calls(limit = 50): ToolkitCall[] {
    return this.log.slice(-Math.max(1, Math.min(limit, this.opts.logSize))).reverse();
  }

  async getOrder(id: string): Promise<any> {
    return this.call("get_order", { id: assertOrderId(id) });
  }

  async listDisputes(pageSize = 20): Promise<any> {
    const n = Math.min(Math.max(Math.trunc(pageSize) || 20, 1), 50);
    return this.call("list_disputes", { page_size: n });
  }

  async getDispute(id: string): Promise<any> {
    if (!DISPUTE_ID_RE.test(id)) throw new Error("invalid PayPal dispute id");
    return this.call("get_dispute", { dispute_id: id });
  }

  /** Accept the buyer's claim on a PayPal-side dispute (PayPal refunds the buyer). */
  async acceptDisputeClaim(id: string, note: string): Promise<any> {
    if (!DISPUTE_ID_RE.test(id)) throw new Error("invalid PayPal dispute id");
    const n = String(note ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 2000) || "Claim accepted by the merchant.";
    return this.call("accept_dispute_claim", { dispute_id: id, note: n });
  }

  /** Full refund when amount is omitted. Idempotent per requestId (PayPal-Request-Id). */
  async refundCapture(captureId: string, opts: { amount?: string; currency?: string; note?: string } = {}, requestId?: string): Promise<any> {
    if (!CAPTURE_ID_RE.test(captureId)) throw new Error("invalid PayPal capture id");
    const args: Record<string, unknown> = { capture_id: captureId };
    if (opts.amount) args.amount = { value: opts.amount, currency_code: opts.currency ?? "USD" };
    if (opts.note) args.note_to_payer = opts.note.slice(0, 255);
    return this.call("create_refund", args, requestId);
  }

  async getRefund(id: string): Promise<any> {
    if (!REFUND_ID_RE.test(id)) throw new Error("invalid PayPal refund id");
    return this.call("get_refund", { refund_id: id });
  }
}

/** Toolkit 1.11.0 error shapes: LlmError.toJSON() = {ok:false,status,code,message}; generic = {error:{message}}. */
export function toolkitError(out: any): { status?: number; code?: string; message: string } | null {
  if (out && typeof out === "object" && out.ok === false) {
    return { status: Number.isFinite(out.status) ? Number(out.status) : undefined, code: typeof out.code === "string" ? out.code : undefined, message: String(out.message ?? "error").slice(0, 200) };
  }
  if (out && typeof out === "object" && out.error && typeof out.error === "object" && !Array.isArray(out.error)) {
    return { message: String(out.error.message ?? "error").slice(0, 200) };
  }
  if (out === null || out === undefined) return { message: "empty Toolkit result" };
  return null;
}
