/*
<ai_context>
This file contains functions for generating and committing tests to a GitHub PR.
It analyzes changed files and generates appropriate unit or e2e tests.
</ai_context>
*/

import { generateObject, generateText } from "ai"
import { parseStringPromise } from "xml2js"
import { z } from "zod"
import { createPlaceholderComment, updateComment } from "./comments"
import { octokit } from "./github"
import { PullRequestContextWithTests } from "./handlers"
import { getLLMModel } from "./llm"
import { ReviewAnalysis } from "./review-agent"

/**
 * Interface for describing AI-generated test proposals:
 * which files to create/update/rename, and their content.
 */
interface TestProposal {
  filename: string
  testType?: "unit" | "e2e"
  testContent: string
  actions?: {
    action: "create" | "update" | "rename"
    oldFilename?: string
  }
}

/**
 * Our gating step checks if we should generate tests at all, based on changed files and existing tests.
 * We use a zod schema to parse the AI's JSON.
 */
const gatingSchema = z.object({
  decision: z.object({
    shouldGenerateTests: z.boolean(),
    reasoning: z.string(),
    recommendation: z.string()
  })
})

/**
 * Helper for logging proposals to console in a condensed format
 */
function consoleLogProposals(proposals: TestProposal[]) {
  console.log(
    "AI Test proposals:",
    proposals.map(p => ({
      filename: p.filename,
      testType: p.testType,
      action: p.actions?.action
    }))
  )
}

/**
 * Parse <tests> XML from the LLM's response to produce an array of TestProposal objects.
 */
async function parseTestXml(xmlText: string): Promise<TestProposal[]> {
  console.log("Parsing test XML from AI response...")
  const startTag = "<tests>"
  const endTag = "</tests>"
  const startIndex = xmlText.indexOf(startTag)
  const endIndex = xmlText.indexOf(endTag) + endTag.length
  if (startIndex === -1 || endIndex === -1) {
    console.log("No <tests> XML found.")
    return []
  }

  const xmlPortion = xmlText.slice(startIndex, endIndex)
  const parsed = await parseStringPromise(xmlPortion)
  const proposals: TestProposal[] = []

  const root = parsed.tests
  if (!root?.testProposals) return proposals

  const testProposalsArr = root.testProposals[0].proposal
  if (!Array.isArray(testProposalsArr)) return proposals

  for (const item of testProposalsArr) {
    const filename = item.filename?.[0] ?? ""
    const testType = item.testType?.[0] ?? ""
    let testContent = item.testContent?.[0] ?? ""

    // Handle CDATA for testContent
    if (typeof testContent === "object" && "_" in testContent) {
      testContent = testContent._
    }

    const actionNode = item.actions?.[0]
    let action: "create" | "update" | "rename" = "create"
    let oldFilename: string | undefined

    if (actionNode?.action?.[0]) {
      const raw = actionNode.action[0]
      if (["create", "update", "rename"].includes(raw)) {
        action = raw as "create" | "update" | "rename"
      }
    }
    if (actionNode?.oldFilename?.[0]) {
      oldFilename = actionNode.oldFilename[0]
    }

    // Must have a filename and content
    if (!filename || !testContent) continue

    proposals.push({
      filename,
      testType: testType === "e2e" ? "e2e" : "unit",
      testContent,
      actions: { action, oldFilename }
    })
  }

  return proposals
}

/**
 * Finalize test proposals by ensuring correct file extensions for React code vs. non-React code.
 */
function finalizeTestProposals(
  proposals: TestProposal[],
  context: PullRequestContextWithTests
): TestProposal[] {
  console.log("Finalizing file extensions for test proposals...")
  const { changedFiles } = context

  return proposals.map(proposal => {
    // For simplicity, if ANY changed file is React-based, we assume we need .test.tsx
    // Or you can do a more advanced check per-file in a real scenario.
    const reactRelated = changedFiles.some(file => {
      if (!file.content) return false
      return (
        file.filename.endsWith(".tsx") ||
        file.content.includes("import React") ||
        file.content.includes('from "react"') ||
        file.filename.includes("app/")
      )
    })

    if (reactRelated) {
      if (!proposal.filename.endsWith(".test.tsx")) {
        proposal.filename = proposal.filename.replace(
          /\.test\.ts$/,
          ".test.tsx"
        )
      }
    } else {
      if (!proposal.filename.endsWith(".test.ts")) {
        proposal.filename = proposal.filename.replace(
          /\.test\.tsx$/,
          ".test.ts"
        )
      }
    }

    return proposal
  })
}

