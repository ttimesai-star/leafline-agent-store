import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlm } from "../src/llm.ts";

const ok = (name: string) => new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: "{}" } }] } }] }), { status: 200 });

test("several Gemini keys: a quota error moves to the next key, then Mistral; no retry on 429", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    const key = String(init.headers.authorization).slice(7);
    seen.push(`${new URL(url).host}:${key}`);
    if (key === "g1" || key === "g2") return new Response("quota", { status: 429 });
    return ok("search_products");
  }) as any;
  const llm = createLlm({ GEMINI_API_KEY: "g1, g2 ,g3", MISTRAL_API_KEY: "m1" } as any, fetchImpl)!;
  const r = await llm.chat([{ role: "user", content: "tea" }]);
  assert.equal(r.provider, "gemini#3");
  assert.equal(r.model, "gemini-3-flash-preview");
  assert.deepEqual(seen, ["generativelanguage.googleapis.com:g1", "generativelanguage.googleapis.com:g2", "generativelanguage.googleapis.com:g3"]);
});

test("all Gemini keys out of quota -> Mistral; Groq only when a model is named", async () => {
  const fetchImpl = (async (url: string) => (url.includes("mistral") ? ok("get_budget") : new Response("quota", { status: 429 }))) as any;
  const llm = createLlm({ GEMINI_API_KEY: "g1", MISTRAL_API_KEY: "m1", GROQ_API_KEY: "q1" } as any, fetchImpl)!;
  const r = await llm.chat([{ role: "user", content: "tea" }]);
  assert.equal(r.provider, "mistral");
  assert.equal(r.model, "ministral-14b-latest");
  assert.equal(createLlm({ GROQ_API_KEY: "q1" } as any), null, "Groq without GROQ_MODEL is not used (its old default model is gone)");
});
