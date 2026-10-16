// Vendored from DisputeDesk (github.com/ttimesai-star/disputedesk, MIT, same author) - keep in sync by hand.
import type { AcceptClaimType, Evidence } from "./types.ts";
import type { Assessment, CaseFacts, Recommendation } from "./shared.ts";
import { humanReason } from "./reasons.ts";

/**
 * Deterministic baseline. It runs first on every dispute, and is the final answer when no LLM is
 * configured or the LLM output fails validation. Probabilities are heuristic priors written
 * from PayPal's seller-protection and evidence guidance, not trained numbers; the UI labels them "estimate".
 */
export interface RuleOptions {
  /** Fee assumed when a claim/chargeback is lost (configurable; PayPal's actual fee depends on the merchant's pricing). */
  chargebackFee?: number;
  /** Seller time cost of preparing a response. */
  handlingCost?: number;
  now?: Date;
}

export function assessByRules(f: CaseFacts, opts: RuleOptions = {}): Assessment {
  const fee = f.stage === "INQUIRY" ? 0 : (opts.chargebackFee ?? 20);
  const handling = opts.handlingCost ?? 5;
  const rationale: string[] = [];
  const risk: string[] = [];
  let p = 0.3;

  switch (f.reason) {
    case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED":
      if (f.digital) {
        p = f.itemDescription ? 0.55 : 0.35;
        rationale.push("Digital item: access or download logs are the decisive evidence; tracking does not apply.");
      } else if (f.delivered) {
        p = f.addressConfirmed ? 0.85 : 0.7;
        rationale.push(`Carrier shows the parcel delivered (${f.carrier ?? "carrier"} ${f.trackingNumbers[0] ?? ""}).`.replace(" )", ")"));
        if (f.addressConfirmed) rationale.push("Shipped to the buyer's confirmed address, which Seller Protection requires.");
      } else if (f.inTransit) {
        p = 0.6;
        rationale.push("Parcel is still in transit; sharing tracking with the buyer usually closes the inquiry.");
      } else if (f.returned) {
        p = 0.2;
        rationale.push("Parcel came back to the sender, so the buyer did not receive it.");
      } else {
        p = 0.1;
        rationale.push("No tracking on file: PayPal decides item-not-received claims mostly on proof of delivery.");
        risk.push("No proof of shipment");
      }
      break;
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      p = 0.35;
      rationale.push("Not-as-described claims are judged on the listing versus what arrived; buyers usually win without photos from the seller.");
      if (f.itemDescription && /unique|varies|vary|handmade|hand-thrown|may differ/i.test(f.itemDescription)) {
        p += 0.15;
        rationale.push("The listing discloses natural variation, which supports the seller.");
      }
      if (f.sellerReplied) rationale.push("Seller already engaged with the buyer in the case thread.");
      risk.push("PayPal may require the buyer to return the item at the seller's cost");
      break;
    case "UNAUTHORISED":
      p = 0.3;
      if (f.delivered && f.addressConfirmed && f.protectionEligible) {
        p = 0.75;
        rationale.push("Eligible for Seller Protection: delivered to a confirmed address with tracking.");
      } else {
        rationale.push("Unauthorized-use claims are hard to win without Seller Protection eligibility.");
        risk.push("Not covered by Seller Protection");
      }
      break;
    case "CREDIT_NOT_PROCESSED":
      if (f.refundIds.length) {
        p = 0.9;
        rationale.push(`A refund was already issued (${f.refundIds.join(", ")}); proof of refund settles the claim.`);
      } else {
        p = 0.15;
        rationale.push("No refund found in Transaction Search for this payment.");
      }
      break;
    case "DUPLICATE_TRANSACTION":
      p = 0.1;
      rationale.push("Duplicate-charge claims are usually valid; refunding the extra charge is cheaper than contesting.");
      break;
    case "CANCELED_RECURRING_BILLING":
      p = 0.2;
      rationale.push("Billing after cancellation is a common, usually valid claim unless the cancellation date proves otherwise.");
      break;
    case "INCORRECT_AMOUNT":
      p = 0.3;
      rationale.push("Compare the checkout total with the captured amount; partial refund of the difference is typical.");
      break;
    default:
      p = 0.3;
      rationale.push(`Reason "${humanReason(f.reason)}" has no specific rule; using a neutral prior.`);
  }

  if (f.daysToDue !== null && f.daysToDue <= 1 && f.status === "WAITING_FOR_SELLER_RESPONSE") risk.push(`Response due in ${Math.max(0, f.daysToDue)} day(s)`);
  if (f.channel === "EXTERNAL") risk.push("Card chargeback: the issuer decides, PayPal only forwards evidence");
  p = clamp01(p);

  // Expected money outcome relative to today, in dispute currency.
  const fight = -(1 - p) * (f.amount + fee) - handling;
  const accept = -f.amount;
  let recommendation: Recommendation;
  if (f.status === "RESOLVED") recommendation = "WAIT";
  else if (f.status === "UNDER_REVIEW" || f.status === "WAITING_FOR_BUYER_RESPONSE") recommendation = "WAIT";
  else if (f.stage === "INQUIRY" && f.inTransit && f.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED") recommendation = "MESSAGE_BUYER";
  else recommendation = fight > accept ? "FIGHT" : "ACCEPT";

  if (recommendation === "FIGHT") rationale.push(`Fighting: expected ${fmt(fight, f.currency)} vs ${fmt(accept, f.currency)} if accepted now.`);
  if (recommendation === "ACCEPT") rationale.push(`Accepting: refund ${fmt(accept, f.currency)} beats an expected ${fmt(fight, f.currency)} from fighting.`);
  if (recommendation === "WAIT") rationale.push(f.status === "RESOLVED" ? "Dispute is closed." : "Waiting on PayPal or the buyer; no seller action possible right now.");

  return {
    recommendation,
    winProbability: round2(p),
    rationale,
    riskFlags: risk,
    evidence: draftEvidence(f),
    buyerMessage: draftBuyerMessage(f),
    acceptNote: draftAcceptNote(f),
    acceptType: pickAcceptType(f),
    expected: { fight: round2(fight), accept: round2(accept), assumedFee: fee },
    source: "rules",
    model: null,
    generatedAt: (opts.now ?? new Date()).toISOString(),
  };
}

/** Evidence entries built only from data PayPal returned: never invents tracking numbers or refund ids. */
export function draftEvidence(f: CaseFacts): Evidence[] {
  const out: Evidence[] = [];
  const tracking = f.trackingNumbers.map((n) => ({ carrier_name: f.carrier ?? "OTHER", tracking_number: n }));
  switch (f.reason) {
    case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED":
      if (tracking.length) {
        out.push({
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_info: { tracking_info: tracking },
          notes: `Order shipped with ${f.carrier ?? "the carrier"}; tracking ${f.trackingNumbers.join(", ")} shows status ${f.delivered ? "DELIVERED" : "in transit"}${f.addressConfirmed ? " to the buyer's PayPal-confirmed address" : ""}.`,
        });
      } else if (f.digital) {
        out.push({ evidence_type: "PROOF_OF_FULFILLMENT", notes: `Digital delivery: ${(f.itemDescription ?? "item").replace(/[.\s]+$/, "")}. Attach access/download logs with timestamps and the buyer's IP or account id.` });
      }
      break;
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      out.push({ evidence_type: "ITEM_DESCRIPTION", notes: `Listing description at time of sale: "${f.itemDescription ?? "see listing"}". Attach listing screenshots and photos of the item as shipped.` });
      if (tracking.length) out.push({ evidence_type: "PROOF_OF_FULFILLMENT", evidence_info: { tracking_info: tracking }, notes: "Delivered as shown by tracking." });
      break;
    case "UNAUTHORISED":
      if (tracking.length) out.push({ evidence_type: "PROOF_OF_FULFILLMENT", evidence_info: { tracking_info: tracking }, notes: `Delivered to the address on the PayPal transaction${f.addressConfirmed ? " (confirmed)" : ""}.` });
      out.push({ evidence_type: "OTHER", notes: "Attach any prior purchases by the same buyer account and communication proving the buyer authorized the order." });
      break;
    case "CREDIT_NOT_PROCESSED":
      if (f.refundIds.length) out.push({ evidence_type: "PROOF_OF_REFUND", evidence_info: { refund_ids: f.refundIds.map((id) => ({ refund_id: id })) }, notes: `Full refund already issued via PayPal: ${f.refundIds.join(", ")}.` });
      break;
    case "CANCELED_RECURRING_BILLING":
      out.push({ evidence_type: "CANCELLATION_DETAILS", notes: "Attach the subscription log showing the cancellation date versus the billing date." });
      break;
    default:
      out.push({ evidence_type: "ORDER_DETAILS", notes: `Order ${f.orderId ?? ""} for ${f.amount.toFixed(2)} ${f.currency}: ${f.itemDescription ?? ""}`.trim() });
  }
  return out;
}

function draftBuyerMessage(f: CaseFacts): string {
  if (f.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" && f.inTransit && f.trackingNumbers.length) {
    return `Hi, thanks for reaching out. Your order is on its way with ${f.carrier ?? "the carrier"}, tracking number ${f.trackingNumbers[0]}. It should arrive shortly; if it hasn't arrived within 5 business days, reply here and we'll send a replacement or refund.`;
  }
  if (f.reason === "CREDIT_NOT_PROCESSED" && f.refundIds.length) {
    return `Hi, we issued your refund through PayPal (refund id ${f.refundIds[0]}). Banks can take 3-5 business days to show it. Could you check and close this case if it has arrived?`;
  }
  return "Hi, we're sorry about the trouble with your order. We've reviewed the details and want to resolve this quickly. Could you tell us a bit more so we can make it right?";
}

function draftAcceptNote(f: CaseFacts): string {
  return `We accept the claim (${humanReason(f.reason)}) and are refunding ${f.amount.toFixed(2)} ${f.currency}. Sorry for the inconvenience.`;
}

function pickAcceptType(f: CaseFacts): AcceptClaimType | null {
  if (f.reason === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" && !f.digital && f.amount >= 50) return "REFUND_WITH_RETURN";
  return "REFUND";
}

function clamp01(x: number): number {
  return Math.min(0.99, Math.max(0.01, x));
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function fmt(x: number, ccy: string): string {
  return `${x < 0 ? "-" : ""}${Math.abs(x).toFixed(2)} ${ccy}`;
}
