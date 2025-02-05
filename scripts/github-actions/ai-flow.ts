/*
<ai_context>
Merges code review and test generation logic in one script.
Uses the same environment variables and prompt logic as before.
</ai_context>
*/

import { getLLMModel } from "@/app/api/github-webhook/_lib/llm"
import { Octokit } from "@octokit/rest"
import { generateObject, generateText } from "ai"
import { Buffer } from "buffer"
import { execSync } from "child_process"
import * as fs from "fs"
import { parseStringPromise } from "xml2js"
import { z } from "zod"

const githubToken = process.env.GITHUB_TOKEN
const openaiApiKey = process.env.OPENAI_API_KEY || ""
const anthropicApiKey = process.env.ANTHROPIC_API_KEY || ""
const llmProvider = process.env.LLM_PROVIDER || "openai"

if (!githubToken) {
  console.error("Missing GITHUB_TOKEN.")
  process.exit(1)
}

async function runFlow() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) {
    console.log("Not running in GitHub Actions context. Exiting.")
    return
  }

  const eventData = JSON.parse(fs.readFileSync(eventPath, "utf8"))
  const pullRequest = eventData.pull_request
  if (!pullRequest) {
    console.log("Not a pull_request event. Exiting.")
    return
  }

  const repoStr = process.env.GITHUB_REPOSITORY
  if (!repoStr) {
    console.log("No GITHUB_REPOSITORY found. Exiting.")
    return
  }

  const [owner, repo] = repoStr.split("/")
  const prNumber = pullRequest.number
  const headRef = pullRequest.head.ref
  console.log(`Handling PR #${prNumber} on ${owner}/${repo}`)

  const octokit = new Octokit({ auth: githubToken })

  const baseContext = await buildPRContext(octokit, owner, repo, prNumber)
  const reviewAnalysis = await handleReviewAgent(octokit, baseContext)
  const testContext = await buildTestContext(octokit, baseContext, owner, repo)
  await handleTestGeneration(octokit, testContext, reviewAnalysis)

  let testResult = runLocalTests()
  let iteration = 0
  const maxIterations = 3

  while (!testResult.allPassed && iteration < maxIterations) {
    iteration++
    await handleTestFix(octokit, testContext, iteration)
    testResult = runLocalTests()
  }

  if (testResult.allPassed) {
    await postComment(octokit, owner, repo, prNumber, "✅ All tests passing!")
  } else {
    await postComment(
      octokit,
      owner,
      repo,
      prNumber,
      `❌ Tests failing after ${maxIterations} fix attempts.`
    )
  }

  console.log("Done.")
}

interface PullRequestContext {
  owner: string
  repo: string
  pullNumber: number
  headRef: string
  baseRef: string
  title: string
  changedFiles: {
    filename: string
    patch: string
    status: string
    additions: number
    deletions: number
    content?: string
    excluded?: boolean
  }[]
  commitMessages: string[]
}

interface PullRequestContextWithTests extends PullRequestContext {
  existingTestFiles: {
    filename: string
    content: string
  }[]
}

async function buildPRContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PullRequestContext> {
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber
  })

  const filesRes = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber
  })
  const commitsRes = await octokit.pulls.listCommits({
    owner,
    repo,
    pull_number: pullNumber
  })

  const changedFiles = []
  for (const file of filesRes.data) {
    const fileObj = {
      filename: file.filename,
      patch: file.patch ?? "",
      status: file.status || "",
      additions: file.additions || 0,
      deletions: file.deletions || 0,
      content: undefined as string | undefined,
      excluded: false
    }

    if (file.status !== "removed" && !shouldExcludeFile(file.filename)) {
      const content = await getFileContent(
        octokit,
        owner,
        repo,
        file.filename,
        pr.head.ref
      )
      if (content && content.length <= 32000) {
        fileObj.content = content
      } else {
        fileObj.excluded = true
      }
    } else {
      fileObj.excluded = true
    }
    changedFiles.push(fileObj)
  }

  const commitMessages = commitsRes.data.map(c => c.commit.message)
  return {
    owner,
    repo,
    pullNumber,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    title: pr.title || "",
    changedFiles,
    commitMessages
  }
}

function shouldExcludeFile(filename: string): boolean {
  const EXCLUDE_PATTERNS = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]
  return EXCLUDE_PATTERNS.some(pattern => filename.endsWith(pattern))
}

async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
) {
  try {
    const res = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref
    })
    if ("content" in res.data && typeof res.data.content === "string") {
      return Buffer.from(res.data.content, "base64").toString("utf8")
    }
    return undefined
  } catch (err: any) {
    if (err.status === 404) {
      console.log(`File ${path} not found at ref ${ref}`)
      return undefined
    }
    throw err
  }
}

