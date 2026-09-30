import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/tiktok.com/search.js", import.meta.url), "utf8");
const page = "https://www.tiktok.com/search/video?q=example";
const videoId = "7000000000000000001";
function card(href = `/@example_creator/video/${videoId}`, preview = "Fabricated caption", likes = "1.2K", shown = true) {
  const visibility = { checkVisibility: () => shown, closest: () => null };
  return { ...visibility, innerText: preview, querySelector: selector => selector.startsWith("a[") ? { ...visibility, getAttribute: () => href } : selector.includes("video-views") ? { ...visibility, innerText: likes } : { ...visibility, innerText: preview } };
}
function conforms(s, v) {
  if ("const" in s) assert.equal(v, s.const);
  if (s.enum) assert.ok(s.enum.includes(v));
  if (s.oneOf) assert.equal(s.oneOf.filter(b => { try { conforms(b, v); return true; } catch { return false; } }).length, 1);
  if (s.type) assert.ok([s.type].flat().some(t => t === "null" ? v === null : t === "array" ? Array.isArray(v) : t === "integer" ? Number.isInteger(v) : t === "object" ? v && typeof v === "object" && !Array.isArray(v) : typeof v === t));
  if (v && typeof v === "object" && !Array.isArray(v) && s.properties) {
    for (const k of s.required || []) assert.ok(Object.hasOwn(v, k));
    if (s.additionalProperties === false) for (const k of Object.keys(v)) assert.ok(Object.hasOwn(s.properties, k));
    for (const [k, p] of Object.entries(s.properties)) if (Object.hasOwn(v, k)) conforms(p, v[k]);
  }
  if (typeof v === "string") {
    assert.ok(v.length >= (s.minLength ?? 0) && v.length <= (s.maxLength ?? Infinity));
    if (s.pattern) assert.match(v, new RegExp(s.pattern));
  }
  if (typeof v === "number") assert.ok(v >= (s.minimum ?? -Infinity) && v <= (s.maximum ?? Infinity));
  if (Array.isArray(v)) {
    assert.ok(v.length >= (s.minItems ?? 0) && v.length <= (s.maxItems ?? Infinity));
    if (s.items) for (const item of v) conforms(s.items, item);
  }
}
function harness(o = {}) {
  let reads = 0;
  const ctx = { URL, Date, NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }, location: { get href() { reads++; return o.url ?? page; } }, document: {
    createTreeWalker: (root, mask, filter) => {
      assert.equal(mask, 5);
      const stack = [...(root.childNodes || [{ nodeType: 3, textContent: root.innerText || "" }])].reverse();
      return { nextNode: () => {
        while (stack.length) {
          const node = stack.pop();
          if (filter.acceptNode(node) === 2) continue;
          if (node.childNodes) stack.push(...[...node.childNodes].reverse());
          return node;
        }
        return null;
      } };
    },
    title: o.title ?? "TikTok", body: { innerText: o.text ?? "Video results" }, querySelectorAll: selector => {
      assert.equal(selector, '[id^="grid-item-container-"]'); reads++; return o.cards ?? [card()];
    }
  } };
  const d = runInNewContext(source, ctx)[0];
  const execute = runInNewContext(`(${d.execute.toString()})`, ctx);
  return { def: d, get reads() { return reads; }, run: async (input = { query: "example" }, context = {}) => {
    const out = JSON.parse(JSON.stringify(await execute(input, context)));
    conforms(d.tool.outputSchema, out);
    return out;
  } };
}

test("search reads bounded rendered cards without network/navigation globals", async () => {
  const h = harness();
  const out = await h.run();
  assert.equal(h.def.kind, "page");
  assert.equal(out.status, "ok");
  assert.deepEqual(out.results[0], { video_id: videoId, username: "example_creator", url: `https://www.tiktok.com/@example_creator/video/${videoId}`, preview_text: "Fabricated caption", likes_text: "1.2K" });
});

test("search invalid input fails before page reads", async () => {
  for (const input of [null, [], {}, { query: "" }, { query: "  " }, { query: "a".repeat(101) }, { query: "x\u0000" }, { query: "\ud800" }, { query: 3 }, { query: "example", extra: true }, ...[null, 0, 21, 1.5, "3"].map(max_results => ({ query: "example", max_results }))]) {
    const h = harness();
    assert.equal((await h.run(input)).error_kind, "invalid_input");
    assert.equal(h.reads, 0);
  }
});

test("search wrong page includes encoded canonical handoff without navigating", async () => {
  for (const url of ["https://example.com/", "https://shop.tiktok.com/search/video?q=example", "https://www.tiktok.com/", "https://www.tiktok.com/search?q=example", "https://www.tiktok.com/search/video?q=other", page + "&q=other"]) {
    const h = harness({ url });
    const out = await h.run();
    assert.equal(out.error_kind, "wrong_page");
    assert.equal(out.entry_url, page);
    assert.equal(h.reads, 1);
  }
  assert.equal((await harness({ url: "https://www.tiktok.com/" }).run({ query: "<text> & 👋" })).entry_url, "https://www.tiktok.com/search/video?q=%3Ctext%3E%20%26%20%F0%9F%91%8B");
});

