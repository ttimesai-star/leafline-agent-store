// Vendored from DisputeDesk (github.com/ttimesai-star/disputedesk, MIT, same author) - keep in sync by hand.
// Subset of the PayPal REST schemas DisputeDesk relies on.
// Field names and enums are taken from the official OpenAPI specs
// (github.com/paypal/paypal-rest-api-specifications):
//   customer_disputes_v1.json, checkout_orders_v2.json, reporting_transactions_v1.json,
//   shipping_shipment_tracking_v1.json, notifications_webhooks_v1.json
// Only fields we read are typed; everything else is passed through untouched.

export interface Money {
  currency_code: string;
  value: string;
}

export interface LinkDescription {
  href: string;
  rel: string;
  method?: string;
}

// customer_disputes_v1.json#/components/schemas/dispute_reason
export const DISPUTE_REASONS = [
  "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  "UNAUTHORISED",
  "CREDIT_NOT_PROCESSED",
  "DUPLICATE_TRANSACTION",
  "INCORRECT_AMOUNT",
  "PAYMENT_BY_OTHER_MEANS",
  "CANCELED_RECURRING_BILLING",
  "PROBLEM_WITH_REMITTANCE",
  "OTHER",
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

// #/components/schemas/status
export type DisputeStatus =
  | "OPEN"
  | "WAITING_FOR_BUYER_RESPONSE"
  | "WAITING_FOR_SELLER_RESPONSE"
  | "UNDER_REVIEW"
  | "RESOLVED"
  | "OTHER";

// #/components/schemas/dispute_state (list filter)
export type DisputeState =
  | "OPEN_INQUIRIES"
  | "REQUIRED_ACTION"
  | "REQUIRED_OTHER_PARTY_ACTION"
  | "UNDER_PAYPAL_REVIEW"
  | "APPEALABLE"
  | "RESOLVED";

// #/components/schemas/dispute_lifecycle_stage
export type DisputeLifecycleStage = "INQUIRY" | "CHARGEBACK" | "PRE_ARBITRATION" | "ARBITRATION";

// #/components/schemas/dispute_channel
export type DisputeChannel = "INTERNAL" | "EXTERNAL" | "ALERT";

// #/components/schemas/accept_claim_type
export type AcceptClaimType = "REFUND" | "REFUND_WITH_RETURN" | "PARTIAL_REFUND" | "REFUND_WITH_RETURN_SHIPMENT_LABEL";

// #/components/schemas/evidence -> evidence_type (subset we generate)
export type EvidenceType =
  | "PROOF_OF_FULFILLMENT"
  | "PROOF_OF_REFUND"
  | "PROOF_OF_DELIVERY_SIGNATURE"
  | "PROOF_OF_RECEIPT_COPY"
  | "RETURN_POLICY"
  | "BILLING_AGREEMENT"
  | "ITEM_DESCRIPTION"
  | "CANCELLATION_DETAILS"
  | "MERCHANT_CONTACT_DETAILS"
  | "ONLINE_TRACKING_INFORMATION"
  | "ORDER_DETAILS"
  | "OTHER";

export interface TransactionInfo {
  buyer_transaction_id?: string;
  seller_transaction_id?: string;
  reference_id?: string;
  create_time?: string;
  transaction_status?: string;
  gross_amount?: Money;
  invoice_number?: string;
  custom?: string;
  buyer?: { email?: string; name?: string; payer_id?: string };
  seller?: { email?: string; merchant_id?: string; name?: string };
  items?: { item_id?: string; item_description?: string; item_quantity?: string; reason?: string; notes?: string }[];
}

export interface DisputeMessage {
  posted_by: "BUYER" | "SELLER" | "ARBITER";
  time_posted: string;
  content: string;
}

export interface TrackingInfo {
  carrier_name?: string;
  carrier_name_other?: string;
  tracking_url?: string;
  tracking_number?: string;
}

export interface Evidence {
  evidence_type: EvidenceType | string;
  evidence_info?: { tracking_info?: TrackingInfo[]; refund_ids?: { refund_id: string }[] };
  notes?: string;
  source?: "REQUESTED_FROM_BUYER" | "REQUESTED_FROM_SELLER" | "SUBMITTED_BY_BUYER" | "SUBMITTED_BY_SELLER" | "SUBMITTED_BY_PARTNER";
  date?: string;
}

export interface DisputeOutcome {
  outcome_code: "RESOLVED_BUYER_FAVOUR" | "RESOLVED_SELLER_FAVOUR" | "RESOLVED_WITH_PAYOUT" | "CANCELED_BY_BUYER" | "ACCEPTED" | "DENIED" | "NONE";
  amount_refunded?: Money;
}

/** GET /v1/customer/disputes -> items[] (dispute_info) */
export interface DisputeSummary {
  dispute_id: string;
  create_time: string;
  update_time: string;
  reason: DisputeReason;
  status: DisputeStatus;
  dispute_state?: DisputeState;
  dispute_amount: Money;
  dispute_life_cycle_stage?: DisputeLifecycleStage;
  dispute_channel?: DisputeChannel;
  links?: LinkDescription[];
}

/** GET /v1/customer/disputes/{id} */
export interface Dispute extends DisputeSummary {
  disputed_transactions: TransactionInfo[];
  external_reason_code?: string;
  dispute_outcome?: DisputeOutcome;
  messages?: DisputeMessage[];
  evidences?: Evidence[];
  buyer_response_due_date?: string;
  seller_response_due_date?: string;
  allowed_response_options?: { accept_claim?: { accept_claim_types?: AcceptClaimType[] } };
}

export interface DisputeList {
  items: DisputeSummary[];
  links?: LinkDescription[];
}

/** checkout_orders_v2.json order (subset) */
export interface Order {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  intent?: "CAPTURE" | "AUTHORIZE";
  create_time?: string;
  update_time?: string;
  payer?: { email_address?: string; payer_id?: string; name?: { given_name?: string; surname?: string } };
  purchase_units: {
    reference_id?: string;
    description?: string;
    invoice_id?: string;
    amount: Money;
    items?: { name: string; quantity: string; unit_amount?: Money; description?: string; category?: string; url?: string }[];
    shipping?: { name?: { full_name?: string }; address?: { address_line_1?: string; admin_area_2?: string; postal_code?: string; country_code?: string } };
    payments?: { captures?: { id: string; status: string; amount: Money; create_time?: string; final_capture?: boolean }[] };
  }[];
}

/** reporting_transactions_v1.json transaction_detail (subset) */
export interface TransactionDetail {
  transaction_info: {
    transaction_id: string;
    paypal_reference_id?: string;
    transaction_event_code?: string;
    transaction_initiation_date?: string;
    transaction_updated_date?: string;
    transaction_amount?: Money;
    fee_amount?: Money;
    transaction_status?: "D" | "P" | "S" | "V" | string;
    transaction_subject?: string;
    invoice_id?: string;
    custom_field?: string;
    protection_eligibility?: string;
  };
  payer_info?: { account_id?: string; email_address?: string; address_status?: string; payer_status?: string; country_code?: string; payer_name?: { given_name?: string; surname?: string; alternate_full_name?: string } };
  shipping_info?: { name?: string; method?: string; address?: { line1?: string; city?: string; country_code?: string; postal_code?: string } };
  cart_info?: { item_details?: { item_code?: string; item_name?: string; item_quantity?: string; item_amount?: Money }[] };
}

export interface TransactionSearchResponse {
  transaction_details: TransactionDetail[];
  total_items?: number;
  total_pages?: number;
  page?: number;
}

/** shipping_shipment_tracking_v1.json tracker */
export interface Tracker {
  transaction_id: string;
  tracking_number?: string;
  status: "CANCELLED" | "DELIVERED" | "LOCAL_PICKUP" | "ON_HOLD" | "SHIPPED" | "SHIPMENT_CREATED" | "DROPPED_OFF" | "IN_TRANSIT" | "RETURNED" | "LABEL_PRINTED" | "ERROR" | "UNCONFIRMED" | "PICKUP_FAILED" | "DELIVERY_DELAYED" | "DELIVERY_SCHEDULED" | "DELIVERED_BY_SELLER" | string;
  shipment_date?: string;
  carrier?: string;
  carrier_name_other?: string;
  tracking_url?: string;
  last_updated_time?: string;
}

export interface TrackerCollection {
  trackers: Tracker[];
}

/** notifications_webhooks_v1.json event */
export interface WebhookEvent<T = unknown> {
  id: string;
  create_time: string;
  resource_type: string;
  event_type: string;
  summary?: string;
  resource: T;
  event_version?: string;
  resource_version?: string;
}

export interface WebhookHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export interface ProvideEvidenceInput {
  evidences: Evidence[];
  /** Optional documents. PayPal accepts JPG, GIF, PNG, PDF; we only pass through what the seller attaches. */
  files?: { name: string; contentType: string; data: Uint8Array }[];
}

export interface AcceptClaimInput {
  note: string;
  accept_claim_type?: AcceptClaimType;
  refund_amount?: Money;
}
