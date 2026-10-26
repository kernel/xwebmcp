import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Tool files cannot import, so the amazon.com tools copy shared blocks between // @<marker>: and
// // @<marker>-end comments; each copy must stay byte-identical.
const allTools = ["get_cart", "add_to_cart", "update_cart_item", "get_product", "search_products", "get_best_sellers"];
const cartTools = ["get_cart", "add_to_cart", "update_cart_item"];
const writes = ["add_to_cart", "update_cart_item"];
const sources = Object.fromEntries(allTools.map(n => [n, readFileSync(new URL(`../domains/amazon.com/${n}.js`, import.meta.url), "utf8")]));
const plain = x => JSON.parse(JSON.stringify(x));

const block = (source, marker) => {
  const start = source.indexOf(`// @${marker}:`), end = source.indexOf(`// @${marker}-end`);
  assert.ok(start >= 0 && end > start, marker);
  return source.slice(start, end);
};
for (const [marker, files] of [
  ["amazon-page-fetch", allTools],
  ["amazon-text", ["get_product", "add_to_cart", "search_products", "get_best_sellers"]],
  ["amazon-cart-reader", cartTools],
  ["amazon-cart-writer", writes],
  ["amazon-offer-reader", ["get_product", "add_to_cart"]]
]) {
  test(`${marker} is byte-identical in ${files.join(", ")}`, () => {
    const [first, ...rest] = files.map(n => block(sources[n], marker));
    for (const other of rest) assert.equal(other, first);
  });
}
test("cart tools return the same cart snapshot schema", () => {
  const snapshotKeys = ["session_context", "cart_version", "lines", "items_quantity", "subtotal_cents", "other_carts_present"];
  const [first, ...rest] = cartTools.map(n => {
    const props = runInNewContext(`(${sources[n]})`)[0].tool.outputSchema.oneOf[0].properties;
    return plain(Object.fromEntries(snapshotKeys.map(k => [k, props[k]])));
  });
  for (const other of rest) assert.deepEqual(other, first);
});
