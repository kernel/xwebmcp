import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compose } from "../scripts/compose.mjs";

test("compose inlines any lib/ snippet into page or cdp tools and rejects unknown snippets", () => {
  const root = mkdtempSync(join(tmpdir(), "xwebmcp-compose-lib-"));
  try {
    mkdirSync(join(root, "domains", "example.com"), { recursive: true });
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib", "shared-model.js"), "const shared = () => 1;\n");
    writeFileSync(join(root, "registry.json"), JSON.stringify({ tools: [{ file: "domains/example.com/test.js", kind: "page" }] }));
    const file = join(root, "domains", "example.com", "test.js");
    writeFileSync(file, "[{ execute: async () => {\n    // @xwebmcp-inline lib/shared-model.js\n    // @xwebmcp-end\n    return shared();\n} }]");
    assert.equal(compose(root, true).length, 1);
    assert.deepEqual(compose(root), []);
    assert.deepEqual(compose(root, true), []);
    assert.match(readFileSync(file, "utf8"), /\n    const shared = \(\) => 1;\n    \/\/ @xwebmcp-end/);
    writeFileSync(file, readFileSync(file, "utf8").replace("shared-model", "missing-model"));
    assert.match(compose(root, true)[0], /unknown inline snippet lib\/missing-model\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
