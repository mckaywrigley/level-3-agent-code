/*
Generates code review feedback using an AI model.
*/

import { generateText } from "ai"
import { parseStringPromise } from "xml2js"
import { createPlaceholderComment, updateComment } from "./comments"
import { PullRequestContext } from "./handlers"
import { getLLMModel } from "./llm"

export interface ReviewAnalysis {
  summary: string
  fileAnalyses: Array<{ path: string; analysis: string }>
  overallSuggestions: string[]
}

async function parseReviewXml(xmlText: string): Promise<ReviewAnalysis> {
  try {
    const startTag = "<review>"
    const endTag = "</review>"
    const startIndex = xmlText.indexOf(startTag)
    const endIndex = xmlText.indexOf(endTag) + endTag.length
    if (startIndex === -1 || endIndex === -1) {
      return {
        summary: "Could not parse AI response.",
        fileAnalyses: [],
        overallSuggestions: []
      }
    }
    const xmlPortion = xmlText.slice(startIndex, endIndex)
    const parsed = await parseStringPromise(xmlPortion)
    const result: ReviewAnalysis = {
      summary: parsed.review.summary?.[0] ?? "",
      fileAnalyses: [],
      overallSuggestions: []
    }
    if (
      parsed.review.fileAnalyses?.[0]?.file &&
      Array.isArray(parsed.review.fileAnalyses[0].file)
    ) {
      result.fileAnalyses = parsed.review.fileAnalyses[0].file.map(
        (f: any) => ({
          path: f.path?.[0] ?? "",
          analysis: f.analysis?.[0] ?? ""
        })
      )
    }
    if (
      parsed.review.overallSuggestions?.[0]?.suggestion &&
      Array.isArray(parsed.review.overallSuggestions[0].suggestion)
    ) {
      result.overallSuggestions =
        parsed.review.overallSuggestions[0].suggestion.map((s: any) => s)
    }
    return result
  } catch {
    return {
      summary: "Parsing error from AI response.",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
}

async function generateReview(
  context: PullRequestContext
): Promise<ReviewAnalysis> {
  const { title, changedFiles, commitMessages } = context
  const changedFilesPrompt = changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename}\nStatus: ${file.status}\n[EXCLUDED FROM PROMPT]\n`
      }
      return `File: ${file.filename}\nStatus: ${file.status}\nPatch:\n${file.patch}\nContent:\n${file.content ?? "N/A"}\n`
    })
    .join("\n---\n")
  const prompt = `
You are an expert code reviewer. Provide feedback on the pull request below.

PR Title: ${title}
Commit Messages:
${commitMessages.map(msg => `- ${msg}`).join("\n")}
Changed Files:
${changedFilesPrompt}

Return ONLY valid XML in the structure:
<review>
  <summary>[short summary]</summary>
  <fileAnalyses>
    <file>
      <path>[filename]</path>
      <analysis>[analysis text]</analysis>
    </file>
  </fileAnalyses>
  <overallSuggestions>
    <suggestion>[text]</suggestion>
  </overallSuggestions>
</review>
`
  try {
    const model = getLLMModel()
    const { text } = await generateText({ model, prompt })
    return await parseReviewXml(text)
  } catch {
    return {
      summary: "We were unable to analyze the code due to an internal error.",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
}

export async function handleReviewAgent(context: PullRequestContext) {
  const { owner, repo, pullNumber } = context
  let commentId: number | undefined
  try {
    commentId = await createPlaceholderComment(
      owner,
      repo,
      pullNumber,
      "🤖 AI Code Review in progress..."
    )
    const analysis = await generateReview(context)
    const commentBody = `
### AI Code Review

**Summary**  
${analysis.summary}

${analysis.fileAnalyses
  .map(f => `**File:** ${f.path}\nAnalysis:\n${f.analysis}`)
  .join("\n\n")}

**Suggestions**  
${analysis.overallSuggestions.map(s => `- ${s}`).join("\n")}
`
    await updateComment(owner, repo, commentId, commentBody)
    return analysis
  } catch (err) {
    if (commentId !== undefined) {
      await updateComment(
        owner,
        repo,
        commentId,
        "❌ Error during code review."
      )
    }
    return {
      summary: "Error during code review",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
}
