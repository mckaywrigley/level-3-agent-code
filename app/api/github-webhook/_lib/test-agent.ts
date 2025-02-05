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
import { PullRequestContextWithTests, removeLabel } from "./handlers"
import { getLLMModel } from "./llm"

// Interface defining the structure of a test proposal from the AI
interface TestProposal {
  filename: string // Path to the test file
  testType?: "unit" | "e2e" // Type of test to generate
  testContent: string // The actual test code
  actions?: {
    // Actions to take with the file
    action: "create" | "update" | "rename"
    oldFilename?: string // Used when renaming files
  }
}

// Label that triggers the test generation process when added to a PR
export const TEST_GENERATION_LABEL = "agent-generate-tests"

// Zod schema for validating the AI's decision about whether to generate tests
const gatingSchema = z.object({
  decision: z.object({
    shouldGenerateTests: z.boolean(),
    reasoning: z.string(),
    recommendation: z.string().optional()
  })
})

/**
 * Parses the XML response from the AI model into structured test proposals
 *
 * @param xmlText - The XML string from the AI model
 * @returns Array of parsed test proposals
 */
async function parseTestXml(xmlText: string): Promise<TestProposal[]> {
  // Extract the tests XML portion from the response by locating <tests> ... </tests>
  const startTag = "<tests>"
  const endTag = "</tests>"
  const startIndex = xmlText.indexOf(startTag)
  const endIndex = xmlText.indexOf(endTag) + endTag.length
  if (startIndex === -1 || endIndex === -1) return []

  // Parse the isolated XML using xml2js
  const xmlPortion = xmlText.slice(startIndex, endIndex)
  const parsed = await parseStringPromise(xmlPortion)
  const proposals: TestProposal[] = []

  // Extract root element and validate structure
  const root = parsed.tests
  if (!root?.testProposals) return []

  // Access the array of proposals inside <testProposals>
  const testProposalsArr = root.testProposals[0].proposal
  if (!Array.isArray(testProposalsArr)) return []

  // Each item should represent one test proposal
  for (const item of testProposalsArr) {
    // Read data from the XML
    const filename = item.filename?.[0] ?? ""
    const testType = item.testType?.[0] ?? ""
    let testContent = item.testContent?.[0] ?? ""

    // If testContent is an object (CDATA), pull out the actual text
    if (typeof testContent === "object" && "_" in testContent) {
      testContent = testContent._
    }

    // Parse possible file actions
    const actionNode = item.actions?.[0]
    let action: "create" | "update" | "rename" = "create"
    let oldFilename: string | undefined

    if (actionNode?.action?.[0]) {
      const raw = actionNode.action[0]
      if (raw === "update" || raw === "rename" || raw === "create") {
        action = raw
      }
    }

    if (actionNode?.oldFilename?.[0]) {
      oldFilename = actionNode.oldFilename[0]
    }

    // Skip if required fields are missing
    if (!filename || !testContent) continue

    // Build the final proposal object
    proposals.push({
      filename,
      testType: testType === "e2e" ? "e2e" : "unit",
      testContent,
      actions: {
        action,
        oldFilename
      }
    })
  }

  return proposals
}

/**
 * Finalizes test proposals by ensuring correct file extensions based on whether the changed files
 * are React code or not.
 *
 * @param proposals - Array of raw test proposals from parseTestXml
 * @param changedFiles - Information about files changed in the PR
 * @returns Array of finalized test proposals (with properly adjusted file extensions)
 */
