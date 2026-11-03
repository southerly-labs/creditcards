import { findCodeComments } from "./comment-policy.ts"
import { Array as EffectArray, String as EffectString, pipe } from "effect"

const roots = ["src", "web", "test", "tools"]
const extensions = "**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,css,html}"
const requested = process.argv.slice(2)

const files =
  requested.length > 0
    ? requested
    : EffectArray.filter(
        [
          ...new Bun.Glob("*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,css,html}").scanSync({ onlyFiles: true, dot: true }),
          ...EffectArray.flatMap(roots, (root) =>
            EffectArray.map(
              [...new Bun.Glob(extensions).scanSync({ cwd: root, onlyFiles: true })],
              (file) => `${root}/${file}`
            )
          )
        ],
        (file) => !pipe(file, EffectString.startsWith("tools/oxlint/anti-slop/"))
      )

const checkFile = async (file: string) => {
  const source = await Bun.file(file).text()
  const comments = await findCodeComments(file, source)

  return EffectArray.map(
    comments,
    (comment) =>
      `${file}:${EffectString.split(pipe(source, EffectString.slice(0, comment.start)), "\n").length}: Code comments are forbidden; use documentation or meaningful names.`
  )
}

const reports = await Promise.all(EffectArray.map(files, (file) => checkFile(file)))

for (const message of reports.flat()) console.error(message)

if (EffectArray.some(reports, (report) => report.length > 0)) process.exitCode = 1
