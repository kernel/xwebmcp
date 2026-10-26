import assert from "node:assert/strict";
import test from "node:test";
import { measure, selectorScore, stripComments } from "../scripts/tool-metrics.mjs";

test("comment stripping leaves strings and regex literals alone", () => {
  const code = 'const a = "https://x.com/*"; /* gone */ const r = /a*\\//g; const d = x / y; // gone\nreturn 1';
  const stripped = stripComments(code);
  assert.ok(stripped.includes('"https://x.com/*"'));
  assert.ok(stripped.includes("/a*\\//g"));
  assert.ok(stripped.includes("x / y"));
  assert.ok(!stripped.includes("gone"));
});

test("a URL pattern does not hide the code after it", () => {
  const counted = measure('[{ url_patterns: ["https://x.com/*"], execute() { if (a) return b; } }] /* */').branches;
  assert.equal(counted, 1);
});

test("generated classes and positions score as brittle, attributes as stable", () => {
  assert.ok(selectorScore(".b5cd09854e .f6431b446c") > selectorScore('[data-testid="price"]'));
  assert.ok(selectorScore("li:nth-child(3) a") > selectorScore('button[aria-label="Next"]'));
});
