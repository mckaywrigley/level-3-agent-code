import { generateObject } from "ai"
import { Buffer } from "buffer"
import { z } from "zod"
import { ReviewAnalysis } from "./code-review"
import { updateComment } from "./github-comments"
import { getLLMModel } from "./llm"
import { PullRequestContextWithTests } from "./pr-context"

const testProposalsSchema = z.object({
  testProposals: z.array(
    z.object({
      filename: z.string(),
      testContent: z.string(),
      actions: z.object({
        action: z.enum(["create", "update", "rename"]),
        oldFilename: z.string()
      })
    })
  )
})

export interface TestProposal {
  filename: string
  testContent: string
  actions: {
    action: "create" | "update" | "rename"
    oldFilename: string
  }
}

export async function handleTestGeneration(
  octokit: any,
  context: PullRequestContextWithTests,
  reviewAnalysis: ReviewAnalysis | undefined,
  testCommentId: number,
  testBody: string
) {
  testBody += "\n\n**Generating Tests**..."
  await updateComment(octokit, context, testCommentId, testBody)

  let recommendation = ""
  if (reviewAnalysis) {
    recommendation = `Review Analysis:\n${reviewAnalysis.summary}`
  }

  const proposals = await generateTestsForChanges(context, recommendation)
  if (proposals.length > 0) {
    await commitTests(
      octokit,
      context.owner,
      context.repo,
      context.headRef,
      proposals
    )
    testBody += "\n\n**Proposed new/updated tests:**\n"
    for (const p of proposals) {
      testBody += `- ${p.filename}\n`
    }
  } else {
    testBody += "\n\nNo new test proposals from AI."
  }
  await updateComment(octokit, context, testCommentId, testBody)
}

async function generateTestsForChanges(
  context: PullRequestContextWithTests,
  recommendation: string
): Promise<TestProposal[]> {
  const existingTestsPrompt = context.existingTestFiles
    .map(f => `Existing test: ${f.filename}\n---\n${f.content}`)
    .join("\n")

  const changedFilesPrompt = context.changedFiles
    .map(file => {
      if (file.excluded) return `File: ${file.filename} [EXCLUDED FROM PROMPT]`
      return `File: ${file.filename}\nPatch:\n${file.patch}\nContent:\n${file.content}`
    })
    .join("\n---\n")

  const prompt = `
You are an expert developer specializing in test generation.

Return only valid JSON matching this structure:
{
  "testProposals": [
    {
      "filename": "string",
      "testContent": "string",
      "actions": {
        "action": "create" or "update" or "rename",
        "oldFilename": "string"
      }
    }
  ]
}

Recommendation:
${recommendation}

Title: ${context.title}
Commits:
${context.commitMessages.map(m => `- ${m}`).join("\n")}
Changed Files:
${changedFilesPrompt}
Existing Tests:
${existingTestsPrompt}
`
  const modelInfo = getLLMModel()
  try {
    const result = await generateObject({
      model: modelInfo,
      schema: testProposalsSchema,
      schemaName: "testProposals",
      schemaDescription: "Proposed test files in JSON",
      prompt
    })
    return finalizeTestProposals(result.object.testProposals, context)
  } catch (err) {
    return []
  }
}

function finalizeTestProposals(
  rawProposals: TestProposal[],
  context: PullRequestContextWithTests
): TestProposal[] {
  return rawProposals.map(proposal => {
    const isReact = context.changedFiles.some(file => {
      if (!file.content) return false
      return (
        file.filename.endsWith(".tsx") ||
        file.content.includes("import React") ||
        file.content.includes('from "react"') ||
        file.filename.includes("app/")
      )
    })
    let newFilename = proposal.filename
    if (isReact && !newFilename.endsWith(".test.tsx")) {
      newFilename = newFilename.replace(/\.test\.ts$/, ".test.tsx")
    } else if (!isReact && !newFilename.endsWith(".test.ts")) {
      newFilename = newFilename.replace(/\.test\.tsx$/, ".test.ts")
    }
    if (!newFilename.includes("__tests__/unit")) {
      newFilename = `__tests__/unit/${newFilename}`
    }
    return { ...proposal, filename: newFilename }
  })
}

async function commitTests(
  octokit: any,
  owner: string,
  repo: string,
  branch: string,
  proposals: TestProposal[]
) {
  for (const p of proposals) {
    if (
      p.actions?.action === "rename" &&
      p.actions.oldFilename &&
      p.actions.oldFilename !== p.filename
    ) {
      try {
        const { data: oldFile } = await octokit.repos.getContent({
          owner,
          repo,
          path: p.actions.oldFilename,
          ref: branch
        })
        if ("sha" in oldFile) {
          await octokit.repos.deleteFile({
            owner,
            repo,
            path: p.actions.oldFilename,
            message: `Rename ${p.actions.oldFilename} to ${p.filename}`,
            branch,
            sha: oldFile.sha
          })
        }
      } catch (err: any) {
        if (err.status !== 404) throw err
      }
    }

    const encoded = Buffer.from(p.testContent, "utf8").toString("base64")
    try {
      const { data: existingFile } = await octokit.repos.getContent({
        owner,
        repo,
        path: p.filename,
        ref: branch
      })
      if ("sha" in existingFile) {
        await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: p.filename,
          message: `Add/Update tests: ${p.filename}`,
          content: encoded,
          branch,
          sha: existingFile.sha
        })
      }
    } catch (error: any) {
      if (error.status === 404) {
        await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: p.filename,
          message: `Add/Update tests: ${p.filename}`,
          content: encoded,
          branch
        })
      } else {
        throw error
      }
    }
  }
}
