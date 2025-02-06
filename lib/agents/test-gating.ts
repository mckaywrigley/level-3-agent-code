import { generateObject } from "ai"
import { z } from "zod"
import { ReviewAnalysis } from "./code-review"
import { updateComment } from "./github-comments"
import { getLLMModel } from "./llm"
import { PullRequestContextWithTests } from "./pr-context"

const gatingSchema = z.object({
  decision: z.object({
    shouldGenerateTests: z.boolean(),
    reasoning: z.string(),
    recommendation: z.string()
  })
})

export async function gatingStep(
  context: PullRequestContextWithTests,
  octokit: any,
  testCommentId: number,
  testBody: string,
  reviewAnalysis?: ReviewAnalysis
) {
  testBody += "\n\n**Gating Step**: Checking if we should generate tests..."
  await updateComment(octokit, context, testCommentId, testBody)

  const gating = await gatingStepLogic(context, reviewAnalysis)
  if (!gating.shouldGenerate) {
    testBody += `\n\nSkipping test generation: ${gating.reason}`
    await updateComment(octokit, context, testCommentId, testBody)
  }
  return {
    shouldGenerate: gating.shouldGenerate,
    reason: gating.reason,
    testBody
  }
}

async function gatingStepLogic(
  context: PullRequestContextWithTests,
  reviewAnalysis?: ReviewAnalysis
) {
  const existingTestsPrompt = context.existingTestFiles
    .map(f => `Existing test: ${f.filename}\n---\n${f.content}`)
    .join("\n")

  const changedFilesPrompt = context.changedFiles
    .map(file => {
      if (file.excluded) return `File: ${file.filename} [EXCLUDED]`
      return `File: ${file.filename}\nPatch:\n${file.patch}\nContent:\n${file.content}`
    })
    .join("\n---\n")

  let combinedRec = ""
  if (reviewAnalysis) {
    combinedRec = "Review Analysis:\n" + reviewAnalysis.summary
  }

  const prompt = `
You are an expert in deciding if tests are needed. Return JSON only:
{
  "decision": {
    "shouldGenerateTests": true or false,
    "reasoning": "string",
    "recommendation": "string"
  }
}

Title: ${context.title}
Commits:
${context.commitMessages.map(m => `- ${m}`).join("\n")}
Changed Files:
${changedFilesPrompt}
Existing Tests:
${existingTestsPrompt}
${combinedRec}
`
  const model = getLLMModel()
  try {
    const result = await generateObject({
      model,
      schema: gatingSchema,
      schemaName: "decision",
      schemaDescription: "Decision for test generation",
      prompt
    })
    return {
      shouldGenerate: result.object.decision.shouldGenerateTests,
      reason: result.object.decision.reasoning,
      recommendation: result.object.decision.recommendation
    }
  } catch (err) {
    return { shouldGenerate: false, reason: "Gating error", recommendation: "" }
  }
}
