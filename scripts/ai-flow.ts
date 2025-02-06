/***************************************************************
 * AI Flow Script (ai-flow.ts)
 *
 * Purpose:
 *  - This script is designed to run as part of the GitHub
 *    Actions workflow (described above in ai-agent.yml).
 *  - It does the following:
 *    1. Checks if we're dealing with a pull request (PR) event.
 *    2. Gathers PR context (files changed, commit messages, etc.).
 *    3. Runs an AI-based code review (JSON output).
 *    4. Runs AI-based test generation if needed (JSON output).
 *    5. Executes tests locally (on the GitHub runner).
 *    6. If tests fail, attempts iterative fixes up to 3 times,
 *       passing the error output back to the AI each time.
 *    7. Comments results back on the PR.
 *
 * Key Points:
 *  - We now request **strict JSON** from the LLM instead of XML.
 *  - We use Zod schemas + `generateObject` to parse the AI’s output.
 ***************************************************************/
import { getLLMModel } from "@/lib/agents/llm"
import { Octokit } from "@octokit/rest"
import { generateObject } from "ai"
import { Buffer } from "buffer"
import { execSync } from "child_process"
import * as fs from "fs"
import { z } from "zod" // We rely on Zod for JSON validation

const githubToken = process.env.GITHUB_TOKEN
if (!githubToken) {
  console.error("Missing GITHUB_TOKEN - cannot proceed.")
  process.exit(1)
}

/***************************************************************
 * ZOD SCHEMAS
 * We define one for each piece of AI output: review, gating, tests.
 ***************************************************************/

/**
 * Code Review Schema
 * Example JSON:
 * {
 *   "summary": "Short summary",
 *   "fileAnalyses": [
 *     { "path": "some-file.ts", "analysis": "Analysis text" }
 *   ],
 *   "overallSuggestions": ["Add more doc", "Refactor method"]
 * }
 */
const reviewSchema = z.object({
  summary: z.string(),
  fileAnalyses: z.array(
    z.object({
      path: z.string(),
      analysis: z.string()
    })
  ),
  overallSuggestions: z.array(z.string())
})
export type ReviewAnalysis = z.infer<typeof reviewSchema>

/**
 * Gating Schema
 * Example JSON:
 * {
 *   "decision": {
 *     "shouldGenerateTests": true,
 *     "reasoning": "...",
 *     "recommendation": "..."
 *   }
 * }
 */
const gatingSchema = z.object({
  decision: z.object({
    shouldGenerateTests: z.boolean(),
    reasoning: z.string(),
    recommendation: z.string()
  })
})

/**
 * Test Proposals Schema
 * Example JSON:
 * {
 *   "testProposals": [
 *     {
 *       "filename": "__tests__/unit/some.test.tsx",
 *       "testContent": "...entire test file code...",
 *       "actions": {
 *         "action": "create",
 *         "oldFilename": "..."
 *       }
 *     }
 *   ]
 * }
 */
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

/***************************************************************
 * MAIN FLOW
 ***************************************************************/
