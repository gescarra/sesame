// Bundles a Lambda package entry point into dist/ for deployment.
// Usage (from a package dir): node ../../scripts/bundle.mjs [--include-aws-sdk] src/handler.ts [more entries...]
import { build } from "esbuild";

const args = process.argv.slice(2);
// Lambda Event Functions ship AWS SDK v3. Web Functions don't document it, so the API bundles its own.
const includeAwsSdk = args.includes("--include-aws-sdk");
const entryPoints = args.filter((a) => !a.startsWith("--"));
if (entryPoints.length === 0) {
  console.error("usage: bundle.mjs [--include-aws-sdk] <entry> [entry...]");
  process.exit(1);
}

await build({
  entryPoints,
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  minify: true,
  outExtension: { ".js": ".mjs" },
  external: includeAwsSdk ? [] : ["@aws-sdk/*"],
  // ESM bundles need a require shim for CJS dependencies.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
