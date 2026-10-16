import { buildStoreTools, findModelContext, registerStoreTools, callTool, makeSessionId } from "./webmcp.js";
import { runRuleAgent, runLlmAgent } from "./agent.js";
import { $, esc, art, notice, getJson, postJson, when, loadPayPal } from "./ui.js";

const state = {
  cfg: null,
  products: [],
  all: [],
  category: "",
  cart: JSON.parse(localStorage.getItem("leafline.cart") ?? "[]"),
  mandateId: sessionStorage.getItem("leafline.mandate"),
  session: sessionStorage.getItem("leafline.session") ?? makeSessionId(),
  agentOrderId: null,
  payment: null,
};
sessionStorage.setItem("leafline.session", state.session);

// ---------- catalog ----------
async function renderProducts() {
  const q = $("#search").value;
  const r = await getJson(`/api/products?limit=20&q=${encodeURIComponent(q)}`);
  state.products = r.items;
  const items = r.items.filter((p) => !state.category || p.category === state.category);
  $("#products").innerHTML =
    items
      .map(
        (p) => `<article class="card">${art(p.category)}<div class="body">
          <div class="name">${esc(p.name)}</div>
          <div class="desc">${esc(p.description)}</div>
          <div class="sku">${esc(p.sku)} - ${esc(p.category)}</div>
          <div class="row"><span class="price">${esc(p.price)} USD</span><button data-add="${esc(p.sku)}">Add to cart</button></div>
        </div></article>`,
      )
      .join("") || `<p class="muted">Nothing matches.</p>`;
}

// ---------- cart (human checkout) ----------
function saveCart() {
  localStorage.setItem("leafline.cart", JSON.stringify(state.cart));
  renderCart();
}
function renderCart() {
  const byS = Object.fromEntries(state.all.map((p) => [p.sku, p]));
  let cents = 0;
  $("#cart").innerHTML =
    state.cart
      .map((l) => {
        const p = byS[l.sku];
        if (p) cents += Math.round(Number(p.price) * 100) * l.quantity;
        return `<li><span>${l.quantity} x ${esc(p?.name ?? l.sku)}</span><span>${p ? esc((Number(p.price) * l.quantity).toFixed(2)) : ""} <button data-remove="${esc(l.sku)}" aria-label="Remove">x</button></span></li>`;
      })
      .join("") || `<li class="muted">Empty. Add something, or let an agent shop.</li>`;
  $("#cart-total").textContent = `${(cents / 100).toFixed(2)} USD`;
  const empty = state.cart.length === 0;
  $("#cart-pay").toggleAttribute("hidden", empty || !state.payment);
  $("#cart-pay-redirect").toggleAttribute("hidden", empty || Boolean(state.payment));
}

async function createCartOrder(flow) {
  const d = await postJson("/api/orders", { items: state.cart, ...(flow ? { flow } : {}) });
  return d;
}

// ---------- PayPal JS SDK v6 ----------
async function initPayPal() {
  try {
    state.payment = await loadPayPal(state.cfg, {
      async onApprove(data) {
        notice($("#cart-msg"), "info", "Payment approved, capturing...");
        try {
          await postJson(`/api/orders/${encodeURIComponent(data.orderId)}/capture`);
          if (data.orderId !== state.agentOrderId) {
            state.cart = [];
            saveCart();
          }
          location.href = `/order?id=${encodeURIComponent(data.orderId)}`;
        } catch (e) {
          notice($("#cart-msg"), "err", `Capture failed: ${e.message}`);
        }
      },
      async onCancel(data) {
        if (data?.orderId) await postJson(`/api/orders/${encodeURIComponent(data.orderId)}/cancel`).catch(() => {});
        notice($("#cart-msg"), "info", "Payment cancelled. Nothing was charged.");
        refreshMandate();
      },
      onError(err) {
        notice($("#cart-msg"), "err", `PayPal error: ${err?.message ?? err}`);
      },
    });
  } catch (e) {
    console.warn("PayPal SDK unavailable", e);
    state.payment = null;
  }
  renderCart();
  renderAgentOrder();
}

function startPayment(orderPromise) {
  // Do not await the order before start(): the popup must open in the click's user activation.
  return state.payment.start({ presentationMode: "auto" }, orderPromise).catch((e) => notice($("#cart-msg"), "err", `PayPal: ${e.message}`));
}

