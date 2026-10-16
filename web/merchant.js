import { $, esc, notice, getJson as rawGet, postJson as rawPost } from "./ui.js";

// Merchant key (server env MERCHANT_KEY). Taken from the URL fragment (#key=..., never sent to the server or its
// logs) or typed into the header field; kept for this tab only (sessionStorage) and sent as X-Merchant-Key.
const KEY_SLOT = "merchantKey";
{
  const m = location.hash.match(/(?:^#|&)key=([^&]+)/);
  if (m) {
    sessionStorage.setItem(KEY_SLOT, decodeURIComponent(m[1]));
    history.replaceState(null, "", location.pathname + location.search);
  }
}
const keyHeaders = () => {
  const k = sessionStorage.getItem(KEY_SLOT);
  return k ? { "x-merchant-key": k } : {};
};
const askKey = (why) => {
  const box = $("#keybox");
  if (!box) return;
  box.hidden = false;
  $("#key-why").textContent = why;
  $("#key-in").focus();
};
const onAuth = (e) => {
  if (e?.status === 401) askKey("This server needs the merchant key (MERCHANT_KEY).");
  throw e;
};
const getJson = (url) => rawGet(url, { headers: keyHeaders() }).catch(onAuth);
const postJson = (url, body) => rawPost(url, body, keyHeaders()).catch(onAuth);

const ag = window.agGrid;
if (ag.ModuleRegistry && ag.AllCommunityModule) ag.ModuleRegistry.registerModules([ag.AllCommunityModule]);
const theme = ag.themeQuartz?.withParams?.({ accentColor: "#2f6b4f", headerBackgroundColor: "#f3f5f3", fontSize: 13, spacing: 6 });

/** Cell renderer that returns a DOM node (never raw HTML from data). */
const pill = (text, kind = "") => {
  const s = document.createElement("span");
  s.className = `badge ${kind}`;
  s.textContent = text;
  return s;
};
const channelCell = (p) => (p.value ? pill(p.value === "agent" ? "AI agent" : p.value, p.value === "agent" ? "" : "warn") : "");
const statusCell = (p) => (p.value ? pill(p.value, ["COMPLETED", "REFUNDED"].includes(p.value) ? "" : ["CANCELLED", "DECLINED", "VOIDED"].includes(p.value) ? "bad" : "warn") : "");
const dateFmt = (p) => (p.value ? new Date(p.value).toLocaleString() : "");

function makeGrid(el, columnDefs, extra = {}) {
  return ag.createGrid(el, {
    theme,
    columnDefs,
    rowData: [],
    defaultColDef: { sortable: true, filter: true, resizable: true, floatingFilter: false },
    pagination: true,
    paginationPageSize: 20,
    paginationPageSizeSelector: [20, 50, 100],
    animateRows: true,
    ...extra,
  });
}

const grids = {
  orders: makeGrid($("#g-orders"), [
    { field: "createdAt", headerName: "Created", valueFormatter: dateFmt, sort: "desc", width: 170 },
    { field: "orderId", headerName: "PayPal order", width: 190, cellRenderer: (p) => { const a = document.createElement("a"); a.href = `/order?id=${encodeURIComponent(p.value)}`; a.textContent = p.value; return a; } },
    { field: "channel", headerName: "Channel", cellRenderer: channelCell, width: 110 },
    { field: "items", headerName: "Items", flex: 1, minWidth: 220, valueGetter: (p) => p.data.items.map((i) => `${i.quantity} x ${i.name}`).join(", ") },
    { field: "total", headerName: "Total, USD", type: "numericColumn", width: 110, valueGetter: (p) => Number(p.data.total) },
    { field: "status", headerName: "Status", cellRenderer: statusCell, width: 170 },
    { field: "mandateId", headerName: "Mandate", width: 170 },
    { field: "captureId", headerName: "Capture", width: 170 },
    { headerName: "Refunds", width: 100, valueGetter: (p) => p.data.refunds.length },
  ]),
  journal: makeGrid($("#g-journal"), [
    { field: "ts", headerName: "Time", valueFormatter: dateFmt, width: 170 },
    { field: "session", headerName: "Agent session", width: 220 },
    { field: "tool", headerName: "Tool", width: 150 },
    { field: "ok", headerName: "OK", width: 80, cellRenderer: (p) => pill(p.value ? "ok" : "refused", p.value ? "" : "bad") },
    { field: "summary", headerName: "Result", flex: 1, minWidth: 220 },
    { field: "orderId", headerName: "Order", width: 170 },
    { field: "args", headerName: "Arguments", width: 260, valueGetter: (p) => JSON.stringify(p.data.args ?? {}) },
    { field: "ms", headerName: "ms", width: 80, type: "numericColumn" },
  ]),
  cases: makeGrid(
    $("#g-cases"),
    [
      { field: "createdAt", headerName: "Opened", valueFormatter: dateFmt, width: 160, sort: "desc" },
      { field: "caseId", headerName: "Case", width: 140 },
      { field: "source", headerName: "Source", width: 90, cellRenderer: (p) => pill(p.value === "paypal" ? "PayPal" : "store", p.value === "paypal" ? "warn" : "") },
      { field: "channel", headerName: "Order by", width: 110, cellRenderer: channelCell },
      { field: "reasonText", headerName: "Reason", width: 150 },
      { field: "amount", headerName: "USD", width: 90, type: "numericColumn" },
      { field: "status", headerName: "Status", width: 130, cellRenderer: statusCell },
      { headerName: "Advice", width: 120, valueGetter: (p) => p.data.assessment.recommendation, cellRenderer: (p) => pill(p.value, p.value === "ACCEPT" ? "warn" : "") },
      { headerName: "Win est.", width: 100, valueGetter: (p) => Math.round(p.data.assessment.winProbability * 100), valueFormatter: (p) => `${p.value}%` },
    ],
    { rowSelection: { mode: "singleRow", enableClickSelection: true, checkboxes: false }, onRowClicked: (e) => showCase(e.data) },
  ),
  toolkit: makeGrid($("#g-toolkit"), [
    { field: "at", headerName: "Time", valueFormatter: dateFmt, width: 170 },
    { field: "tool", headerName: "Toolkit tool", width: 200 },
    { field: "ok", headerName: "OK", width: 80, cellRenderer: (p) => pill(p.value ? "ok" : "failed", p.value ? "" : "bad") },
    { field: "status", headerName: "HTTP", width: 90 },
    { field: "ms", headerName: "ms", width: 90, type: "numericColumn" },
    { field: "note", headerName: "Note", flex: 1, minWidth: 200 },
  ]),
};

let selected = null;
function showCase(c) {
  selected = c;
  const a = c.assessment;
  const ev = (e, agent) => `<div class="ev ${agent ? "agent" : ""}"><b>${esc(e.evidence_type)}${agent ? " - from the agent journal" : ""}</b>${esc(e.notes ?? "")}</div>`;
  const actions =
    c.source === "store" && c.status === "OPEN"
      ? `<div style="display:flex;gap:.5rem;margin-top:.6rem"><button class="primary" id="do-refund">Refund ${esc(c.amount.toFixed(2))} USD via PayPal</button><button id="do-decline">Decline</button></div>`
      : c.source === "paypal"
        ? `<p class="muted">PayPal-side dispute, read through the PayPal Agent Toolkit (get_dispute).</p>` +
          (["RESOLVED", "CLOSED"].includes(c.status) ? "" : `<div style="display:flex;gap:.5rem;margin-top:.6rem"><button id="do-accept">Accept claim (Toolkit accept_dispute_claim)</button></div>`)
        : "";
  const money = (x) => `${esc(Number(x ?? 0).toFixed(2))} USD`;
  $("#case").innerHTML = `
    <h2>${esc(c.caseId)} <small>${esc(c.kind.replace("_", " ").toLowerCase())}, order ${esc(c.orderId ?? "-")}</small></h2>
    <div class="rec ${esc(a.recommendation)}">${esc(a.recommendation)} <span class="muted">win estimate ${Math.round(a.winProbability * 100)}%</span></div>
    <p class="muted">Expected if fought: ${money(a.expected.fight)}; if accepted now: ${money(a.expected.accept)} (assumed fee ${money(a.expected.assumedFee)}).</p>
    ${c.note ? `<div class="ev"><b>Buyer message</b>${esc(c.note)}</div>` : ""}
    <ul>${a.rationale.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    ${a.riskFlags.length ? `<p><b>Risks:</b> ${esc(a.riskFlags.join("; "))}</p>` : ""}
    <h2 style="margin-top:.8rem">Evidence draft</h2>
    ${c.agentEvidence.map((e) => ev(e, true)).join("")}
    ${a.evidence.map((e) => ev(e, false)).join("") || '<p class="muted">No PayPal-side evidence available (no shipment tracking in this demo shop).</p>'}
    ${actions}`;
}

async function act(kind) {
  if (!selected) return;
  try {
    const r = await postJson(`/api/merchant/claims/${encodeURIComponent(selected.caseId)}/${kind}`, kind === "decline" ? { reason: "declined after review" } : {});
    notice($("#msg"), "ok", `${selected.caseId}: ${r.status}${r.resolution ? ` (${r.resolution})` : ""}`);
    await refresh();
  } catch (e) {
    notice($("#msg"), "err", e.message);
  }
}

async function acceptDispute() {
  if (!selected || selected.source !== "paypal") return;
  try {
    await postJson(`/api/merchant/disputes/${encodeURIComponent(selected.caseId)}/accept`, { note: "We accept the claim after review." });
    notice($("#msg"), "ok", `${selected.caseId}: claim accepted through the PayPal Agent Toolkit`);
    await refresh();
  } catch (e) {
    notice($("#msg"), "err", e.message);
  }
}

async function refresh() {
  const [s, o, j, c, t] = await Promise.all([
    getJson("/api/merchant/summary"),
    getJson("/api/merchant/orders"),
    getJson("/api/merchant/journal"),
    getJson("/api/merchant/cases"),
    getJson("/api/merchant/toolkit").catch(() => ({ toolkit: null, calls: [] })),
  ]);
  const share = s.orders ? Math.round((s.agentOrders / s.orders) * 100) : 0;
  const k = (v, l) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`;
  $("#kpis").innerHTML = [
    k(s.orders, "orders created"),
    k(`${share}%`, "placed by AI agents"),
    k(s.paid, "paid"),
    k(`${s.revenue} USD`, "revenue (sandbox)"),
    k(`${s.agentRevenue} USD`, "of it via agents"),
    k(s.openClaims, "open claims"),
    k(s.journal.calls, "agent tool calls"),
  ].join("");
  grids.orders.setGridOption("rowData", o.orders);
  grids.journal.setGridOption("rowData", j.entries);
  grids.cases.setGridOption("rowData", c.cases);
  grids.toolkit.setGridOption("rowData", t.calls);
  $("#toolkit-note").textContent = t.toolkit
    ? `${t.toolkit.package} ${t.toolkit.version}. Enabled tools (allow-list enforced by this server): ${t.toolkit.tools.join(", ")}. Orders are created and captured by the store's own Orders v2 client.`
    : "PayPal Agent Toolkit is not wired in on this server.";
  $("#paypal-note").innerHTML = c.paypalError ? `<div class="notice err">${esc(c.paypalError)}</div>` : "";
  if (selected) {
    const again = c.cases.find((x) => x.caseId === selected.caseId);
    if (again) showCase(again);
  }
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.tab) {
    document.querySelectorAll(".tabs button[data-tab]").forEach((b) => b.classList.toggle("on", b === t));
    document.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== t.dataset.tab));
  } else if (t.id === "refresh") refresh();
  else if (t.id === "key-save") {
    const v = $("#key-in").value.trim();
    if (v) sessionStorage.setItem(KEY_SLOT, v);
    else sessionStorage.removeItem(KEY_SLOT);
    $("#key-in").value = "";
    $("#keybox").hidden = true;
    renderKeyState();
    refresh().catch((e) => notice($("#msg"), "err", e.message));
  } else if (t.id === "key-open") askKey("Merchant actions (refund, decline, accept a PayPal dispute) are signed with this key.");
  else if (t.id === "do-refund") act("refund");
  else if (t.id === "do-decline") act("decline");
  else if (t.id === "do-accept") acceptDispute();
});

$("#keybox")?.addEventListener("submit", (e) => e.preventDefault());

function renderKeyState() {
  const b = $("#key-open");
  if (b) b.textContent = sessionStorage.getItem(KEY_SLOT) ? "Merchant key: set" : "Merchant key";
}
renderKeyState();
rawGet("/api/config")
  .then((c) => {
    if (c.merchantKey === "all" && !sessionStorage.getItem(KEY_SLOT)) askKey("This server keeps the merchant panel behind the merchant key.");
    if (c.merchantKey === "none" && $("#key-open")) $("#key-open").hidden = true;
  })
  .catch(() => {});

const tab = new URLSearchParams(location.search).get("tab");
if (tab) document.querySelector(`.tabs button[data-tab="${CSS.escape(tab)}"]`)?.click();
refresh().catch((e) => notice($("#msg"), "err", e.message));
setInterval(() => refresh().catch(() => {}), 15000);