/**
 * Commits the given test proposals to the PR's existing branch on GitHub.
 */
async function commitTestsToExistingBranch(
  owner: string,
  repo: string,
  branchName: string,
  proposals: TestProposal[]
) {
  console.log("Committing new/updated tests to the branch:", branchName)

  for (const proposal of proposals) {
    const action = proposal.actions?.action || "create"
    const oldFilename = proposal.actions?.oldFilename

    // If renaming a file
    if (
      action === "rename" &&
      oldFilename &&
      oldFilename !== proposal.filename
    ) {
      console.log(`Renaming file: ${oldFilename} => ${proposal.filename}`)
      try {
        const { data: oldFile } = await octokit.repos.getContent({
          owner,
          repo,
          path: oldFilename,
          ref: branchName
        })
        if ("sha" in oldFile) {
          await octokit.repos.deleteFile({
            owner,
            repo,
            path: oldFilename,
            message: `Rename ${oldFilename} to ${proposal.filename}`,
            branch: branchName,
            sha: oldFile.sha
          })
        }
      } catch (err: any) {
        // If 404, ignore
        if (err.status !== 404) throw err
      }
    }

    try {
      // Check if file already exists
      const { data: existingFile } = await octokit.repos.getContent({
        owner,
        repo,
        path: proposal.filename,
        ref: branchName
      })

      const contentBase64 = Buffer.from(proposal.testContent, "utf8").toString(
        "base64"
      )
      console.log(`Updating file: ${proposal.filename}`)
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: proposal.filename,
        message: `Add/Update tests: ${proposal.filename}`,
        content: contentBase64,
        branch: branchName,
        sha: "sha" in existingFile ? existingFile.sha : undefined
      })
    } catch (error: any) {
      // If file does not exist
      if (error.status === 404) {
        console.log(`File does not exist; creating: ${proposal.filename}`)
        const contentBase64 = Buffer.from(
          proposal.testContent,
          "utf8"
        ).toString("base64")
        await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: proposal.filename,
          message: `Add/Update tests: ${proposal.filename}`,
          content: contentBase64,
          branch: branchName
        })
      } else {
        console.error("Error updating/creating file:", proposal.filename, error)
        throw error
      }
    }
  }
}

/**
 * Updates a placeholder comment with the final result listing the new test files, if any.
 */
async function updateCommentWithResults(
  owner: string,
  repo: string,
  commentId: number,
  headRef: string,
  testProposals: TestProposal[]
) {
  console.log("Updating comment with final test proposal results...")
  const testList = testProposals.map(t => `- **${t.filename}**`).join("\n")
  const body = `### AI Test Generator

${
  testProposals.length > 0
    ? `✅ Added/updated these test files on branch \`${headRef}\`:
${testList}

*(Pull from that branch to see & modify them.)*`
    : `⚠️ No test proposals were generated.`
}`
  await updateComment(owner, repo, commentId, body)
}

/**
 * Determine whether we should generate tests at all.
 * Returns a boolean plus optional recommended approach from the LLM.
 */
async function gatingStep(context: PullRequestContextWithTests) {
  console.log("Performing gating step to see if test generation is needed...")
  const { title, changedFiles, commitMessages, existingTestFiles } = context

  const existingTestsPrompt = existingTestFiles
    .map(
      f => `