async function handleReviewAgent(
  octokit: Octokit,
  context: PullRequestContext
) {
  const message = "🤖 AI Code Review in progress..."
  const placeholder = await createComment(octokit, context, message)
  const analysis = await generateReview(context)
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
  await updateComment(octokit, context, placeholder, commentBody)
  return analysis
}

interface ReviewAnalysis {
  summary: string
  fileAnalyses: Array<{ path: string; analysis: string }>
  overallSuggestions: string[]
}

async function generateReview(context: PullRequestContext) {
  const modelInfo = getLLMModel()
  const { title, changedFiles, commitMessages } = context
  const changedFilesPrompt = changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename}\n[EXCLUDED FROM PROMPT]\n`
      }
      return `File: ${file.filename}\nPatch:\n${file.patch}\nCurrent Content:\n${file.content}\n`
    })
    .join("\n---\n")

  const prompt = `
You are an expert code reviewer. Provide feedback on the following pull request changes.

PR Title: ${title}
Commit Messages:
${commitMessages.map(msg => `- ${msg}`).join("\n")}
Changed Files:
${changedFilesPrompt}

Return ONLY valid XML:
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
    const { text } = await generateText({
      model: modelInfo,
      prompt
    })
    const parsed = await parseReviewXml(text)
    return parsed
  } catch (err) {
    return {
      summary: "Error analyzing code.",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
}

async function parseReviewXml(xmlText: string): Promise<ReviewAnalysis> {
  const startTag = "<review>"
  const endTag = "</review>"
  const startIndex = xmlText.indexOf(startTag)
  const endIndex = xmlText.indexOf(endTag) + endTag.length
  if (startIndex === -1 || endIndex === -1) {
    return {
      summary: "No <review> tag found.",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
  const xmlPortion = xmlText.slice(startIndex, endIndex)
  const parsed = await parseStringPromise(xmlPortion)
  const summary = parsed.review.summary?.[0] ?? ""
  const fileAnalyses: { path: string; analysis: string }[] = []
  if (
    parsed.review.fileAnalyses?.[0]?.file &&
    Array.isArray(parsed.review.fileAnalyses[0].file)
  ) {
    for (const f of parsed.review.fileAnalyses[0].file) {
      fileAnalyses.push({
        path: f.path?.[0] ?? "",
        analysis: f.analysis?.[0] ?? ""
      })
    }
  }
  const overallSuggestions: string[] = []
  if (
    parsed.review.overallSuggestions?.[0]?.suggestion &&
    Array.isArray(parsed.review.overallSuggestions[0].suggestion)
  ) {
    for (const s of parsed.review.overallSuggestions[0].suggestion) {
      overallSuggestions.push(s)
    }
  }
  return { summary, fileAnalyses, overallSuggestions }
}

async function buildTestContext(
  octokit: Octokit,
  context: PullRequestContext,
  owner: string,
  repo: string
): Promise<PullRequestContextWithTests> {
  const existingTestFiles = await getAllTestFiles(
    octokit,
    owner,
    repo,
    context.headRef
  )
  return {
    ...context,
    existingTestFiles
  }
}

async function getAllTestFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  dirPath = "__tests__"
) {
  const results: { filename: string; content: string }[] = []
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: dirPath,
      ref
    })
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.type === "file") {
          const content = await getFileContent(
            octokit,
            owner,
            repo,
            item.path,
            ref
          )
          if (content) {
            results.push({
              filename: item.path,
              content
            })
          }
        } else if (item.type === "dir") {
          const subFiles = await getAllTestFiles(
            octokit,
            owner,
            repo,
            ref,
            item.path
          )
          results.push(...subFiles)
        }
      }
    }
  } catch (err: any) {
    if (err.status !== 404) throw err
  }
  return results
}

async function handleTestGeneration(
  octokit: Octokit,
  context: PullRequestContextWithTests,
  reviewAnalysis?: ReviewAnalysis
) {
  const placeholder = await createComment(
    octokit,
    context,
    "🧪 AI Test Generation in progress..."
  )
  const gatingResult = await gatingStep(context)
  if (!gatingResult.shouldGenerate) {
    await updateComment(
      octokit,
      context,
      placeholder,
      `Skipping test generation: ${gatingResult.reason}`
    )
    return
  }
  let recommendation = gatingResult.recommendation
  if (reviewAnalysis) {
    recommendation += `\nReview Analysis:\n${reviewAnalysis.summary}`
  }
  const proposals = await generateTestsForChanges(context, recommendation)
  if (proposals.length) {
    await commitTests(
      octokit,
      context.owner,
      context.repo,
      context.headRef,
      proposals
    )
  }
  await updateCommentWithResults(octokit, context, placeholder, proposals)
}

