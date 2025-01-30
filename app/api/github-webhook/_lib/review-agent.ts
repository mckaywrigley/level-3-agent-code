import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import { parseStringPromise } from "xml2js"
import { createPlaceholderComment, updateComment } from "./comments"
import { PullRequestContext } from "./handlers"

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  compatibility: "strict"
})

/**
 * parseReviewXml:
 * Helper to parse the AI's response as XML.
 * (This logic mirrors your "parseReviewXml" approach from lesson 1.)
 */
async function parseReviewXml(xmlText: string) {
  try {
    // Basic extraction: look for <review> ... </review>
    const xmlStart = xmlText.indexOf("<review>")
    const xmlEnd = xmlText.indexOf("</review>") + "</review>".length

    if (xmlStart === -1 || xmlEnd === -1) {
      console.warn("No <review> XML found in AI output.")
      return {
        summary: "Could not parse AI response.",
        fileAnalyses: [],
        overallSuggestions: []
      }
    }

    const xmlPortion = xmlText.slice(xmlStart, xmlEnd)
    const parsed = await parseStringPromise(xmlPortion)

    // Example structure:
    // <review>
    //   <summary>...</summary>
    //   <fileAnalyses>
    //     <file>
    //       <path>some/path</path>
    //       <analysis>...</analysis>
    //     </file>
    //   </fileAnalyses>
    //   <overallSuggestions>
    //     <suggestion>some suggestion</suggestion>
    //   </overallSuggestions>
    // </review>
    return {
      summary: parsed.review.summary?.[0] ?? "",
      fileAnalyses: Array.isArray(parsed.review.fileAnalyses?.[0]?.file)
        ? parsed.review.fileAnalyses[0].file.map((f: any) => ({
            path: f.path?.[0] || "",
            analysis: f.analysis?.[0] || ""
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
      summary: "Parsing error",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
}

/**
 * Updates the comment with the final review
 */
async function updateCommentWithReview(
  owner: string,
  repo: string,
  commentId: number,
  analysis: Awaited<ReturnType<typeof parseReviewXml>>
) {
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
 * generateReview:
 * Calls LLM with an XML prompt, returning the parsed result.
 */
async function generateReview(context: PullRequestContext) {
  const { changedFiles, commitMessages } = context

  const prompt = `
You are an expert code reviewer. Provide feedback on the following changes in XML form:
<review>
  <summary>[Short summary of changes]</summary>
  <fileAnalyses>
    <file>
      <path>[filename]</path>
      <analysis>[analysis text]</analysis>
    </file>
  </fileAnalyses>
  <overallSuggestions>
    <suggestion>[bullet point suggestion]</suggestion>
  </overallSuggestions>
</review>

Commit Messages:
${commitMessages.map(m => `- ${m}`).join("\n")}

Changed Files:
${changedFiles
  .map(
    cf =>
      `File: ${cf.filename}\nPatch:\n${cf.patch}\nContent:\n${cf.content ?? "N/A"}`
  )
  .join("\n---\n")}
  `

  const { text } = await generateText({
    model: openai("o1"), // or whichever model you want
    prompt
  })

  return parseReviewXml(text)
}

/**
 * Main handler that creates a placeholder comment, generates the review,
 * and updates the comment with the results
 */
export async function handleReviewAgent(context: PullRequestContext) {
  const { owner, repo, pullNumber } = context

  try {
    // 1) Create placeholder comment
    const placeholderId = await createPlaceholderComment(
      owner,
      repo,
      pullNumber,
      "🤖 AI Code Review in progress..."
    )

    // 2) Generate the review
    const analysis = await generateReview(context)

    // 3) Update the comment with the review
    await updateCommentWithReview(owner, repo, placeholderId, analysis)
  } catch (err) {
    console.error("Error in handleReviewAgent:", err)
  }
}