// ---------- mandate ----------
function renderMandate(m) {
  const box = $("#mandate-view");
  if (!m) {
    box.hidden = true;
    $("#mandate-form").hidden = false;
    $("#task-box").hidden = true;
    return;
  }
  const pct = Math.min(100, Math.round((Number(m.spent) / Number(m.budget)) * 100));
  box.hidden = false;
  $("#mandate-form").hidden = m.status === "ACTIVE";
  $("#task-box").hidden = m.status !== "ACTIVE";
  box.innerHTML = `<div class="mandate">
      <b>Mandate ${esc(m.status.toLowerCase())}</b> <span class="sku">${esc(m.mandateId)}</span>
      <div class="bar"><span style="width:${pct}%"></span></div>
      Spent ${esc(m.spent)} of ${esc(m.budget)} USD, <b>${esc(m.remaining)} left</b>${m.perOrderMax ? `, max ${esc(m.perOrderMax)} per order` : ""}<br>
      <span class="muted">Categories: ${esc(m.categories?.join(", ") ?? "any")}. Expires ${esc(when(m.expiresAt))}.</span>
      ${m.status === "ACTIVE" ? `<div style="margin-top:.4rem"><button id="m-revoke">Revoke</button></div>` : ""}
    </div>`;
}

async function refreshMandate() {
  if (!state.mandateId) return renderMandate(null);
  try {
    renderMandate(await getJson(`/api/mandates/${encodeURIComponent(state.mandateId)}`));
  } catch {
    state.mandateId = null;
    sessionStorage.removeItem("leafline.mandate");
    renderMandate(null);
  }
}

async function createMandate() {
  const cats = [...document.querySelectorAll("#m-cats input:checked")].map((i) => i.value);
  try {
    const m = await postJson("/api/mandates", {
      budget: Number($("#m-budget").value),
      per_order_max: $("#m-per").value ? Number($("#m-per").value) : undefined,
      categories: cats,
      ttl_minutes: Number($("#m-ttl").value),
    });
    state.mandateId = m.mandateId;
    sessionStorage.setItem("leafline.mandate", m.mandateId);
    renderMandate(m);
    addFeed({ say: `Budget delegated: ${m.budget} USD. Agents on this page now use mandate ${m.mandateId}.` });
  } catch (e) {
    addFeed({ say: `Could not create the mandate: ${e.message}`, err: true });
  }
}

// ---------- agent activity feed ----------
function addFeed(e) {
  const feed = $("#feed");
  if (feed.firstElementChild?.classList.contains("muted")) feed.innerHTML = "";
  const li = document.createElement("li");
  if (e.say) {
    li.className = e.err ? "err" : "say";
    li.textContent = e.say;
  } else {
    li.className = e.ok ? "ok" : "err";
    const res = e.ok ? summarize(e.tool, e.result) : e.result?.error ?? "error";
    li.innerHTML = `<span class="ms">${e.ms} ms</span><span class="t">${esc(e.tool)}</span> <code>${esc(JSON.stringify(e.args ?? {})).slice(0, 160)}</code><br>${esc(res)}`;
  }
  feed.prepend(li);
}

function summarize(tool, r) {
  if (tool === "search_products") return `${r.items?.length ?? 0} result(s): ${(r.items ?? []).slice(0, 3).map((p) => `${p.sku} ${p.price}`).join(", ")}`;
  if (tool === "get_budget") return `${r.remaining} of ${r.budget} USD left (${r.status})`;
  if (tool === "create_order") return `order ${r.orderId} ${r.total}, waiting for buyer approval`;
  if (tool === "get_order_status") return `${r.orderId} ${r.status}`;
  if (tool === "request_refund" || tool === "open_dispute") return `${r.claimId} ${r.kind} opened`;
  return JSON.stringify(r).slice(0, 120);
}

// ---------- WebMCP + in-page agent ----------
let mc = null;
let tools = [];
async function initWebMCP() {
  tools = buildStoreTools({
    session: state.session,
    getMandate: () => state.mandateId,
    onCall: (e) => {
      addFeed(e);
      if (["create_order", "get_budget"].includes(e.tool)) refreshMandate();
    },
  });
  mc = findModelContext();
  const result = await registerStoreTools(mc, tools);
  window.__webmcpStatus = { ...result, native: window.__nativeWebMCP, polyfill: !window.__nativeWebMCP && Boolean(mc) };
  const badge = $("#webmcp-badge");
  if (result.ok) {
    badge.className = "badge";
    badge.innerHTML = `<span class="dot"></span>WebMCP: ${window.__nativeWebMCP ? "native Chrome" : "MCP-B polyfill"}, ${result.tools.length} tools`;
  } else {
    badge.className = "badge bad";
    badge.innerHTML = `<span class="dot"></span>WebMCP unavailable`;
    badge.title = result.error;
  }
}

