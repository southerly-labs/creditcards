import { parseSync } from "oxc-parser"
import { String as EffectString, Array as EffectArray, pipe } from "effect"

interface CommentRange {
  readonly start: number
  readonly end: number
}

const cssTokens =
  /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|url\((?:\\[\s\S]|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^)\\])*\)|\/\*[\s\S]*?(?:\*\/|$)/giu

const cssComment = (match: RegExpExecArray): ReadonlyArray<CommentRange> =>
  pipe(match[0], EffectString.startsWith("/*")) ? [{ start: match.index, end: match.index + match[0].length }] : []

export const findCodeComments = async (file: string, source: string): Promise<ReadonlyArray<CommentRange>> => {
  if (pipe(file, EffectString.endsWith(".css")))
    return EffectArray.flatMap([...source.matchAll(cssTokens)], (match) => cssComment(match))

  if (pipe(file, EffectString.endsWith(".html"))) {
    const ranges: Array<CommentRange> = []
    let cursor = 0
    await new HTMLRewriter()
      .onDocument({
        comments(comment) {
          const start = Math.max(cursor, source.indexOf(`<!--${comment.text}`, cursor))
          const end = source.indexOf("-->", start)
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
