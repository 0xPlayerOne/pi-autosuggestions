import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("package", () => {
  it("ships the built extension the pi manifest points at", () => {
    for (const entry of pkg.pi.extensions) {
      const resolved = join(root, entry);
      assert.ok(existsSync(resolved), `missing built extension: ${entry}`);
      const source = readFileSync(resolved, "utf8");
      assert.ok(source.length > 1000, `built extension looks empty: ${entry}`);
    }
  });

  it("keeps the install light (built output plus docs only)", () => {
    assert.deepEqual(pkg.files, ["dist", "README.md"]);
  });
});
