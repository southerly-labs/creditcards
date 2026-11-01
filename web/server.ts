import index from "./index.html"
import table from "./table.html"

const server = Bun.serve({
  port: Number(process.env["PORT"] ?? 3000),
  development: true,
  routes: {
    "/": index,
    "/table": table,
    "/api.json": () => new Response(Bun.file("dist/api.json"))
  }
})

console.log(`Listening on ${server.url}`)
