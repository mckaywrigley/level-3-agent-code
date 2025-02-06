import { generateObject } from "ai"
import { z } from "zod"
import { updateComment } from "./github-comments"
import { getLLMModel } from "./llm"
import { PullRequestContext } from "./pr-context"

export const reviewSchema = z.object({
  summary: z.string(),
  fileAnalyses: z.array(
    z.object({
      path: z.string(),
      analysis: z.string()
    })
  ),
  overallSuggestions: z.array(z.string())
})

export type ReviewAnalysis = z.infer<typeof reviewSchema>

export async function handleReviewAgent(
  octokit: any,
  context: PullRequestContext,
  reviewCommentId: number,
  reviewBody: string
): Promise<ReviewAnalysis | undefined> {
  const analysis = await generateReview(context)
  reviewBody += "\n\n**Summary**\n" + analysis.summary
  if (analysis.fileAnalyses.length > 0) {
    reviewBody += "\n\n**File Analyses**\n"
    for (const f of analysis.fileAnalyses) {
      reviewBody += `\n- **${f.path}**: ${f.analysis}`
    }
  }
  if (analysis.overallSuggestions.length > 0) {
    reviewBody += "\n\n**Suggestions**\n"
    for (const s of analysis.overallSuggestions) {
      reviewBody += `- ${s}\n`
    }
  }
  await updateComment(octokit, context, reviewCommentId, reviewBody)
  return analysis
}

async function generateReview(
  context: PullRequestContext
): Promise<ReviewAnalysis> {
  const changedFilesPrompt = context.changedFiles
    .map(f => {
      if (f.excluded) return `File: ${f.filename} [EXCLUDED FROM PROMPT]`
      return `File: ${f.filename}\nPatch:\n${f.patch}\nContent:\n${f.content ?? ""}`
    })
    .join("\n---\n")

  const prompt = `
You are an expert code reviewer. Return valid JSON only, with the structure:
{
  "summary": "string",
  "fileAnalyses": [
    { "path": "string", "analysis": "string" }
  ],
  "overallSuggestions": ["string"]
}

PR Title: ${context.title}
Commits:
${context.commitMessages.map(m => `- ${m}`).join("\n")}
Changed Files:
${changedFilesPrompt}
`

  const modelInfo = getLLMModel()
  try {
    const result = await generateObject({
      model: modelInfo,
      schema: reviewSchema,
      schemaName: "review",
      schemaDescription: "Code review feedback in JSON",
      prompt
    })
    return result.object
  } catch (err) {
    return {
      summary: "Review parse error",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
}
