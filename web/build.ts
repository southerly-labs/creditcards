import { rm } from "node:fs/promises"

await rm("dist/assets", { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ["web/index.html", "web/table.html"],
  outdir: "dist",
  minify: true,
  splitting: true,

  naming: { chunk: "assets/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" }
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

await Bun.write(
  "dist/_headers",
  `/assets/*
  Cache-Control: public, max-age=31536000, immutable
`
)

console.log(`Wrote ${result.outputs.length} site files to dist/`)
