import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generate } from "../scripts/gen-modules.mjs";

function workspace(modules) {
  const root = mkdtempSync(join(tmpdir(), "friday-gen-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - modules/*\n");
  const portal = join(root, "packages", "portal");
  mkdirSync(portal, { recursive: true });
  writeFileSync(join(portal, "package.json"), JSON.stringify({ name: "@t/portal", dependencies: Object.fromEntries(modules.filter((m) => m.dep !== false).map((m) => [m.name, "workspace:*"])) }));
  for (const m of modules) {
    const dir = join(root, "modules", m.name.split("/")[1]);
    mkdirSync(join(dir, "src", "ui"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: m.name, friday: m.ui ? { ui: m.ui } : undefined }));
    if (m.ui && m.create !== false) writeFileSync(join(dir, m.ui), "export default {}");
  }
  return { root, portal };
}

test("writes an import per module with friday.ui, sorted, skipping modules without ui", () => {
  const { root, portal } = workspace([
    { name: "@t/zeta", ui: "./src/ui/index.ts" },
    { name: "@t/alpha", ui: "./src/ui/index.ts" },
    { name: "@t/plain" },
  ]);
  const out = join(portal, "src", "modules.gen.ts");
  assert.deepEqual(generate(portal, root, out), ["@t/alpha", "@t/zeta"]);
  const text = readFileSync(out, "utf8");
  assert.match(text, /import\("@t\/alpha\/ui"\),\n  \(\) => import\("@t\/zeta\/ui"\)/);
});

test("empty workspace writes an empty list", () => {
  const { root, portal } = workspace([]);
  const out = join(portal, "src", "modules.gen.ts");
  assert.deepEqual(generate(portal, root, out), []);
  assert.match(readFileSync(out, "utf8"), /= \[\n\];/);
});

test("fails naming the package when the ui path is missing or the portal lacks the dependency", () => {
  const a = workspace([{ name: "@t/broken", ui: "./src/ui/nope.ts", create: false }]);
  assert.throws(() => generate(a.portal, a.root, join(a.portal, "src", "m.ts")), /@t\/broken: friday\.ui points to/);
  const b = workspace([{ name: "@t/orphan", ui: "./src/ui/index.ts", dep: false }]);
  assert.throws(() => generate(b.portal, b.root, join(b.portal, "src", "m.ts")), /@t\/orphan declares a portal UI/);
});
