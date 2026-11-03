import { BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Schema } from "effect"
import index from "./index.html"
import table from "./table.html"

class ServeFailed extends Schema.TaggedError<ServeFailed, { readonly brand: unique symbol }>()("ServeFailed", {
  message: Schema.String
}) {}

const DevServer = Layer.effectDiscard(
  Effect.gen(function* () {
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000))

    const server = yield* Effect.try({
      try: () =>
        Bun.serve({
          port,
          development: true,
          routes: {
            "/": index,
            "/table": table,
            "/api.json": () => new Response(Bun.file("dist/api.json"))
          }
        }),
      catch: (cause) => ServeFailed.make({ message: String(cause) })
    })

    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))

    yield* Console.log(`Listening on ${server.url}`)
  })
)

BunRuntime.runMain(Layer.launch(DevServer))
