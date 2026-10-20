import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import { zipDirectory } from "../lib/zip.mjs";

// Reads each entry through the central directory and its local header, checking that the two agree.
function unzip(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const [crc, size, nameLength, offset] = [zip.readUInt32LE(at + 16), zip.readUInt32LE(at + 20), zip.readUInt16LE(at + 28), zip.readUInt32LE(at + 42)];
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    assert.equal(zip.readUInt16LE(offset + 8), 0, "stored");
    assert.equal(zip.toString("utf8", offset + 30, offset + 30 + nameLength), name);
    const data = zip.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    assert.equal(crc32(data), crc);
    assert.equal(zip.readUInt32LE(offset + 14), crc);
    entries.push([name, data.toString("utf8")]);
    at += 46 + nameLength;
  }
  assert.equal(at, end);
  return entries;
}

test("a directory zips to its files, sorted by path, the same bytes every time", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-zip-"));
  mkdirSync(join(dir, "lib/é"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), "{}\n");
  writeFileSync(join(dir, "lib/guard.js"), "guard();\n");
  writeFileSync(join(dir, "lib.js"), "lib();\n");
  writeFileSync(join(dir, "lib/é/rules.json"), "[]\n");
  writeFileSync(join(dir, "Empty"), "");
  const zip = zipDirectory(dir);
  assert.deepEqual(unzip(zip), [["Empty", ""], ["lib.js", "lib();\n"], ["lib/guard.js", "guard();\n"], ["lib/é/rules.json", "[]\n"], ["manifest.json", "{}\n"]]);
  assert.ok(zipDirectory(dir).equals(zip));
});
