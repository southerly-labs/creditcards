import { defineRule, eslintCompatPlugin } from "@oxlint/plugins"

const noCodeComments = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep explanations in documentation and names instead of code comments." },
    messages: {
      forbidden: "Code comments are forbidden. Move the explanation into documentation or a meaningful name."
    }
  },
  createOnce(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          context.report({ loc: comment.loc, messageId: "forbidden" })
        }
      }
    }
  }
})

export default eslintCompatPlugin({
  meta: { name: "project" },
  rules: { "no-code-comments": noCodeComments }
})
