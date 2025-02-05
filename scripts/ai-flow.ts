import { getLLMModel } from "@/lib/agents/llm"
import { Octokit } from "@octokit/rest"
import { generateObject, generateText } from "ai"
import { Buffer } from "buffer"
import { execSync } from "child_process"
import * as fs from "fs"
import { parseStringPromise } from "xml2js"
import { z } from "zod"

// Read environment
const githubToken = process.env.GITHUB_TOKEN

if (!githubToken) {
  console.error("Missing GITHUB_TOKEN - cannot proceed.")
  process.exit(1)
}

async function runFlow() {
  // 1) Check if this is actually a PR event
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) {
    console.log("No GITHUB_EVENT_PATH found. Not in GitHub Actions? Exiting.")
    return
  }

  // 2) Parse the event to find the pull request
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
  console.log(`Handling PR #${prNumber} on ${owner}/${repo}`)

  // 3) Construct an authenticated client
  const octokit = new Octokit({ auth: githubToken })

  // 4) Gather PR context
  const baseContext = await buildPRContext(octokit, owner, repo, prNumber)

  // 5) AI code review
  console.log("=== AI Code Review ===")
  const reviewAnalysis = await handleReviewAgent(octokit, baseContext)

  // 6) AI test generation
  console.log("=== AI Test Generation ===")
  const testContext = await buildTestContext(octokit, baseContext)
  await handleTestGeneration(octokit, testContext, reviewAnalysis)

  // 7) Run tests
  console.log("=== Running local tests ===")
  let testResult = runLocalTests()

  // 8) Iterative fix attempts
  let iteration = 0
  const maxIterations = 3
  while (!testResult.jestFailed && iteration < maxIterations) {
    iteration++
    console.log(`\n=== Attempting AI Test Fix #${iteration} ===`)
    await handleTestFix(octokit, testContext, iteration)
    testResult = runLocalTests()
  }

  // 9) Final result
  if (!testResult.jestFailed) {
    console.log("All tests passing after AI generation/fixes!")
    await postComment(
      octokit,
      owner,
      repo,
      prNumber,
      "✅ All tests passing after AI generation/fixes!"
    )
    process.exit(0) // Succeed the job
  } else {
    console.log(`❌ Still failing after ${maxIterations} fix attempts.`)
    await postComment(
      octokit,
      owner,
      repo,
      prNumber,
      `❌ Tests failing after ${maxIterations} fix attempts.`
    )
    process.exit(1) // Mark the job as failed
  }
}

//
//  PR CONTEXT
//

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

//
// CODE REVIEW
//

interface ReviewAnalysis {
  summary: string
  fileAnalyses: Array<{ path: string; analysis: string }>
  overallSuggestions: string[]
}

async function handleReviewAgent(
  octokit: Octokit,
  context: PullRequestContext
) {
  // Create a placeholder comment so the user knows we're reviewing
  const placeholderId = await createComment(
    octokit,
    context,
    "🤖 AI Code Review in progress..."
  )
  // Generate review
  const analysis = await generateReview(context)
  // Update the placeholder with final results
  const body = `
### AI Code Review

**Summary**  
${analysis.summary}

${analysis.fileAnalyses
  .map(f => `**File:** ${f.path}\nAnalysis:\n${f.analysis}`)
  .join("\n\n")}

**Suggestions**  
${analysis.overallSuggestions.map(s => `- ${s}`).join("\n")}
`
  await updateComment(octokit, context, placeholderId, body)
  return analysis
}

async function generateReview(
  context: PullRequestContext
): Promise<ReviewAnalysis> {
  console.log("Generating AI code review...")

  const changedFilesPrompt = context.changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename}\n[EXCLUDED FROM PROMPT]\n`
      }
      return `File: ${file.filename}\nPatch:\n${file.patch}\nContent:\n${file.content ?? ""}`
    })
    .join("\n---\n")

  const prompt = `
You are an expert code reviewer. Provide feedback on the following pull request changes.