async function runAgent() {
  const task = $("#task").value.trim();
  if (!task) return;
  const btn = $("#run-agent");
  btn.disabled = true;
  addFeed({ say: `Buyer: ${task}` });
  const call = (name, args) => callTool(mc, tools, name, args);
  const log = (m) => console.log("[agent]", m);
  let r;
  try {
    if (state.cfg.llm) {
      try {
        r = await runLlmAgent(task, { call, tools, log, step: (body) => fetch("/api/agent/step", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json()) });
        $("#planner-note").textContent = `Planner: LLM (${r.provider ?? "server"} ${r.model ?? ""}).`;
      } catch (e) {
        if (!e.fallback) throw e;
        $("#planner-note").textContent = "LLM unavailable right now; the rule-based planner took over.";
        r = await runRuleAgent(task, { call, log });
      }
    } else {
      $("#planner-note").textContent = "Planner: rule-based (no LLM key on this server).";
      r = await runRuleAgent(task, { call, log });
    }
    addFeed({ say: `Agent: ${r.answer}` });
    if (r.orderId) {
      state.agentOrderId = r.orderId;
      sessionStorage.setItem("leafline.agentOrder", r.orderId);
      renderAgentOrder();
    }
  } catch (e) {
    addFeed({ say: `Agent failed: ${e.message}`, err: true });
  } finally {
    btn.disabled = false;
    refreshMandate();
  }
}

async function renderAgentOrder() {
  const id = state.agentOrderId;
  $("#agent-order").hidden = !id;
  if (!id) return;
  try {
    const o = await getJson(`/api/orders/${encodeURIComponent(id)}`);
    if (o.status === "COMPLETED" || o.status === "CANCELLED") {
      $("#agent-order-text").innerHTML = `Agent order <a href="/order?id=${encodeURIComponent(id)}">${esc(id)}</a> is ${esc(o.status.toLowerCase())}.`;
      $("#agent-pay").hidden = true;
      $("#agent-pay-link").hidden = true;
      return;
    }
    $("#agent-order-text").innerHTML = `Your agent prepared order <b>${esc(id)}</b>: ${esc(o.items.map((i) => `${i.quantity} x ${i.name}`).join(", "))}, <b>${esc(o.total)}</b>. Approve it in PayPal:`;
    $("#agent-pay").hidden = !state.payment;
    const link = $("#agent-pay-link");
    link.hidden = false;
    link.href = `https://www.sandbox.paypal.com/checkoutnow?token=${encodeURIComponent(id)}`;
  } catch {
    $("#agent-order").hidden = true;
  }
}

// ---------- events ----------
document.addEventListener("click", (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  if (t.dataset.add) {
    const l = state.cart.find((x) => x.sku === t.dataset.add);
    if (l) l.quantity = Math.min(10, l.quantity + 1);
    else state.cart.push({ sku: t.dataset.add, quantity: 1 });
    saveCart();
  } else if (t.dataset.remove) {
    state.cart = state.cart.filter((x) => x.sku !== t.dataset.remove);
    saveCart();
  } else if (t.dataset.cat !== undefined) {
    state.category = t.dataset.cat;
    document.querySelectorAll("#cats .chip").forEach((c) => c.classList.toggle("on", c === t));
    renderProducts();
  } else if (t.dataset.task) {
    $("#task").value = t.dataset.task;
  } else if (t.id === "m-create") {
    createMandate();
  } else if (t.id === "m-revoke") {
    postJson(`/api/mandates/${encodeURIComponent(state.mandateId)}/revoke`).then(renderMandate).then(() => addFeed({ say: "Mandate revoked: agent orders are refused from now on." }));
  } else if (t.id === "run-agent") {
    runAgent();
  } else if (t.id === "cart-pay-redirect") {
    createCartOrder("redirect")
      .then((d) => (location.href = d.approveUrl))
      .catch((err) => notice($("#cart-msg"), "err", err.message));
  }
});
$("#cart-pay").addEventListener("click", () => {
  notice($("#cart-msg"), "", "");
  startPayment(createCartOrder().then((d) => ({ orderId: d.orderId })));
});
$("#agent-pay").addEventListener("click", () => startPayment(Promise.resolve({ orderId: state.agentOrderId })));
$("#search").addEventListener("input", () => renderProducts());

(async function main() {
  state.cfg = await getJson("/api/config");
  $("#version").textContent = `Build ${state.cfg.version}.`;
  state.agentOrderId = sessionStorage.getItem("leafline.agentOrder");
  state.all = (await getJson("/api/products?limit=20&q=")).items;
  state.cart = state.cart.filter((l) => state.all.some((p) => p.sku === l.sku));
  await renderProducts();
  renderCart();
  await initWebMCP();
  await refreshMandate();
  initPayPal();
})();
