import { findCodeComments } from "./comment-policy.ts"

const roots = ["src", "web", "test", "tools"]
const extensions = "**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,css,html}"
const requested = process.argv.slice(2)

const files =
  requested.length > 0
    ? requested
    : [
        ...new Bun.Glob("*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,css,html}").scanSync({ onlyFiles: true, dot: true }),
        ...roots.flatMap((root) =>
          [...new Bun.Glob(extensions).scanSync({ cwd: root, onlyFiles: true })].map((file) => `${root}/${file}`)
        )
      ].filter((file) => !file.startsWith("tools/oxlint/anti-slop/"))

const checkFile = async (file: string) => {
  const source = await Bun.file(file).text()
  const comments = await findCodeComments(file, source)

  return comments.map(
    (comment) =>
      `${file}:${source.slice(0, comment.start).split("\n").length}: Code comments are forbidden; use documentation or meaningful names.`
  )
}

const reports = await Promise.all(files.map((file) => checkFile(file)))

for (const message of reports.flat()) console.error(message)

if (reports.some((report) => report.length > 0)) process.exitCode = 1
