#!/usr/bin/env node
// Publishes src/Resources/app/administration/src/main.js as the plugin's admin
// bundle (src/Resources/public/administration), in the layout Shopware 6.7's
// Vite admin build produces: assets/<name>-<hash>.js plus .vite/manifest.json
// and .vite/entrypoints.json. main.js has no imports, so no bundling is needed
// and the Shopware admin toolchain doesn't have to be installed.
// `bin/build-administration.sh` in a Shopware checkout produces the same thing.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = "demo-split-shipment";
const bundle = "demosplitshipment";
const source = readFileSync(join(root, "src/Resources/app/administration/src/main.js"), "utf8");

if (/^\s*import\s/m.test(source)) {
  throw new Error("main.js imports other files; build it with the Shopware admin toolchain instead.");
}

const hash = createHash("sha256").update(source).digest("base64url").slice(0, 8);
const file = `assets/${name}-${hash}.js`;
const out = join(root, "src/Resources/public/administration");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });
mkdirSync(join(out, ".vite"), { recursive: true });

writeFileSync(join(out, file), source);
writeFileSync(
  join(out, ".vite/manifest.json"),
  `${JSON.stringify({ "main.js": { file, name, src: "main.js", isEntry: true } }, null, 2)}\n`,
);
writeFileSync(
  join(out, ".vite/entrypoints.json"),
  `${JSON.stringify(
    {
      base: `/bundles/${bundle}/administration/`,
      entryPoints: {
        [name]: { css: [], dynamic: [], js: [`/bundles/${bundle}/administration/${file}`], legacy: false, preload: [] },
      },
      legacy: false,
      metadatas: {},
      version: ["7.1.0", 7, 1, 0],
      viteServer: null,
    },
    null,
    2,
  )}\n`,
);

console.log(`Built ${file}`);
