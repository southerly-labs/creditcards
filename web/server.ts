// Local dev server: serves the table page and the built dist/api.json.
import index from "./index.html"

const server = Bun.serve({
  port: Number(process.env["PORT"] ?? 3000),
  development: true,
  routes: {
    "/": index,
    "/api.json": () => new Response(Bun.file("dist/api.json"))
  }
})

console.log(`Listening on ${server.url}`)