function finalizeTestProposals(
  proposals: TestProposal[],
  changedFiles: PullRequestContextWithTests["changedFiles"]
): TestProposal[] {
  return proposals.map(proposal => {
    // Check if the test is for React-related code by scanning changed file content
    const reactRelated = changedFiles.some(file => {
      if (!file.content) return false
      return (
        file.filename ===
          proposal.filename
            .replace("__tests__/unit/", "")
            .replace("__tests__/e2e/", "")
            .replace(".test.tsx", "")
            .replace(".test.ts", "") ||
        file.filename.endsWith(".tsx") ||
        file.content.includes("import React") ||
        file.content.includes('from "react"') ||
        file.filename.includes("app/")
      )
    })

    // If it's React-related, ensure .test.tsx; otherwise ensure .test.ts
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
 * Generates test files based on changes in the PR. Uses AI to decide what tests to create or update.
 *
 * @param context - Pull request context with test information
 * @param recommendation - Optional recommendation from the gating step
 * @returns Array of test proposals describing which tests should be added or updated
 */
async function generateTestsForChanges(
  context: PullRequestContextWithTests,
  recommendation?: string
): Promise<TestProposal[]> {
  const { title, changedFiles, commitMessages, existingTestFiles } = context

  // Combine existing tests into a prompt snippet so the AI knows what's already tested
  const existingTestsPrompt = existingTestFiles
    .map(f => `Existing test file: ${f.filename}\n---\n${f.content}\n---\n`)
    .join("\n")

  // Summarize changed files for the AI
  const changedFilesPrompt = changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename}\nStatus: ${file.status}\n[EXCLUDED FROM PROMPT]\n`
      }
      return `File: ${file.filename}\nStatus: ${file.status}\nPatch:\n${file.patch}\nCurrent Content:\n${file.content ?? "N/A"}\n`
    })
    .join("\n---\n")

  // Craft the final AI prompt
  const prompt = `
You are an expert software developer specializing in writing tests for a Next.js codebase.

You may use the recommendation below and/or go beyond it.

Recommendation: ${recommendation ?? ""}

Remember - you only generate tests for front-end code. This includes things like React components, pages, hooks, etc. You do not generate tests for back-end code. This includes things like API routes, database models, etc.

Rules for naming test files:
1) If a file is a React component (client or server) or a Next.js page, the test filename MUST end in ".test.tsx".
2) If the file is purely back-end or non-React, use ".test.ts".
3) If an existing test file has the wrong extension, propose removing/renaming it.
4) If updating an existing test file that has the correct name, just update it in place.

We have two test categories:
(1) Unit tests (Jest + Testing Library) in \`__tests__/unit/\`
(2) E2E tests (Playwright) in \`__tests__/e2e/\`

If an existing test already covers related functionality, prefer updating it rather than creating a new file. Return final content for each file you modify or create.

Other rules:
- If a React component is a Server Component, handle it asynchronously in tests. If it's a Client Component, test it normally.

Title: ${title}
Commits:
${commitMessages.map(m => `- ${m}`).join("\n")}
Changed Files:
${changedFilesPrompt}
Existing Tests:
${existingTestsPrompt}

Return ONLY valid XML in the following structure:
<tests>
  <testProposals>
    <proposal>
      <filename>__tests__/unit/... .test.ts[x]</filename>
      <testType>unit or e2e</testType>
      <testContent><![CDATA[
YOUR TEST CODE HERE
]]></testContent>
      <actions>
        <action>create</action> OR <action>update</action> OR <action>rename</action>
        <!-- if rename -->
        <oldFilename>__tests__/unit/... .test.ts</oldFilename>
      </actions>
    </proposal>
  </testProposals>
</tests>

ONLY return the <tests> XML with proposals. Do not add extra commentary.
`

  try {
    // Use the configured LLM to generate text based on the prompt
    const model = getLLMModel()
    const { text } = await generateText({
      model,
      prompt
    })
    console.log("text", text)

    // Parse the generated XML and finalize file extensions
    const rawProposals = await parseTestXml(text)
    return finalizeTestProposals(rawProposals, changedFiles)
  } catch {
    // If there's an error (like parsing or network), return empty proposals
    return []
  }
}

/**
 * Commits generated or updated test files to the existing PR branch.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param branchName - The branch the PR is based on (head branch)
 * @param proposals - Test files to be created or updated
 */
async function commitTestsToExistingBranch(
  owner: string,
  repo: string,
  branchName: string,
  proposals: TestProposal[]
) {
  for (const proposal of proposals) {
    const action = proposal.actions?.action ?? "create"
    const oldFilename = proposal.actions?.oldFilename

    // If the AI wants to rename a file, we first remove the old file (if it exists) and then create the new one
    if (
      action === "rename" &&
      oldFilename &&
      oldFilename !== proposal.filename
    ) {
      try {
        // Attempt to delete the old file from the branch
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
        // If the old file doesn't exist, it's not a blocking error
        if (err.status !== 404) throw err
      }
    }

    try {
      // Check if the file already exists on the branch
      const { data: existingFile } = await octokit.repos.getContent({
        owner,
        repo,
        path: proposal.filename,
        ref: branchName
      })

      // If it exists, update it. Otherwise, we'll go to the catch block to create it.
      const contentBase64 = Buffer.from(proposal.testContent, "utf8").toString(
        "base64"
      )

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
      // If the file does not exist (404), we create it
      if (error.status === 404) {
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
        throw error
      }
    }
  }
}

