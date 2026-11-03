import { parseSync } from "oxc-parser"
import { String as EffectString, Array as EffectArray, pipe, Option } from "effect"

interface CommentRange {
  readonly start: number
  readonly end: number
}

const cssTokens =
  /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|url\((?:\\[\s\S]|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^)\\])*\)|\/\*[\s\S]*?(?:\*\/|$)/giu

const indexFrom = (text: string, search: string, from: number): number =>
  pipe(
    text,
    EffectString.slice(from),
    EffectString.indexOf(search),
    Option.map((i) => i + from),
    Option.getOrElse(() => -1)
  )

const cssComment = (match: RegExpMatchArray): ReadonlyArray<CommentRange> => {
  const start = match.index ?? 0

  return pipe(match[0], EffectString.startsWith("/*")) ? [{ start, end: start + match[0].length }] : []
}

export const findCodeComments = async (file: string, source: string): Promise<ReadonlyArray<CommentRange>> => {
  if (pipe(file, EffectString.endsWith(".css")))
    return EffectArray.flatMap([...pipe(source, EffectString.matchAll(cssTokens))], (match) => cssComment(match))

  if (pipe(file, EffectString.endsWith(".html"))) {
    const ranges: Array<CommentRange> = []
    let cursor = 0
    await new HTMLRewriter()
      .onDocument({
        comments(comment) {
          const start = Math.max(cursor, indexFrom(source, `<!--${comment.text}`, cursor))
          const end = indexFrom(source, "-->", start)
          ranges.push({ start, end: end === -1 ? source.length : end + 3 })
          cursor = start + 4
        }
      })
      .transform(new Response(source))
      .text()

    return ranges
  }

  return parseSync(file, source).comments
}
