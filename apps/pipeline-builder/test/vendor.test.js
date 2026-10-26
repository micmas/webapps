import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const vendor = new URL("../vendor/neuroflow/", import.meta.url);
const provenance = JSON.parse(readFileSync(new URL("provenance.json", vendor), "utf8"));

test("vendored NeuroFlow files match their recorded hashes", () => {
  for (const [name, sha256] of Object.entries(provenance.files)) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(name, vendor))).digest("hex"), sha256, name);
  }
  assert.match(provenance.commit, /^[0-9a-f]{40}$/);
});