PR Title: ${context.title}
Commit Messages:
${context.commitMessages.map(msg => `- ${msg}`).join("\n")}
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
    const modelInfo = getLLMModel()
    const { text } = await generateText({
      model: modelInfo,
      prompt
    })
    return await parseReviewXml(text)
  } catch (err) {
    console.error("Error generating review:", err)
    return {
      summary: "Failed to parse AI review.",
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
      summary: "Could not find <review> tags.",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
  const xmlPortion = xmlText.slice(startIndex, endIndex)
  const parsed = await parseStringPromise(xmlPortion)
  const summary = parsed.review.summary?.[0] ?? ""
  const fileAnalyses = []
  const overallSuggestions = []

  if (
    parsed.review.fileAnalyses?.[0]?.file &&
    Array.isArray(parsed.review.fileAnalyses[0].file)
  ) {
    for (const f of parsed.review.fileAnalyses[0].file) {
      fileAnalyses.push({
        path: f.path?.[0] || "",
        analysis: f.analysis?.[0] || ""
      })
    }
  }
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

//
// TEST GENERATION
//

interface PullRequestContextWithTests extends PullRequestContext {
  existingTestFiles: {
    filename: string
    content: string
  }[]
}

async function buildTestContext(
  octokit: Octokit,
  context: PullRequestContext
): Promise<PullRequestContextWithTests> {
  const existingTestFiles = await getAllTestFiles(
    octokit,
    context.owner,
    context.repo,
    context.headRef
  )
  return { ...context, existingTestFiles }
}

async function getAllTestFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  dirPath = "__tests__"
): Promise<{ filename: string; content: string }[]> {
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
          const c = await getFileContent(octokit, owner, repo, item.path, ref)
          if (c) {
            results.push({
              filename: item.path,
              content: c
            })
          }
        } else if (item.type === "dir") {
          // Recurse
          const sub = await getAllTestFiles(
            octokit,
            owner,
            repo,
            ref,
            item.path
          )
          results.push(...sub)
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
  console.log("Creating placeholder comment for test gen...")
  const placeholderId = await createComment(
    octokit,
    context,
    "🧪 AI Test Generation in progress..."
  )

  console.log("Running gating step...")
  const gating = await gatingStep(context)
  if (!gating.shouldGenerate) {
    console.log("Skipping test generation:", gating.reason)
    await updateComment(
      octokit,
      context,
      placeholderId,
      `Skipping test generation: ${gating.reason}`
    )
    return
  }

  let combinedRec = gating.recommendation
  if (reviewAnalysis) {
    combinedRec += `\nReview Analysis:\n${reviewAnalysis.summary}`
  }

  console.log("Generating test proposals from AI...")
  const proposals = await generateTestsForChanges(context, combinedRec)
  if (proposals.length > 0) {
    console.log("Committing proposals to PR branch...")
    await commitTests(
      octokit,
      context.owner,
      context.repo,
      context.headRef,
      proposals
    )
    await updateCommentWithResults(octokit, context, placeholderId, proposals)
  } else {
    console.log("No proposals from AI.")
    await updateCommentWithResults(octokit, context, placeholderId, [])
  }
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
    .map(f => `Existing test: ${f.filename}\n---\n${f.content}`)
    .join("\n")
  const changedFilesPrompt = context.changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename} [EXCLUDED]`
      }
      return `File: ${file.filename}\nPatch:\n${file.patch}\nContent:\n${file.content}`
    })
    .join("\n---\n")

  const prompt = `
You are an expert in deciding if tests are needed.
Return JSON only: {"decision":{"shouldGenerateTests":true or false,"reasoning":"some text","recommendation":"some text"}}

Title: ${context.title}
Commits:
${context.commitMessages.map(m => `- ${m}`).join("\n")}
Changed Files:
${changedFilesPrompt}
Existing Tests:
${existingTestsPrompt}
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
  } catch (err) {
    console.error("Error in gating step:", err)
    return { shouldGenerate: false, reason: "Gating error", recommendation: "" }
  }
}

//
// TEST PROPOSALS
//

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
    .map(f => `Existing test: ${f.filename}\n---\n${f.content}`)
    .join("\n")
  const changedFilesPrompt = context.changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename} [EXCLUDED FROM PROMPT]`
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

  const fullPrompt = `
${prompt}