test("search gates and unrecognized loading state stay explicit", async () => {
  for (const [o, error] of [[{ title: "Security Check" }, "challenge"], [{ text: "Drag the slider" }, "challenge"], [{ text: "Log in to search for popular content" }, "login_required"], [{ cards: [] }, "site_changed"]]) assert.equal((await harness(o).run()).error_kind, error);
  const h = harness();
  assert.equal((await h.run(undefined, { signal: { aborted: true } })).error_kind, "canceled");
  assert.equal(h.reads, 0);
});

test("search skips foreign/unsafe/photo/live links, strips tracking, deduplicates", async () => {
  const cards = [card("https://example.com/@example_creator/video/7000000000000000001"), card("https://u:secret@www.tiktok.com/@example_creator/video/7000000000000000001"), card("/@example_creator/photo/7000000000000000001"), card("/@example_creator/live"), card("/@example_creator/video/7000000000000000001?token=DO_NOT_RETURN#fragment"), card()];
  const out = await harness({ cards }).run();
  assert.equal(out.results.length, 1);
  assert.ok(!JSON.stringify(out).includes("DO_NOT_RETURN"));
  assert.equal((await harness({ cards: [card("/@example_creator/photo/7000000000000000001")] }).run()).status, "no_results");
});

test("search output and extraction scan are capped", async () => {
  const cards = Array.from({ length: 100 }, (_, i) => card(`/@example_creator/video/${7000000000000000000n + BigInt(i)}`, "a".repeat(5000), "9".repeat(50)));
  const out = await harness({ cards }).run({ query: "example", max_results: 20 });
  assert.equal(out.results.length, 20);
  assert.ok(out.results.every(v => v.preview_text.length === 500 && v.likes_text.length === 30));
  assert.ok(JSON.stringify(out).length < 16000);
  const skipped = Array.from({ length: 40 }, () => card("/@example_creator/live"));
  assert.equal((await harness({ cards: [...skipped, card()] }).run()).status, "no_results");
});

test("search skips hidden cards before applying the result limit", async () => {
  const hidden = card(`/@hidden_creator/video/${videoId}`, "Hidden content", "9", false);
  const out = await harness({ cards: [hidden, card()] }).run({ query: "example", max_results: 1 });
  assert.equal(out.status, "ok");
  assert.equal(out.results[0].username, "example_creator");
  assert.ok(!JSON.stringify(out).includes("Hidden content"));
});

test("search never returns hidden links, previews or likes", async () => {
  const hiddenLink = card();
  const selector = hiddenLink.querySelector;
  hiddenLink.querySelector = s => ({ ...selector(s), checkVisibility: () => !s.startsWith("a[") });
  assert.equal((await harness({ cards: [hiddenLink] }).run()).status, "no_results");
  const visibleCard = card();
  const select = visibleCard.querySelector;
  visibleCard.querySelector = s => ({ ...select(s), checkVisibility: () => s.startsWith("a[") });
  const out = await harness({ cards: [visibleCard] }).run();
  assert.equal(out.results[0].preview_text, "");
  assert.equal(out.results[0].likes_text, null);
  const ariaHidden = card();
  ariaHidden.closest = () => ({});
  assert.equal((await harness({ cards: [ariaHidden] }).run()).status, "no_results");
});

test("search excludes hidden descendants inside visible previews and likes", async () => {
  const result = card();
  const select = result.querySelector;
  const hidden = { nodeType: 1, checkVisibility: () => false, closest: () => null, childNodes: [{ nodeType: 3, textContent: "HIDDEN_TEXT" }] };
  const aria = { nodeType: 1, checkVisibility: () => true, closest: () => ({}), childNodes: [{ nodeType: 3, textContent: "ARIA_HIDDEN_TEXT" }] };
  result.querySelector = s => s.startsWith("a[") ? select(s) : { ...select(s), childNodes: [{ nodeType: 3, textContent: s.includes("video-views") ? "3" : "Visible caption" }, hidden, aria] };
  const out = await harness({ cards: [result] }).run();
  assert.equal(out.results[0].preview_text, "Visible caption");
  assert.equal(out.results[0].likes_text, "3");
  assert.ok(!JSON.stringify(out).includes("HIDDEN_TEXT"));
});

test("search caps text traversal even when text nodes are empty", async () => {
  const result = card();
  const select = result.querySelector;
  result.querySelector = s => s.startsWith("a[") ? select(s) : { ...select(s), childNodes: [...Array.from({ length: 1000 }, () => ({ nodeType: 3, textContent: "" })), { nodeType: 3, textContent: "OUTSIDE_SCAN_BOUND" }] };
  const out = await harness({ cards: [result] }).run();
  assert.equal(out.results[0].preview_text, "");
  assert.equal(out.results[0].likes_text, null);
});

test("search schemas define exact discriminated shapes", () => {
  const d = harness().def;
  assert.equal(d.tool.outputSchema.oneOf.length, 3);
  for (const branch of d.tool.outputSchema.oneOf) assert.equal(branch.additionalProperties, false);
  assert.equal(d.tool.outputSchema.oneOf[0].properties.results.maxItems, 20);
});