async function runFlow() {
  // 1) Check if this is a PR event
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) {
    console.log("No GITHUB_EVENT_PATH found. Not in GitHub Actions? Exiting.")
    return
  }

  // 2) Parse the event JSON to see if it includes a pull_request object
  const eventData = JSON.parse(fs.readFileSync(eventPath, "utf8"))
  const pullRequest = eventData.pull_request
  if (!pullRequest) {
    console.log("Not a pull_request event. Exiting.")
    return
  }

  // 3) Identify the owner/repo from env vars
  const repoStr = process.env.GITHUB_REPOSITORY
  if (!repoStr) {
    console.log("No GITHUB_REPOSITORY found. Exiting.")
    return
  }
  const [owner, repo] = repoStr.split("/")
  const prNumber = pullRequest.number
  console.log(`Handling PR #${prNumber} on ${owner}/${repo}`)

  // 4) Auth Octokit
  const octokit = new Octokit({ auth: githubToken })

  // 5) Gather PR context
  const baseContext = await buildPRContext(octokit, owner, repo, prNumber)

  // 6) AI code review
  console.log("=== AI Code Review ===")
  const reviewAnalysis = await handleReviewAgent(octokit, baseContext)

  // 7) AI test generation
  console.log("=== AI Test Generation ===")
  const testContext = await buildTestContext(octokit, baseContext)
  await handleTestGeneration(octokit, testContext, reviewAnalysis)

  // 8) Run local tests
  console.log("=== Running local tests ===")
  let testResult = runLocalTests()

  // 9) Up to 3 fix attempts if tests fail
  let iteration = 0
  const maxIterations = 3
  while (testResult.jestFailed && iteration < maxIterations) {
    iteration++
    console.log(`\n=== Attempting AI Test Fix #${iteration} ===`)
    // Provide the error logs so the AI sees the actual failure
    await handleTestFix(octokit, testContext, iteration, testResult.output)
    testResult = runLocalTests()
  }

  // 10) Final result
  if (!testResult.jestFailed) {
    console.log("All tests passing after AI generation/fixes!")
    await postComment(
      octokit,
      owner,
      repo,
      prNumber,
      "✅ All tests passing after AI generation/fixes!"
    )
    process.exit(0)
  } else {
    console.log(`❌ Still failing after ${maxIterations} fix attempts.`)
    await postComment(
      octokit,
      owner,
      repo,
      prNumber,
      `❌ Tests failing after ${maxIterations} fix attempts.`
    )
    process.exit(1)
  }
}

/***************************************************************
 * TYPES & HELPERS
 ***************************************************************/
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
    const res = await octokit.repos.getContent({ owner, repo, path, ref })
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

/***************************************************************
 * CODE REVIEW
 ***************************************************************/
async function handleReviewAgent(
  octokit: Octokit,
  context: PullRequestContext
) {
  const placeholderId = await createComment(
    octokit,
    context,
    "🤖 AI Code Review in progress..."
  )

  const analysis = await generateReview(context)
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
  console.log("Generating AI code review via JSON...")

  const changedFilesPrompt = context.changedFiles
    .map(f => {
      if (f.excluded) return `File: ${f.filename} [EXCLUDED FROM PROMPT]`
      return `File: ${f.filename}\nPatch:\n${f.patch}\nContent:\n${f.content ?? ""}`
    })
    .join("\n---\n")

  // The LLM must return JSON matching reviewSchema exactly
  const prompt = `
You are an expert code reviewer. Return valid JSON only, with the structure:
{
  "summary": "string",
  "fileAnalyses": [
    { "path": "string", "analysis": "string" }
  ],
  "overallSuggestions": ["string"]
}

Do not add extra keys or text. 

Context:
PR Title: ${context.title}
Commits:
${context.commitMessages.map(m => `- ${m}`).join("\n")}
Changed Files:
${changedFilesPrompt}
`

  const modelInfo = getLLMModel()
  try {
    const result = await generateObject({
      model: modelInfo,
      schema: reviewSchema, // parse into our Zod schema
      schemaName: "review",
      schemaDescription: "Code review feedback in JSON",
      prompt
    })
    return result.object
  } catch (err) {
    console.error("Error generating or parsing code review JSON:", err)
    // Fallback if AI fails to parse
    return {
      summary: "Review parse error",
      fileAnalyses: [],
      overallSuggestions: []
    }
  }
}

/***************************************************************
 * TEST GENERATION
 ***************************************************************/
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
            results.push({ filename: item.path, content: c })
          }
        } else if (item.type === "dir") {
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
  const placeholderId = await createComment(
    octokit,
    context,
    "🧪 AI Test Generation in progress..."
  )
  const gating = await gatingStep(context)
  if (!gating.shouldGenerate) {
    await updateComment(
      octokit,
      context,
      placeholderId,
      `Skipping test generation: ${gating.reason}`
    )
    return
  }

  // Combine gating recommendation + review analysis
  let combinedRec = gating.recommendation
  if (reviewAnalysis) {
    combinedRec += `\nReview Analysis:\n${reviewAnalysis.summary}`
  }

  const proposals = await generateTestsForChanges(context, combinedRec)
  if (proposals.length > 0) {
    await commitTests(
      octokit,
      context.owner,
      context.repo,
      context.headRef,
      proposals
    )
    await updateCommentWithResults(octokit, context, placeholderId, proposals)
  } else {
    await updateCommentWithResults(octokit, context, placeholderId, [])
  }
}