Title: ${context.title}
Commits:
${context.commitMessages.map(m => `- ${m}`).join("\n")}
Changed Files:
${changedFilesPrompt}
Existing Tests:
${existingTestsPrompt}
`
  try {
    const { text } = await generateText({
      model: modelInfo,
      prompt: fullPrompt
    })
    return await parseTestXml(text, context)
  } catch (err) {
    console.error("Error generating test proposals:", err)
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
    console.log("No <tests> block found in AI output.")
    return []
  }
  const xmlPortion = xmlText.slice(startIndex, endIndex)
  const parsed = await parseStringPromise(xmlPortion)
  const proposalsArr = parsed.tests?.testProposals?.[0]?.proposal
  if (!Array.isArray(proposalsArr)) return []

  const results: TestProposal[] = []
  for (const item of proposalsArr) {
    const filename = item.filename?.[0] || ""
    let testContent = item.testContent?.[0] || ""
    if (typeof testContent === "object" && "_" in testContent) {
      testContent = testContent._
    }
    const testType = item.testType?.[0] === "e2e" ? "e2e" : "unit"

    const actionNode = item.actions?.[0]
    let action: "create" | "update" | "rename" = "create"
    let oldFilename: string | undefined
    if (actionNode?.action?.[0]) {
      const raw = actionNode.action[0]
      if (["create", "update", "rename"].includes(raw)) {
        action = raw as any
      }
    }
    if (actionNode?.oldFilename?.[0]) {
      oldFilename = actionNode.oldFilename[0]
    }

    if (filename && testContent) {
      // Tweak extension if needed
      const finalName = finalizeFileExtension(filename, context)
      results.push({
        filename: finalName,
        testType,
        testContent,
        actions: { action, oldFilename }
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
  // If it's React code, ensure .test.tsx
  if (isReact && !filename.endsWith(".test.tsx")) {
    return filename.replace(/\.test\.ts$/, ".test.tsx")
  }
  // If it's not React, ensure .test.ts
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
  for (const p of proposals) {
    if (
      p.actions?.action === "rename" &&
      p.actions?.oldFilename &&
      p.actions.oldFilename !== p.filename
    ) {
      // attempt rename by removing old and adding new
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

    // create or update the new file
    const encoded = Buffer.from(p.testContent, "utf8").toString("base64")
    try {
      const { data: existingFile } = await octokit.repos.getContent({
        owner,
        repo,
        path: p.filename,
        ref: branch
      })
      // if found, update
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
      // If 404, create
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

async function updateCommentWithResults(
  octokit: Octokit,
  context: PullRequestContext,
  commentId: number,
  proposals: TestProposal[]
) {
  const list = proposals.map(p => `- ${p.filename}`).join("\n")
  const body = proposals.length
    ? `✅ Proposed new/updated tests:\n${list}`
    : `No new test proposals from AI.`
  await updateComment(octokit, context, commentId, body)
}

//
// TEST FIX
//

async function handleTestFix(
  octokit: Octokit,
  context: PullRequestContextWithTests,
  iteration: number
) {
  const placeholderId = await createComment(
    octokit,
    context,
    `🧪 AI Test Fix #${iteration} in progress...`
  )
  const fixPrompt = `We have failing tests. Attempt #${iteration}. Please fix existing or create new ones.`
  const proposals = await generateTestsForChanges(context, fixPrompt)
  if (proposals.length) {
    console.log("Fix proposals found, committing them...")
    await commitTests(
      octokit,
      context.owner,
      context.repo,
      context.headRef,
      proposals
    )
    await updateCommentWithResults(octokit, context, placeholderId, proposals)
  } else {
    console.log("No fix proposals from AI.")
    await updateCommentWithResults(octokit, context, placeholderId, [])
  }
}

//
// TEST RUN
//

function runLocalTests(): {
  jestFailed: boolean
} {
  let jestFailed = false
  try {
    execSync("npm run test:unit", { stdio: "inherit" })
  } catch (err) {
    jestFailed = true
  }
  console.log(`Jest failed? ${jestFailed}`)
  return { jestFailed }
}

//
// GITHUB COMMENT HELPERS
//

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

//
// RUN IT
//

runFlow()
  .then(() => {
    console.log("Done with AI flow script.")
  })
  .catch(err => {
    console.error("Error in ai-flow:", err)
    // If we haven't exited yet, do so here with code 1
    process.exit(1)
  })
