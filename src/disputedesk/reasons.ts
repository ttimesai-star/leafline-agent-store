// Vendored from DisputeDesk casefile.ts (humanReason only).
export function humanReason(reason: string): string {
  const map: Record<string, string> = {
    MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "item not received",
    MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "not as described",
    UNAUTHORISED: "unauthorized payment",
    CREDIT_NOT_PROCESSED: "refund not processed",
    DUPLICATE_TRANSACTION: "duplicate charge",
    INCORRECT_AMOUNT: "incorrect amount",
    PAYMENT_BY_OTHER_MEANS: "paid by other means",
    CANCELED_RECURRING_BILLING: "canceled subscription billed",
    PROBLEM_WITH_REMITTANCE: "remittance problem",
    OTHER: "other",
  };
  return map[reason] ?? reason.toLowerCase();
}
