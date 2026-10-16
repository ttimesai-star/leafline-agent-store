import { $, esc, notice, getJson, postJson, when, loadPayPal } from "./ui.js";

const params = new URLSearchParams(location.search);
const id = params.get("id") ?? "";

function row(k, v) {
  return `<div>${esc(k)}</div><div>${v}</div>`;
}

async function load() {
  $("#oid").textContent = id;
  if (params.get("cancelled")) notice($("#banner"), "info", "Payment cancelled in PayPal. Nothing was charged.");
  let o;
  try {
    o = await getJson(`/api/orders/${encodeURIComponent(id)}`);
  } catch (e) {
    notice($("#banner"), "err", `Order not found: ${e.message}`);
    return;
  }
  if (o.status === "COMPLETED" && !params.get("cancelled")) notice($("#banner"), "ok", "Paid. Thank you! The payment was approved in PayPal and captured by the store.");
  $("#summary").innerHTML = [
    row("Status", `<span class="status">${esc(o.status)}</span>`),
    row("Items", esc(o.items.map((i) => `${i.quantity} x ${i.name} (${i.unitPrice} USD)`).join(", "))),
    row("Total", esc(o.total)),
    row("Placed by", o.channel === "agent" ? `the buyer's AI agent${o.mandateId ? ` under mandate <span class="sku">${esc(o.mandateId)}</span>` : ""}` : "the buyer, on the store page"),
    row("Created", esc(when(o.createdAt))),
    o.captureId ? row("PayPal capture", `<span class="sku">${esc(o.captureId)}</span> ${esc(o.captureStatus ?? "")}`) : "",
    o.refunds?.length ? row("Refunds", esc(o.refunds.map((r) => `${r.refundId} ${r.amount} USD ${r.status}`).join("; "))) : "",
  ].join("");

  const receipt = await getJson(`/api/orders/${encodeURIComponent(id)}/agent-log`).catch(() => null);
  if (receipt?.calls?.length) {
    $("#receipt-panel").hidden = false;
    $("#receipt").innerHTML = receipt.calls
      .map((c) => `<li class="${c.ok ? "" : "err"}"><b>${esc(c.tool)}</b> <code class="sku">${esc(JSON.stringify(c.args)).slice(0, 140)}</code><br>${esc(c.summary)} <span class="when">${esc(when(c.ts))}</span></li>`)
      .join("");
  }

  $("#claims").innerHTML = (o.claims ?? [])
    .map((c) => `<div class="notice ${c.status === "OPEN" ? "info" : c.status === "REFUNDED" ? "ok" : "err"}">${esc(c.claimId)}: ${esc(c.kind === "DISPUTE" ? "problem reported" : "refund requested")} by ${esc(c.by)} - <b>${esc(c.status)}</b>${c.resolution ? ` (${esc(c.resolution)})` : ""}</div>`)
    .join("");
  const open = (o.claims ?? []).some((c) => c.status === "OPEN");
  const canClaim = o.status === "COMPLETED" && !open && !(o.refunds ?? []).length;
  $("#claim-form").hidden = !canClaim;
  $("#claim-hint").textContent = canClaim ? "The merchant reviews requests in DisputeDesk; approved refunds go back through PayPal." : o.status === "COMPLETED" ? "" : "Refunds and problem reports open once the order is paid.";

  if (["CREATED", "PAYER_ACTION_REQUIRED", "APPROVED"].includes(o.status)) {
    const cfg = await getJson("/api/config");
    const session = await loadPayPal(cfg, {
      async onApprove(data) {
        await postJson(`/api/orders/${encodeURIComponent(data.orderId)}/capture`);
        location.href = `/order?id=${encodeURIComponent(data.orderId)}`;
      },
      async onCancel() {
        notice($("#banner"), "info", "Payment cancelled. Nothing was charged.");
      },
      onError(err) {
        notice($("#banner"), "err", `PayPal error: ${err?.message ?? err}`);
      },
    }).catch(() => null);
    if (session) {
      const btn = $("#pay");
      btn.hidden = false;
      btn.addEventListener("click", () => session.start({ presentationMode: "auto" }, Promise.resolve({ orderId: id })));
    }
  }
}

$("#c-send").addEventListener("click", async () => {
  try {
    await postJson(`/api/orders/${encodeURIComponent(id)}/claims`, { kind: $("#c-kind").value, reason: $("#c-reason").value, note: $("#c-note").value });
    notice($("#banner"), "ok", "Sent. The merchant will review it.");
    load();
  } catch (e) {
    notice($("#banner"), "err", e.message);
  }
});

load();
