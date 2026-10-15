import { buildStoreTools, findModelContext, registerStoreTools } from "./webmcp.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function render(query = "") {
  const r = await fetch(`/api/products?limit=20&q=${encodeURIComponent(query)}`).then((x) => x.json());
  $("#products").innerHTML = r.items
    .map((p) => `<li><b>${esc(p.name)}</b> — ${esc(p.price)} USD <small>${esc(p.sku)}</small>
      <button data-sku="${esc(p.sku)}">Buy with PayPal</button></li>`)
    .join("");
}

async function buy(sku) {
  const r = await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ sku, quantity: 1 }] }) });
  const d = await r.json();
  if (d.approveUrl) location.href = d.approveUrl;
  else $("#msg").textContent = d.error ?? "error";
}

async function showOrder(id) {
  const [o, log] = await Promise.all([
    fetch(`/api/orders/${encodeURIComponent(id)}`).then((x) => x.json()),
    fetch(`/api/orders/${encodeURIComponent(id)}/agent-log`).then((x) => x.json()),
  ]);
  $("#order").textContent = JSON.stringify({ order: o, agentReceipt: log }, null, 2);
}

async function initWebMCP() {
  const mc = findModelContext();
  const result = await registerStoreTools(mc, buildStoreTools());
  window.__webmcpStatus = result;
  $("#webmcp").textContent = JSON.stringify(result);
}

document.addEventListener("click", (e) => {
  const sku = e.target?.dataset?.sku;
  if (sku) buy(sku);
});
$("#search").addEventListener("input", (e) => render(e.target.value));
render();
initWebMCP();
const params = new URLSearchParams(location.search);
if (params.get("order")) showOrder(params.get("order"));
