// Minimal PayPal Orders v2 client. Sandbox only: any non-sandbox base URL is rejected.
// Secrets come from env (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET), never from the repo.

export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
const ORDER_ID_RE = /^[A-Z0-9]{8,32}$/;
const CAPTURE_ID_RE = /^[A-Z0-9]{8,32}$/;

export interface PayPalConfig {
  clientId: string;
  secret: string;
  base?: string;
  fetchImpl?: typeof fetch;
}

export interface OrderItem {
  sku: string;
  name: string;
  unitPrice: string; // "12.50"
  quantity: number;
}

export interface CreateOrderInput {
  currency: string;
  items: OrderItem[];
  total: string;
  referenceId?: string;
  customId?: string;
  returnUrl?: string;
  cancelUrl?: string;
}

export class PayPalError extends Error {
  status: number;
  debugId: string | undefined;
  issue: string | undefined;
  constructor(message: string, status: number, debugId?: string, issue?: string) {
    super(message);
    this.name = "PayPalError";
    this.status = status;
    this.debugId = debugId;
    this.issue = issue;
  }
}

export function assertSandbox(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("PAYPAL_API_BASE is not a valid URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "api-m.sandbox.paypal.com") {
    throw new Error("Only the PayPal sandbox (https://api-m.sandbox.paypal.com) is allowed in this spike");
  }
  return url.origin;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): PayPalConfig {
  const clientId = env.PAYPAL_CLIENT_ID ?? "";
  const secret = env.PAYPAL_CLIENT_SECRET ?? "";
  if (!clientId || !secret) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (sandbox)");
  }
  return { clientId, secret, base: assertSandbox(env.PAYPAL_API_BASE || SANDBOX_BASE) };
}

/** Replace every occurrence of the given secrets (and bearer tokens) in a string. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("***");
  }
  return out.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer ***").replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic ***");
}

export function assertOrderId(id: string): string {
  if (!ORDER_ID_RE.test(id)) throw new Error("invalid PayPal order id");
  return id;
}

export class PayPalClient {
  private cfg: Required<Omit<PayPalConfig, "fetchImpl">> & { fetchImpl: typeof fetch };
  private token: { value: string; expiresAt: number } | null = null;

  constructor(cfg: PayPalConfig) {
    this.cfg = {
      clientId: cfg.clientId,
      secret: cfg.secret,
      base: assertSandbox(cfg.base ?? SANDBOX_BASE),
      fetchImpl: cfg.fetchImpl ?? fetch,
    };
  }

  private clean(text: string): string {
    return redact(text, [this.cfg.clientId, this.cfg.secret, this.token?.value]);
  }

  async getAccessToken(now: number = Date.now()): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.secret}`).toString("base64");
    let res: Response;
    try {
      res = await this.cfg.fetchImpl(`${this.cfg.base}/v1/oauth2/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      });
    } catch (e) {
      throw new PayPalError(this.clean(`token request failed: ${(e as Error).message}`), 0);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      throw new PayPalError(this.clean(`token request rejected: HTTP ${res.status} ${body.error ?? ""}`.trim()), res.status);
    }
    this.token = { value: body.access_token, expiresAt: now + (body.expires_in ?? 300) * 1000 };
    return body.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const token = await this.getAccessToken();
    let res: Response;
    try {
      res = await this.cfg.fetchImpl(`${this.cfg.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PayPalError(this.clean(`${method} ${path} failed: ${(e as Error).message}`), 0);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      const issue = json?.details?.[0]?.issue as string | undefined;
      const msg = `${method} ${path}: HTTP ${res.status} ${json?.name ?? ""} ${issue ?? ""}`.replace(/\s+/g, " ").trim();
      throw new PayPalError(this.clean(msg), res.status, json?.debug_id, issue);
    }
    return json as T;
  }

  createOrder(input: CreateOrderInput, requestId?: string): Promise<any> {
    const itemTotal = input.items
      .reduce((sum, it) => sum + Math.round(Number(it.unitPrice) * 100) * it.quantity, 0);
    if (itemTotal !== Math.round(Number(input.total) * 100)) {
      throw new Error("order total does not match items");
    }
    const payload: Record<string, unknown> = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: input.referenceId ?? "default",
          custom_id: input.customId,
          amount: {
            currency_code: input.currency,
            value: input.total,
            breakdown: { item_total: { currency_code: input.currency, value: input.total } },
          },
          items: input.items.map((it) => ({
            name: it.name,
            sku: it.sku,
            quantity: String(it.quantity),
            unit_amount: { currency_code: input.currency, value: it.unitPrice },
            category: "PHYSICAL_GOODS",
          })),
        },
      ],
    };
    if (input.returnUrl || input.cancelUrl) {
      payload.payment_source = {
        paypal: {
          experience_context: {
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
          },
        },
      };
    }
    return this.call("POST", "/v2/checkout/orders", payload, requestId ? { "PayPal-Request-Id": requestId } : {});
  }

  getOrder(id: string): Promise<any> {
    return this.call("GET", `/v2/checkout/orders/${assertOrderId(id)}`);
  }

  captureOrder(id: string, requestId?: string): Promise<any> {
    return this.call("POST", `/v2/checkout/orders/${assertOrderId(id)}/capture`, {}, requestId ? { "PayPal-Request-Id": requestId } : {});
  }

  /** Payments v2: refund a capture (full refund when amount is omitted). Idempotent per requestId. */
  refundCapture(captureId: string, opts: { amount?: string; currency?: string; note?: string } = {}, requestId?: string): Promise<any> {
    if (!CAPTURE_ID_RE.test(captureId)) throw new Error("invalid PayPal capture id");
    const body: Record<string, unknown> = {};
    if (opts.amount) body.amount = { value: opts.amount, currency_code: opts.currency ?? "USD" };
    if (opts.note) body.note_to_payer = opts.note.slice(0, 255);
    return this.call("POST", `/v2/payments/captures/${captureId}/refund`, body, requestId ? { "PayPal-Request-Id": requestId } : {});
  }

  /** Disputes v1: the merchant's PayPal-side disputes (opened by buyers in PayPal, not via this store). */
  listDisputes(pageSize = 20): Promise<any> {
    const n = Math.min(Math.max(Math.trunc(pageSize) || 20, 1), 50);
    return this.call("GET", `/v1/customer/disputes?page_size=${n}`);
  }

  getDispute(id: string): Promise<any> {
    if (!/^PP-[A-Z0-9-]{6,40}$/.test(id)) throw new Error("invalid PayPal dispute id");
    return this.call("GET", `/v1/customer/disputes/${id}`);
  }

  /** The client id is public (it ships to the browser in the JS SDK); the secret never leaves the server. */
  get clientId(): string {
    return this.cfg.clientId;
  }
}

export function approveLink(order: any): string | undefined {
  const links: Array<{ rel: string; href: string }> = order?.links ?? [];
  return links.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
}