Existing test file: ${f.filename}
---
${f.content}
---
`
    )
    .join("\n")

  const changedFilesPrompt = changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename}\nStatus: ${file.status}\n[EXCLUDED]\n`
      }
      return `File: ${file.filename}\nStatus: ${file.status}\nPatch:\n${file.patch}\nContent:\n${file.content ?? "N/A"}\n`
    })
    .join("\n---\n")

  const prompt = `
You are an expert in deciding if front-end tests are needed for these changes.

You have the PR title, commits, and file diffs/content. Only return JSON: {"decision":{"shouldGenerateTests":true or false,"reasoning":"some text","recommendation":"some text"}}

Title: ${title}
Commits:
${commitMessages.map(m => `- ${m}`).join("\n")}
Changed Files:
${changedFilesPrompt}
Existing Tests:
${existingTestsPrompt}
`

  try {
    const model = getLLMModel()
    console.log("Sending gating prompt to LLM...")
    const result = await generateObject({
      model,
      schema: gatingSchema,
      schemaName: "decision",
      schemaDescription: "Decision for test generation",
      prompt
    })

    console.log("LLM gating result:", result.object)
    return {
      shouldGenerate: result.object.decision.shouldGenerateTests,
      reason: result.object.decision.reasoning,
      recommendation: result.object.decision.recommendation
    }
  } catch (err) {
    console.error("Error during gating step:", err)
    return { shouldGenerate: false, reason: "Gating error" }
  }
}

/**
 * Generates test files (if gating says so) and commits them to the PR.
 * We also allow passing the code review analysis to "prompt chain" it in.
 */
export async function handleTestGeneration(
  context: PullRequestContextWithTests,
  reviewAnalysis?: ReviewAnalysis // optional param for code review chaining
) {
  console.log(
    "handleTestGeneration start. reviewAnalysis is optional, used for prompt chaining."
  )
  const { owner, repo, pullNumber, headRef } = context
  let commentId: number | undefined

  try {
    console.log("Creating placeholder comment for test generation...")
    commentId = await createPlaceholderComment(
      owner,
      repo,
      pullNumber,
      "🧪 AI Test Generation in progress..."
    )

    console.log("Running gating step for test generation...")
    const { shouldGenerate, reason, recommendation } = await gatingStep(context)
    if (!shouldGenerate) {
      console.log("Skipping test generation per gating step. Reason:", reason)
      await updateComment(
        owner,
        repo,
        commentId,
        `⏭️ Skipping test generation: ${reason}`
      )
      return
    }

    console.log("Continuing with test generation. Building prompt now...")
    // We'll incorporate the code review result into the "recommendation" param
    let combinedRecommendation = recommendation || ""
    if (reviewAnalysis) {
      console.log(
        "Incorporating review analysis into the test generation prompt..."
      )
      combinedRecommendation += `\n\nCODE REVIEW RESULT:\nSummary: ${reviewAnalysis.summary}\n`
      for (const f of reviewAnalysis.fileAnalyses) {
        combinedRecommendation += `\nFile: ${f.path}\nAnalysis: ${f.analysis}`
      }
      if (reviewAnalysis.overallSuggestions.length > 0) {
        combinedRecommendation += `\nSuggestions:\n- ${reviewAnalysis.overallSuggestions.join("\n- ")}`
      }
      console.log("Done appending code review result to recommendation.")
    }

    console.log("Generating tests via AI...")
    const testProposals = await generateTestsForChanges(
      context,
      combinedRecommendation
    )
    console.log(
      "Finished AI generation of tests. # proposals:",
      testProposals.length
    )
    consoleLogProposals(testProposals)

    if (testProposals.length > 0) {
      const finalized = finalizeTestProposals(testProposals, context)
      console.log("Committing final proposals to branch:", headRef)
      await commitTestsToExistingBranch(owner, repo, headRef, finalized)
      await updateCommentWithResults(owner, repo, commentId, headRef, finalized)
    } else {
      console.log("No test proposals returned from AI.")
      await updateCommentWithResults(owner, repo, commentId, headRef, [])
    }

    console.log("handleTestGeneration done.")
  } catch (err) {
    console.error("Error in handleTestGeneration:", err)
    if (commentId !== undefined) {
      await updateComment(
        owner,
        repo,
        commentId,
        "❌ Error generating tests. Please check the logs."
      )
    }
  }
}

/**
 * Called when tests fail in CI, and we want to fix them up to 3 times.
 * No gating step needed, we already know we want new test logic.
 */