const gatingSchema = z.object({
  decision: z.object({
    shouldGenerateTests: z.boolean(),
    reasoning: z.string(),
    recommendation: z.string()
  })
})

async function gatingStep(context: PullRequestContextWithTests) {
  const modelInfo = getLLMModel()
  const existingTestsPrompt = context.existingTestFiles
    .map(f => `Existing test: ${f.filename}\n---\n${f.content}\n---\n`)
    .join("\n")
  const changedFilesPrompt = context.changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename}\n[EXCLUDED]`
      }
      return `File: ${file.filename}\nPatch:\n${file.patch}\nContent:\n${file.content}`
    })
    .join("\n---\n")

  const prompt = `
You are an expert in deciding if tests are needed.

Title: ${context.title}
Commits:
${context.commitMessages.map(m => `- ${m}`).join("\n")}
Changed Files:
${changedFilesPrompt}
Existing Tests:
${existingTestsPrompt}

Return JSON only: {"decision":{"shouldGenerateTests":true or false,"reasoning":"some text","recommendation":"some text"}}
`
  try {
    const result = await generateObject({
      model: modelInfo,
      schema: gatingSchema,
      schemaName: "decision",
      schemaDescription: "Decision for test generation",
      prompt
    })
    return {
      shouldGenerate: result.object.decision.shouldGenerateTests,
      reason: result.object.decision.reasoning,
      recommendation: result.object.decision.recommendation || ""
    }
  } catch {
    return { shouldGenerate: false, reason: "Gating error", recommendation: "" }
  }
}

interface TestProposal {
  filename: string
  testType?: "unit" | "e2e"
  testContent: string
  actions?: {
    action: "create" | "update" | "rename"
    oldFilename?: string
  }
}

async function generateTestsForChanges(
  context: PullRequestContextWithTests,
  recommendation: string
): Promise<TestProposal[]> {
  const modelInfo = getLLMModel()
  const existingTestsPrompt = context.existingTestFiles
    .map(f => `Existing test: ${f.filename}\n---\n${f.content}\n---\n`)
    .join("\n")
  const changedFilesPrompt = context.changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename}\n[EXCLUDED]\n`
      }
      return `File: ${file.filename}\nPatch:\n${file.patch}\nContent:\n${file.content}`
    })
    .join("\n---\n")

  const prompt = `
You are an expert developer specializing in test generation.

Recommendation:
${recommendation}

We have:
1) Unit tests in "__tests__/unit/"
2) E2E tests in "__tests__/e2e/"

Only generate tests for front-end code. Name them ".test.tsx" if React, otherwise ".test.ts".
If an existing test file needs an update or rename, do so.

Return ONLY valid XML:

<tests>
  <testProposals>
    <proposal>
      <filename>__tests__/unit/... .test.ts[x]</filename>
      <testType>unit or e2e</testType>
      <testContent><![CDATA[
YOUR TEST CODE
]]></testContent>
      <actions>
        <action>create|update|rename</action>
        <oldFilename>optional old file</oldFilename>
      </actions>
    </proposal>
  </testProposals>
</tests>
`

  try {
    const { text } = await generateText({
      model: modelInfo,
      prompt: `
${prompt}

Title: ${context.title}
Commits:
${context.commitMessages.map(m => `- ${m}`).join("\n")}
Changed Files:
${changedFilesPrompt}
Existing Tests:
${existingTestsPrompt}
`
    })
    return await parseTestXml(text, context)
  } catch {
    return []
  }
}

