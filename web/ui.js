// Small shared UI helpers (no framework).
export const $ = (s, root = document) => root.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICONS = {
  tea: '<path d="M32 8c-14 0-24 10-24 24 0 8 4 14 4 14s4-14 18-22C20 32 16 42 16 50c0 0 22 2 32-14 6-10 6-20 6-28-6 0-14 0-22 0z" fill="currentColor"/>',
  coffee: '<ellipse cx="32" cy="32" rx="16" ry="22" transform="rotate(30 32 32)" fill="currentColor"/><path d="M22 18c10 6 10 22 20 28" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>',
  teaware: '<path d="M12 22h32v14a16 16 0 0 1-32 0z" fill="currentColor"/><path d="M44 26h4a7 7 0 0 1 0 14h-5" stroke="currentColor" stroke-width="4" fill="none"/><rect x="10" y="54" width="36" height="4" rx="2" fill="currentColor"/>',
  gift: '<rect x="10" y="24" width="44" height="32" rx="3" fill="currentColor"/><rect x="8" y="18" width="48" height="10" rx="2" fill="currentColor" opacity=".8"/><rect x="29" y="18" width="6" height="38" fill="#fff" opacity=".9"/><path d="M32 18c-6-10-16-6-10 0zM32 18c6-10 16-6 10 0z" fill="currentColor"/>',
};
const TINTS = { tea: ["#e7f1e9", "#2f6b4f"], coffee: ["#f3ebe3", "#6b4428"], teaware: ["#e9eef3", "#35506b"], gift: ["#f6ecef", "#8a3550"] };

export function art(category) {
  const [bg, fg] = TINTS[category] ?? TINTS.tea;
  return `<div class="art" style="background:${bg};color:${fg}"><svg viewBox="0 0 64 64" aria-hidden="true">${ICONS[category] ?? ICONS.tea}</svg></div>`;
}

export function notice(el, kind, text) {
  el.innerHTML = text ? `<div class="notice ${kind}">${esc(text)}</div>` : "";
}

export async function getJson(url, opts) {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error ?? `HTTP ${r.status}`), { status: r.status, data: d });
  return d;
}

export const postJson = (url, body) => getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

export function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

/**
 * PayPal JS SDK v6 (web-sdk/v6/core): load once, create an instance with the public client id, and return a
 * one-time payment session, or null when PayPal is not eligible / the SDK failed (callers show a fallback).
 */
let sdkPromise = null;
export function loadPayPal(cfg, callbacks) {
  sdkPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = cfg.sdkUrl;
    s.async = true;
    s.onload = () => resolve(window.paypal);
    s.onerror = () => reject(new Error("PayPal SDK failed to load"));
    document.head.appendChild(s);
  });
  return sdkPromise.then(async (paypal) => {
    const sdk = await paypal.createInstance({ clientId: cfg.clientId, components: ["paypal-payments"], pageType: "checkout" });
    const methods = await sdk.findEligibleMethods({ currencyCode: cfg.currency ?? "USD" });
    if (!methods.isEligible("paypal")) return null;
    const session = sdk.createPayPalOneTimePaymentSession(callbacks);
    // Show buttons only once the SDK has defined <paypal-button>: a click on a not-yet-upgraded element
    // (seen in tests within ~100 ms of page load) silently opens nothing.
    await Promise.race([customElements.whenDefined("paypal-button"), new Promise((r) => setTimeout(r, 5000))]);
    return session;
  });
}
