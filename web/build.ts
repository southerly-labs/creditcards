// Bundles the static site into dist/ next to api.json, ready for Cloudflare.
const result = await Bun.build({
  entrypoints: ["web/index.html"],
  outdir: "dist",
  minify: true,
  // Content-hashed names, so these files can be cached forever (see _headers).
  naming: { chunk: "assets/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" }
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// index.html and api.json keep Cloudflare's default (revalidate every time).
await Bun.write(
  "dist/_headers",
  `/assets/*
  Cache-Control: public, max-age=31536000, immutable
`
)

console.log(`Wrote ${result.outputs.length} site files to dist/`)