async function parseTestXml(
  xmlText: string,
  context: PullRequestContextWithTests
) {
  const startTag = "<tests>"
  const endTag = "</tests>"
  const startIndex = xmlText.indexOf(startTag)
  const endIndex = xmlText.indexOf(endTag) + endTag.length
  if (startIndex === -1 || endIndex === -1) {
    return []
  }
  const xmlPortion = xmlText.slice(startIndex, endIndex)
  const parsed = await parseStringPromise(xmlPortion)
  const proposalsArr = parsed.tests?.testProposals?.[0]?.proposal
  if (!Array.isArray(proposalsArr)) return []
  const results: TestProposal[] = []
  for (const item of proposalsArr) {
    const filename = item.filename?.[0] || ""
    const testType = item.testType?.[0] === "e2e" ? "e2e" : "unit"
    let testContent = item.testContent?.[0] || ""
    if (typeof testContent === "object" && "_" in testContent) {
      testContent = testContent._
    }
    const actionNode = item.actions?.[0]
    let action = "create"
    let oldFilename
    if (actionNode?.action?.[0]) {
      const raw = actionNode.action[0]
      if (["create", "update", "rename"].includes(raw)) action = raw
    }
    if (actionNode?.oldFilename?.[0]) {
      oldFilename = actionNode.oldFilename[0]
    }
    if (filename && testContent) {
      results.push({
        filename: finalizeFileExtension(filename, context),
        testType,
        testContent,
        actions: { action: action as any, oldFilename }
      })
    }
  }
  return results
}

function finalizeFileExtension(
  filename: string,
  context: PullRequestContextWithTests
) {
  const isReact = context.changedFiles.some(file => {
    if (!file.content) return false
    return (
      file.filename.endsWith(".tsx") ||
      file.content.includes("import React") ||
      file.content.includes('from "react"') ||
      file.filename.includes("app/")
    )
  })
  if (isReact && !filename.endsWith(".test.tsx")) {
    return filename.replace(/\.test\.ts$/, ".test.tsx")
  }
  if (!isReact && !filename.endsWith(".test.ts")) {
    return filename.replace(/\.test\.tsx$/, ".test.ts")
  }
  return filename
}

async function commitTests(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  proposals: TestProposal[]
) {
  for (const proposal of proposals) {
    const old = proposal.actions?.oldFilename
    if (
      proposal.actions?.action === "rename" &&
      old &&
      old !== proposal.filename
    ) {
      try {
        const { data: oldFile } = await octokit.repos.getContent({
          owner,
          repo,
          path: old,
          ref: branch
        })
        if ("sha" in oldFile) {
          await octokit.repos.deleteFile({
            owner,
            repo,
            path: old,
            message: `Rename ${old} to ${proposal.filename}`,
            branch,
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
        ref: branch
      })
      const content = Buffer.from(proposal.testContent, "utf8").toString(
        "base64"
      )
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: proposal.filename,
        message: `Add/Update tests: ${proposal.filename}`,
        content,
        branch,
        sha: "sha" in existingFile ? existingFile.sha : undefined
      })
    } catch (error: any) {
      if (error.status === 404) {
        const content = Buffer.from(proposal.testContent, "utf8").toString(
          "base64"
        )
        await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: proposal.filename,
          message: `Add/Update tests: ${proposal.filename}`,
          content,
          branch
        })
      } else {
        throw error
      }
    }
  }
}

async function handleTestFix(
  octokit: Octokit,
  context: PullRequestContextWithTests,
  iteration: number
) {
  const placeholder = await createComment(
    octokit,
    context,
    `🧪 AI Test Fix #${iteration} in progress...`
  )
  const fixPrompt = `We have failing tests. Attempt #${iteration}. Please fix existing or create new ones.`
  const proposals = await generateTestsForChanges(context, fixPrompt)
  if (proposals.length) {
    await commitTests(
      octokit,
      context.owner,
      context.repo,
      context.headRef,
      proposals
    )
  }
  await updateCommentWithResults(octokit, context, placeholder, proposals)
}

function runLocalTests() {
  let jestFailed = false
  let pwFailed = false
  try {
    execSync("npm run test:unit", { stdio: "inherit" })
  } catch {
    jestFailed = true
  }
  try {
    execSync("npm run test:e2e", { stdio: "inherit" })
  } catch {
    pwFailed = true
  }
  return { allPassed: !jestFailed && !pwFailed, jestFailed, pwFailed }
}

async function createComment(
  octokit: Octokit,
  context: PullRequestContext,
  body: string
) {
  const { data } = await octokit.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullNumber,
    body
  })
  return data.id
}

async function updateComment(
  octokit: Octokit,
  context: PullRequestContext,
  commentId: number,
  body: string
) {
  await octokit.issues.updateComment({
    owner: context.owner,
    repo: context.repo,
    comment_id: commentId,
    body
  })
}

async function updateCommentWithResults(
  octokit: Octokit,
  context: PullRequestContext,
  commentId: number,
  proposals: TestProposal[]
) {
  const testList = proposals.map(t => `- ${t.filename}`).join("\n")
  const body = proposals.length
    ? `Proposed test updates:\n${testList}`
    : `No new proposals.`
  await updateComment(octokit, context, commentId, body)
}

async function postComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
) {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body
  })
}

runFlow()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