export async function handleTestFix(
  context: PullRequestContextWithTests,
  iteration?: number
) {
  console.log("handleTestFix start. iteration =", iteration)
  const { owner, repo, pullNumber, headRef } = context
  let commentId: number | undefined

  try {
    console.log(
      "Creating placeholder comment for test fix attempt #",
      iteration
    )
    commentId = await createPlaceholderComment(
      owner,
      repo,
      pullNumber,
      `🧪 AI Test Fix #${iteration} in progress...`
    )

    console.log(
      "Generating new test proposals to fix failing tests. We skip gating, we already know we want to fix."
    )
    const fixPrompt = `We have failing tests. Attempt #${iteration}. Please fix existing or create new ones as needed.`

    const testProposals = await generateTestsForChanges(context, fixPrompt)
    console.log(
      "Finished AI generation of fix proposals. # proposals:",
      testProposals.length
    )
    consoleLogProposals(testProposals)

    if (testProposals.length > 0) {
      const finalized = finalizeTestProposals(testProposals, context)
      console.log("Committing final fix proposals to branch:", headRef)
      await commitTestsToExistingBranch(owner, repo, headRef, finalized)
      await updateCommentWithResults(owner, repo, commentId, headRef, finalized)
    } else {
      console.log("No fix proposals returned from AI.")
      await updateCommentWithResults(owner, repo, commentId, headRef, [])
    }

    console.log("handleTestFix done.")
  } catch (error) {
    console.error("Error in handleTestFix:", error)
    if (commentId !== undefined) {
      await updateComment(
        owner,
        repo,
        commentId,
        "❌ Error fixing tests. Please check the logs."
      )
    }
  }
}

/**
 * Helper function that actually calls the AI to create test proposals.
 * We pass in an optional recommendation that can include code review text,
 * or a note about failing tests, etc.
 */
async function generateTestsForChanges(
  context: PullRequestContextWithTests,
  recommendation?: string
): Promise<TestProposal[]> {
  console.log(
    "generateTestsForChanges start with recommendation:",
    recommendation || "N/A"
  )
  const { title, changedFiles, commitMessages, existingTestFiles } = context

  const existingTestsPrompt = existingTestFiles
    .map(f => `Existing test file: ${f.filename}\n---\n${f.content}\n---\n`)
    .join("\n")

  const changedFilesPrompt = changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename}\nStatus: ${file.status}\n[EXCLUDED FROM PROMPT]\n`
      }
      return `File: ${file.filename}\nStatus: ${file.status}\nPatch:\n${file.patch}\nCurrent Content:\n${
        file.content ?? "N/A"
      }\n`
    })
    .join("\n---\n")

  const prompt = `
You are an expert software developer specializing in writing tests for a Next.js codebase.

You may use or ignore the recommendation below as you see fit.
Recommendation: ${recommendation ?? ""}

Remember - you only generate tests for front-end code (React components/pages/hooks).
Do NOT generate tests for backend code (API routes, database, etc).

Rules for naming test files:
1) If a file is React or a Next.js page, tests must end ".test.tsx".
2) If purely non-React, use ".test.ts".
3) If an existing test file has the wrong extension, propose rename.
4) If updating an existing test file, just update it in place.

We have 2 categories:
(1) Unit tests in "__tests__/unit/"
(2) E2E tests in "__tests__/e2e/"

If a test already covers it, prefer updating rather than creating new.

Title: ${title}
Commits:
${commitMessages.map(m => `- ${m}`).join("\n")}
Changed Files:
${changedFilesPrompt}
Existing Tests:
${existingTestsPrompt}

Return ONLY valid XML:

<tests>
  <testProposals>
    <proposal>
      <filename>__tests__/unit/... .test.ts[x]</filename>
      <testType>unit or e2e</testType>
      <testContent><![CDATA[
YOUR TEST CODE HERE
]]></testContent>
      <actions>
        <action>create|update|rename</action>
        <oldFilename>__tests__/unit/something.test.ts</oldFilename>
      </actions>
    </proposal>
  </testProposals>
</tests>
`

  try {
    const model = getLLMModel()
    console.log("Sending test-generation prompt to LLM...")
    const { text } = await generateText({ model, prompt })
    console.log("Raw AI response for test generation:", text)

    const rawProposals = await parseTestXml(text)
    return finalizeTestProposals(rawProposals, context)
  } catch (err) {
    console.error("Error generating tests from AI:", err)
    return []
  }
}
