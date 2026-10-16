// One payments port for the server, split by who does the work:
//  - our Orders v2 client (src/paypal.ts): create order (carries agent session + mandate in custom_id, item
//    SKUs, PayPal-Request-Id) and capture (idempotent per order);
//  - the official PayPal Agent Toolkit (src/toolkit.ts): order status, PayPal disputes, accept claim,
//    refund, refund status.
import type { PayPalClient } from "./paypal.ts";
import { ToolkitPayments, TOOLKIT_VERSION, MERCHANT_TOOLS, type ToolkitCall } from "./toolkit.ts";

export interface PaymentsPort {
  createOrder: PayPalClient["createOrder"];
  getOrder(id: string): Promise<any>;
  captureOrder: PayPalClient["captureOrder"];
  refundCapture(captureId: string, opts?: { amount?: string; currency?: string; note?: string }, requestId?: string): Promise<any>;
  listDisputes(pageSize?: number): Promise<any>;
  getDispute(id: string): Promise<any>;
  acceptDisputeClaim?(id: string, note: string): Promise<any>;
  getRefund?(id: string): Promise<any>;
  /** Recent PayPal Agent Toolkit calls (tool, ok, ms), if the Toolkit is wired in. */
  toolkitCalls?(limit?: number): ToolkitCall[];
  readonly toolkit?: { package: string; version: string; tools: readonly string[] } | null;
  readonly clientId: string;
}

export function composePayments(own: PayPalClient, kit: ToolkitPayments): PaymentsPort {
  return {
    clientId: own.clientId,
    toolkit: { package: "@paypal/agent-toolkit", version: TOOLKIT_VERSION, tools: MERCHANT_TOOLS },
    createOrder: (input, requestId) => own.createOrder(input, requestId),
    captureOrder: (id, requestId) => own.captureOrder(id, requestId),
    getOrder: (id) => kit.getOrder(id),
    refundCapture: (captureId, opts, requestId) => kit.refundCapture(captureId, opts, requestId),
    listDisputes: (n) => kit.listDisputes(n),
    getDispute: (id) => kit.getDispute(id),
    acceptDisputeClaim: (id, note) => kit.acceptDisputeClaim(id, note),
    getRefund: (id) => kit.getRefund(id),
    toolkitCalls: (limit) => kit.calls(limit),
  };
}
