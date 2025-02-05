/*
<ai_context>
This file contains functions for generating and committing code reviews to a GitHub PR.
It uses an AI model to analyze code changes and provide structured feedback.
</ai_context>
*/

import { generateText } from "ai"
import { parseStringPromise } from "xml2js"
import { createPlaceholderComment, updateComment } from "./comments"
import { PullRequestContext, removeLabel } from "./handlers"
import { getLLMModel } from "./llm"

// Label that triggers the review process when added to a PR
export const REVIEW_LABEL = "agent-review-pr"

/**
 * Parses the XML response from the AI model into a structured review format
 *
 * @param xmlText - The XML string from the AI model
 * @returns Parsed review data with summary, file analyses, and suggestions
 */
async function parseReviewXml(xmlText: string) {
  try {
    // Locate the <review>...</review> portion within the AI's output
    const startTag = "<review>"
    const endTag = "</review>"
    const startIndex = xmlText.indexOf(startTag)
    const endIndex = xmlText.indexOf(endTag) + endTag.length

    // If no XML section is found, return a placeholder review
    if (startIndex === -1 || endIndex === -1) {
      console.warn("No <review> XML found in AI output.")
      return {
        summary: "Could not parse AI response.",
        fileAnalyses: [],
        overallSuggestions: []
      }
    }

    // Extract just the relevant XML portion
    const xmlPortion = xmlText.slice(startIndex, endIndex)
    const parsed = await parseStringPromise(xmlPortion)

    // Build an object from the parsed XML
    return {
      summary: parsed.review.summary?.[0] ?? "",
      fileAnalyses: Array.isArray(parsed.review.fileAnalyses?.[0]?.file)
        ? parsed.review.fileAnalyses[0].file.map((f: any) => ({
            path: f.path?.[0] ?? "",
            analysis: f.analysis?.[0] ?? ""
          }))
        : [],
      overallSuggestions: Array.isArray(
        parsed.review.overallSuggestions?.[0]?.suggestion
      )
        ? parsed.review.overallSuggestions[0].suggestion.map((s: any) => s)
        : []
    }
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
 * Updates the GitHub comment with the AI-generated review content in a readable format
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param commentId - ID of the comment to update
 * @param analysis - Parsed review data
 */
async function updateCommentWithReview(
  owner: string,
  repo: string,
  commentId: number,
  analysis: Awaited<ReturnType<typeof parseReviewXml>>
) {
  // Format the review analysis as Markdown
  const commentBody = `
### AI Code Review

**Summary**  
${analysis.summary}

${analysis.fileAnalyses
  .map((f: any) => `**File:** ${f.path}\nAnalysis:\n${f.analysis}`)
  .join("\n\n")}
  
**Suggestions**  
${analysis.overallSuggestions.map((s: string) => `- ${s}`).join("\n")}
`

  await updateComment(owner, repo, commentId, commentBody)
}

/**
 * Generates a code review using the AI model based on changes in a PR.
 *
 * @param context - Pull request context containing files and metadata
 * @returns Parsed review data from the AI
 */
async function generateReview(context: PullRequestContext) {
  const { title, changedFiles, commitMessages } = context

  // Prepare changed files prompt for the AI
  const changedFilesPrompt = changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename}\nStatus: ${file.status}\n[EXCLUDED FROM PROMPT]\n`
      }
      return `File: ${file.filename}\nStatus: ${file.status}\nPatch (diff):\n${file.patch}\nCurrent Content:\n${file.content ?? "N/A"}\n`
    })
    .join("\n---\n")

  // Construct the review prompt
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
  <summary>[short summary of these changes]</summary>
  <fileAnalyses>
    <file>
      <path>[filename]</path>
      <analysis>[analysis for that file]</analysis>
    </file>
  </fileAnalyses>
  <overallSuggestions>
    <suggestion>[single bullet suggestion]</suggestion>
  </overallSuggestions>
</review>

ONLY return the <review> XML with the summary, fileAnalyses, and overallSuggestions. Do not add extra commentary.
`

  try {
    // Generate the text from the AI model
    const model = getLLMModel()
    const { text } = await generateText({
      model,
      prompt
    })

    console.log(
      "\n=== AI Response (Code Review) ===\n",
      text,
      "\n================\n"
    )

    // Parse the returned XML
    return parseReviewXml(text)
  } catch (error) {
    console.error("Error generating or parsing AI analysis:", error)
    // Return a fallback review object
    return {
      summary: "We were unable to analyze the code due to an internal error.",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
}

/**
 * Main handler for the review process:
 * 1. Create placeholder comment
 * 2. Generate code review using AI
 * 3. Update the comment with the review
 * 4. Remove the review label
 *
 * @param context - Pull request context
 */
export async function handleReviewAgent(context: PullRequestContext) {
  const { owner, repo, pullNumber } = context
  let commentId: number | undefined

  try {
    // 1. Create a placeholder comment while AI processes the review
    commentId = await createPlaceholderComment(
      owner,
      repo,
      pullNumber,
      "🤖 AI Code Review in progress..."
    )

    // 2. Generate the review
    const analysis = await generateReview(context)

    // 3. Update the comment with the AI-generated review data
    await updateCommentWithReview(owner, repo, commentId, await analysis)

    // 4. Remove the label so we don't re-run automatically
    await removeLabel(owner, repo, pullNumber, REVIEW_LABEL)
  } catch (err) {
    console.error("Error in handleReviewAgent:", err)
    if (typeof commentId !== "undefined") {
      await updateComment(
        owner,
        repo,
        commentId,
        "❌ Error during code review. Please check the logs."
      )
    }
  }
}