/**
 * Updates the PR comment with the list of test files that were generated or updated.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param commentId - ID of the comment used to track test generation status
 * @param headRef - The name of the branch where tests were committed
 * @param testProposals - Array of test proposals that were committed
 */
async function updateCommentWithResults(
  owner: string,
  repo: string,
  commentId: number,
  headRef: string,
  testProposals: TestProposal[]
) {
  // Create a bulleted list of test files for the comment
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
 * Makes an initial determination about whether test generation is needed,
 * based on the changed files and existing tests.
 *
 * @param context - Pull request context including file changes
 * @returns Object containing a boolean decision and reasoning
 */
async function gatingStep(context: PullRequestContextWithTests) {
  const { title, changedFiles, commitMessages, existingTestFiles } = context

  // Format existing tests for the prompt
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

  // Format changed files for the prompt
  const changedFilesPrompt = changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename}\nStatus: ${file.status}\n[EXCLUDED]\n`
      }
      return `File: ${file.filename}\nStatus: ${file.status}\nPatch:\n${file.patch}\nContent:\n${file.content ?? "N/A"}\n`
    })
    .join("\n---\n")

  // Construct the prompt for the AI model
  const prompt = `
You are an expert in deciding if front-end tests are needed for these changes.

You have the PR title, commits, and file diffs/content. Only return the object in JSON format: {"decision":{"shouldGenerateTests":true or false,"reasoning":"some text","recommendation":"some text"}}

Title: ${title}
Commits:
${commitMessages.map(m => `- ${m}`).join("\n")}
Changed Files:
${changedFilesPrompt}
Existing Tests:
${existingTestsPrompt}
`

  try {
    // Use the configured LLM model for a gating decision
    const model = getLLMModel()
    const result = await generateObject({
      model,
      schema: gatingSchema,
      schemaName: "decision",
      schemaDescription: "Decision for test generation",
      prompt
    })

    console.log(
      "shouldGenerate",
      result.object.decision.shouldGenerateTests,
      result.object.decision.reasoning,
      result.object.decision.recommendation
    )

    return {
      shouldGenerate: result.object.decision.shouldGenerateTests,
      reason: result.object.decision.reasoning,
      recommendation: result.object.decision.recommendation
    }
  } catch {
    // Default to skipping test generation if there's an error in the gating step
    return { shouldGenerate: false, reason: "Error in gating check" }
  }
}

/**
 * Main handler that orchestrates the test generation flow:
 * 1. Creates a placeholder comment
 * 2. Decides whether to generate tests (gating)
 * 3. If yes, generates and commits them
 * 4. Updates the comment with results
 * 5. Removes the "agent-generate-tests" label
 *
 * @param context - Pull request context with test-related data
 */
export async function handleTestGeneration(
  context: PullRequestContextWithTests
) {
  const { owner, repo, pullNumber, headRef } = context
  let commentId: number | undefined

  try {
    // 1. Create placeholder comment
    commentId = await createPlaceholderComment(
      owner,
      repo,
      pullNumber,
      "🧪 AI Test Generation in progress..."
    )

    // 2. Decide if we should generate tests
    const { shouldGenerate, reason, recommendation } = await gatingStep(context)
    if (!shouldGenerate) {
      await updateComment(
        owner,
        repo,
        commentId,
        `⏭️ Skipping test generation: ${reason}`
      )
      return
    }

    // 3. Generate and commit tests
    const testProposals = await generateTestsForChanges(context, recommendation)
    if (testProposals.length > 0) {
      await commitTestsToExistingBranch(owner, repo, headRef, testProposals)
    }

    // 4. Update comment with results
    await updateCommentWithResults(
      owner,
      repo,
      commentId,
      headRef,
      testProposals
    )

    // 5. Remove the generation label to indicate we're done
    await removeLabel(owner, repo, pullNumber, TEST_GENERATION_LABEL)
  } catch (err) {
    console.error("Error in handleTestGeneration:", err)
    if (typeof commentId !== "undefined") {
      await updateComment(
        owner,
        repo,
        commentId,
        "❌ Error generating tests. Please check the logs."
      )
    }
  }
}
