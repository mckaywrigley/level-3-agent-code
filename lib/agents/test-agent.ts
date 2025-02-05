/*
Generates and commits unit tests for PR changes using an AI model.
*/

import { generateObject, generateText } from "ai"
import { parseStringPromise } from "xml2js"
import { z } from "zod"
import { createPlaceholderComment, updateComment } from "./comments"
import { octokit } from "./github"
import { PullRequestContextWithTests } from "./handlers"
import { getLLMModel } from "./llm"
import { ReviewAnalysis } from "./review-agent"

interface TestProposal {
  filename: string
  testContent: string
  actions?: {
    action: "create" | "update" | "rename"
    oldFilename?: string
  }
}

const gatingSchema = z.object({
  decision: z.object({
    shouldGenerateTests: z.boolean(),
    reasoning: z.string(),
    recommendation: z.string()
  })
})

function consoleLogProposals(proposals: TestProposal[]) {
  console.log(
    "AI Test proposals:",
    proposals.map(p => ({
      filename: p.filename,
      action: p.actions?.action
    }))
  )
}

async function parseTestXml(xmlText: string): Promise<TestProposal[]> {
  const startTag = "<tests>"
  const endTag = "</tests>"
  const startIndex = xmlText.indexOf(startTag)
  const endIndex = xmlText.indexOf(endTag) + endTag.length
  if (startIndex === -1 || endIndex === -1) {
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
    let testContent = item.testContent?.[0] ?? ""
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
    if (!filename || !testContent) continue
    proposals.push({ filename, testContent, actions: { action, oldFilename } })
  }
  return proposals
}

function finalizeTestProposals(
  proposals: TestProposal[],
  context: PullRequestContextWithTests
): TestProposal[] {
  const { changedFiles } = context
  return proposals.map(proposal => {
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
    if (!proposal.filename.includes("__tests__/unit")) {
      proposal.filename = `__tests__/unit/${proposal.filename}`
    }
    return proposal
  })
}

async function commitTestsToExistingBranch(
  owner: string,
  repo: string,
  branchName: string,
  proposals: TestProposal[]
) {
  for (const proposal of proposals) {
    const action = proposal.actions?.action || "create"
    const oldFilename = proposal.actions?.oldFilename
    if (
      action === "rename" &&
      oldFilename &&
      oldFilename !== proposal.filename
    ) {
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
        if (err.status !== 404) throw err
      }
    }
    try {
      const { data: existingFile } = await octokit.repos.getContent({
        owner,
        repo,
        path: proposal.filename,
        ref: branchName
      })
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

async function updateCommentWithResults(
  owner: string,
  repo: string,
  commentId: number,
  headRef: string,
  testProposals: TestProposal[]
) {
  const testList = testProposals.map(t => `- **${t.filename}**`).join("\n")
  const body =
    testProposals.length > 0
      ? `### AI Test Generator\n\n✅ Added/updated these test files on branch \`${headRef}\`:\n${testList}\n\n*(Pull from that branch to see & modify them.)*`
      : `### AI Test Generator\n\n⚠️ No test proposals were generated.`
  await updateComment(owner, repo, commentId, body)
}

async function gatingStep(context: PullRequestContextWithTests) {
  const { title, changedFiles, commitMessages, existingTestFiles } = context
  const existingTestsPrompt = existingTestFiles
    .map(f => `Existing test file: ${f.filename}\n---\n${f.content}\n---\n`)
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
You are an expert in deciding if tests are needed for these changes.
Only return JSON: {"decision":{"shouldGenerateTests":true or false,"reasoning":"some text","recommendation":"some text"}}

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
  } catch {
    return { shouldGenerate: false, reason: "Gating error" }
  }
}

export async function handleTestGeneration(
  context: PullRequestContextWithTests,
  reviewAnalysis?: ReviewAnalysis
) {
  const { owner, repo, pullNumber, headRef } = context
  let commentId: number | undefined
  try {
    commentId = await createPlaceholderComment(
      owner,
      repo,
      pullNumber,
      "🧪 AI Test Generation in progress..."
    )
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
    let combinedRecommendation = recommendation || ""
    if (reviewAnalysis) {
      combinedRecommendation += `\n\nCODE REVIEW RESULT:\nSummary: ${reviewAnalysis.summary}\n`
      for (const f of reviewAnalysis.fileAnalyses) {
        combinedRecommendation += `\nFile: ${f.path}\nAnalysis: ${f.analysis}`
      }
      if (reviewAnalysis.overallSuggestions.length > 0) {
        combinedRecommendation += `\nSuggestions:\n- ${reviewAnalysis.overallSuggestions.join("\n- ")}`
      }
    }
    const testProposals = await generateTestsForChanges(
      context,
      combinedRecommendation
    )
    consoleLogProposals(testProposals)
    if (testProposals.length > 0) {
      const finalized = finalizeTestProposals(testProposals, context)
      await commitTestsToExistingBranch(owner, repo, headRef, finalized)
      await updateCommentWithResults(owner, repo, commentId, headRef, finalized)
    } else {
      await updateCommentWithResults(owner, repo, commentId, headRef, [])
    }
  } catch {
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

export async function handleTestFix(
  context: PullRequestContextWithTests,
  iteration?: number
) {
  const { owner, repo, pullNumber, headRef } = context
  let commentId: number | undefined
  try {
    commentId = await createPlaceholderComment(
      owner,
      repo,
      pullNumber,
      `🧪 AI Test Fix #${iteration} in progress...`
    )
    const fixPrompt = `We have failing tests. Attempt #${iteration}. Please fix or create new unit tests as needed.`
    const testProposals = await generateTestsForChanges(context, fixPrompt)
    consoleLogProposals(testProposals)
    if (testProposals.length > 0) {
      const finalized = finalizeTestProposals(testProposals, context)
      await commitTestsToExistingBranch(owner, repo, headRef, finalized)
      await updateCommentWithResults(owner, repo, commentId, headRef, finalized)
    } else {
      await updateCommentWithResults(owner, repo, commentId, headRef, [])
    }
  } catch {
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

async function generateTestsForChanges(
  context: PullRequestContextWithTests,
  recommendation?: string
): Promise<TestProposal[]> {
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
You are an expert in writing unit tests for a Next.js codebase.
Recommendation: ${recommendation ?? ""}

Generate only unit tests. Use ".test.tsx" for React or Next.js pages, ".test.ts" for non-React.

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
    const { text } = await generateText({ model, prompt })
    const rawProposals = await parseTestXml(text)
    return finalizeTestProposals(rawProposals, context)
  } catch {
    return []
  }
}
