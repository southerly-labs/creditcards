// Bundles the static site into dist/ next to api.json, ready for Cloudflare.
const result = await Bun.build({
  entrypoints: ["web/index.html"],
  outdir: "dist",
  minify: true
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`Wrote ${result.outputs.length} site files to dist/`)

export {}