/***************************************************************
 * GATING STEP
 ***************************************************************/
async function gatingStep(context: PullRequestContextWithTests) {
  const existingTestsPrompt = context.existingTestFiles
    .map(f => `Existing test: ${f.filename}\n---\n${f.content}`)
    .join("\n")
  const changedFilesPrompt = context.changedFiles
    .map(file => {
      if (file.excluded) return `File: ${file.filename} [EXCLUDED]`
      return `File: ${file.filename}\nPatch:\n${file.patch}\nContent:\n${file.content}`
    })
    .join("\n---\n")

  const prompt = `
You are an expert in deciding if tests are needed. Return JSON only:
{
  "decision": {
    "shouldGenerateTests": true or false,
    "reasoning": "string",
    "recommendation": "string"
  }
}

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
  } catch (err) {
    console.error("Error in gating step:", err)
    return { shouldGenerate: false, reason: "Gating error", recommendation: "" }
  }
}

/***************************************************************
 * GENERATING TESTS
 ***************************************************************/
interface TestProposal {
  filename: string
  testContent: string
  actions: {
    action: "create" | "update" | "rename"
    oldFilename: string
  }
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

Do not add any extra keys or text. 

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
    // result.object has shape { testProposals: TestProposal[] }
    return finalizeTestProposals(result.object.testProposals, context)
  } catch (err) {
    console.error("Error generating or parsing test proposals JSON:", err)
    return []
  }
}

/**
 * finalizeTestProposals
 * (Same logic as before for ensuring .test.ts vs. .test.tsx, etc.)
 */
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

    // Ensure extension matches React code
    let newFilename = proposal.filename
    if (isReact && !newFilename.endsWith(".test.tsx")) {
      newFilename = newFilename.replace(/\.test\.ts$/, ".test.tsx")
    } else if (!isReact && !newFilename.endsWith(".test.ts")) {
      newFilename = newFilename.replace(/\.test\.tsx$/, ".test.ts")
    }

    // Ensure in __tests__/unit by default
    if (!newFilename.includes("__tests__/unit")) {
      newFilename = `__tests__/unit/${newFilename}`
    }

    return {
      ...proposal,
      filename: newFilename
    }
  })
}

/***************************************************************
 * COMMITTING TESTS
 ***************************************************************/
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

/***************************************************************
 * ITERATIVE TEST FIX
 ***************************************************************/
export async function handleTestFix(
  octokit: Octokit,
  context: PullRequestContextWithTests,
  iteration: number,
  testErrorOutput?: string
) {
  const placeholderId = await createComment(
    octokit,
    context,
    `🧪 AI Test Fix #${iteration} in progress...`
  )
  const fixPrompt = `
We have failing tests (attempt #${iteration}).
Here is the error output:
${testErrorOutput ?? "No output"}
Please fix or create new tests as needed, returning JSON in the same format.
`

  const proposals = await generateTestsForChanges(context, fixPrompt)
  if (proposals.length) {
    await commitTests(
      octokit,
      context.owner,
      context.repo,
      context.headRef,
      proposals
    )
    await updateCommentWithResults(octokit, context, placeholderId, proposals)
  } else {
    await updateCommentWithResults(octokit, context, placeholderId, [])
  }
}

/***************************************************************
 * RUN LOCAL TESTS
 ***************************************************************/
function runLocalTests(): { jestFailed: boolean; output: string } {
  let jestFailed = false
  let output = ""
  try {
    output = execSync("npm run test", { encoding: "utf8" })
  } catch (err: any) {
    jestFailed = true
    output = err.stdout || err.message || "Unknown error"
  }
  console.log(`Jest failed? ${jestFailed}`)
  return { jestFailed, output }
}

/***************************************************************
 * GITHUB COMMENT HELPERS
 ***************************************************************/
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

/***************************************************************
 * Run the flow
 ***************************************************************/
runFlow()
  .then(() => {
    console.log("Done with AI flow script.")
  })
  .catch(err => {
    console.error("Error in ai-flow:", err)
    process.exit(1)
  })
