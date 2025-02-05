/*
<ai_context>
This file contains functions for generating and committing code reviews to a GitHub PR.
It uses an AI model to analyze code changes and provide structured feedback.
</ai_context>
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

/**
 * Parse <review> XML from AI
 */
async function parseReviewXml(xmlText: string): Promise<ReviewAnalysis> {
  try {
    console.log("Parsing AI review XML...")
    const startTag = "<review>"
    const endTag = "</review>"
    const startIndex = xmlText.indexOf(startTag)
    const endIndex = xmlText.indexOf(endTag) + endTag.length

    if (startIndex === -1 || endIndex === -1) {
      console.warn("No <review> XML found in AI output.")
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
  } catch (err) {
    console.error("Error parsing review XML:", err)
    return {
      summary: "Parsing error from AI response.",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
}

/**
 * Generate review text by sending diffs etc. to the AI model.
 */
async function generateReview(
  context: PullRequestContext
): Promise<ReviewAnalysis> {
  console.log("Generating code review via AI...")
  const { title, changedFiles, commitMessages } = context

  const changedFilesPrompt = changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename}\nStatus: ${file.status}\n[EXCLUDED FROM PROMPT]\n`
      }
      return `File: ${file.filename}\nStatus: ${file.status}\nPatch (diff):\n${file.patch}\nCurrent Content:\n${file.content ?? "N/A"}\n`
    })
    .join("\n---\n")

  const prompt = `
You are an expert code reviewer. Provide feedback on the following pull request changes in clear, concise paragraphs.
Do not use code blocks for regular text. Format any suggestions as single-line bullet points.

PR Title: ${title}
Commit Messages:
${commitMessages.map(msg => `- ${msg}`).join("\n")}
Changed Files:
${changedFilesPrompt}

Return ONLY valid XML in the following structure (no extra commentary):
<review>
  <summary>[short summary]</summary>
  <fileAnalyses>
    <file>
      <path>[filename]</path>
      <analysis>[analysis text]</analysis>
    </file>
  </fileAnalyses>
  <overallSuggestions>
    <suggestion>[bullet suggestion]</suggestion>
  </overallSuggestions>
</review>
`

  try {
    const model = getLLMModel()
    console.log("Sending review prompt to AI model...")
    const { text } = await generateText({ model, prompt })
    console.log("AI review raw response:", text)

    const analysis = await parseReviewXml(text)
    return analysis
  } catch (error) {
    console.error("Error generating or parsing AI analysis:", error)
    return {
      summary: "We were unable to analyze the code due to an internal error.",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
}

/**
 * Creates a placeholder comment, runs code review, updates comment with results,
 * and returns the final ReviewAnalysis for chaining into test prompts.
 */
export async function handleReviewAgent(context: PullRequestContext) {
  console.log("handleReviewAgent start")
  const { owner, repo, pullNumber } = context
  let commentId: number | undefined

  try {
    console.log("Creating placeholder comment for code review...")
    commentId = await createPlaceholderComment(
      owner,
      repo,
      pullNumber,
      "🤖 AI Code Review in progress..."
    )

    const analysis = await generateReview(context)
    console.log("Review analysis complete. Updating comment with results...")

    const commentBody = `
### AI Code Review

**Summary**  
${analysis.summary}

${analysis.fileAnalyses
  .map(f => `**File:** ${f.path}\nAnalysis:\n${f.analysis}`)
  .join("\n\n")}

**Suggestions**  
${analysis.overallSuggestions.map((s: string) => `- ${s}`).join("\n")}
`
    await updateComment(owner, repo, commentId, commentBody)
    console.log("Review comment updated. Returning analysis...")

    return analysis
  } catch (err) {
    console.error("Error in handleReviewAgent:", err)
    if (commentId !== undefined) {
      await updateComment(
        owner,
        repo,
        commentId,
        "❌ Error during code review. Please check the logs."
      )
    }
    return {
      summary: "Error during code review",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
}
