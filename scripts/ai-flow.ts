/***************************************************************
 * AI Flow Script (ai-flow.ts)
 *
 * Purpose:
 *  - This script is designed to run as part of the GitHub
 *    Actions workflow (described above in ai-agent.yml).
 *  - It does the following:
 *    1. Checks if we're dealing with a pull request (PR) event.
 *    2. Gathers PR context (files changed, commit messages, etc.).
 *    3. Runs an AI-based code review.
 *    4. Runs AI-based test generation if needed.
 *    5. Executes tests locally (on the GitHub runner).
 *    6. If tests fail, attempts iterative fixes up to 3 times,
 *       passing the error output back to the AI each time.
 *    7. Comments results back on the PR.
 *
 * Libraries Used:
 *  - "octokit" for GitHub REST API operations
 *  - "ai" library for calling LLMs
 *  - "xml2js" for parsing XML from AI responses
 *  - "zod" for JSON validation
 *  - Node.js built-ins (fs, child_process, etc.)
 *
 * Key Points:
 *  - We use environment variables for the GitHub token (GITHUB_TOKEN),
 *    and for LLM providers (OPENAI_API_KEY, ANTHROPIC_API_KEY).
 *  - We post helpful comments on the PR (like placeholders, final messages).
 ***************************************************************/
import { getLLMModel } from "@/lib/agents/llm"
import { Octokit } from "@octokit/rest"
import { generateObject, generateText } from "ai"
import { Buffer } from "buffer"
import { execSync } from "child_process"
import * as fs from "fs"
import { parseStringPromise } from "xml2js"
import { z } from "zod"

// --------------------------------------------------------------------------
// Read environment variables, especially the GitHub Token, which is mandatory
// to interact with the PR (updating comments, pushing changes, etc.).
// --------------------------------------------------------------------------
const githubToken = process.env.GITHUB_TOKEN

if (!githubToken) {
  console.error("Missing GITHUB_TOKEN - cannot proceed.")
  process.exit(1)
}

// --------------------------------------------------------------------------
// runFlow()
// This is our main function that will be called at the bottom.
//
// It orchestrates the steps: check for a PR event, gather context, run
// review, generate tests, run tests, attempt iterative fixes, and finally
// post a success or failure comment to the PR.
// --------------------------------------------------------------------------
async function runFlow() {
  // 1) Check if this is actually a PR event
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

  // 3) Identify the owner/repo from environment variables
  //    GITHUB_REPOSITORY is typically "owner/repo".
  const repoStr = process.env.GITHUB_REPOSITORY
  if (!repoStr) {
    console.log("No GITHUB_REPOSITORY found. Exiting.")
    return
  }
  const [owner, repo] = repoStr.split("/")
  const prNumber = pullRequest.number
  console.log(`Handling PR #${prNumber} on ${owner}/${repo}`)

  // 4) Construct an authenticated Octokit client using our GitHub token
  //    so we can call GitHub APIs (pulls, issues, etc.).
  const octokit = new Octokit({ auth: githubToken })

  // 5) Gather PR context: the changed files, commits, references, etc.
  const baseContext = await buildPRContext(octokit, owner, repo, prNumber)

  // 6) AI code review step
  console.log("=== AI Code Review ===")
  const reviewAnalysis = await handleReviewAgent(octokit, baseContext)

  // 7) AI test generation step
  console.log("=== AI Test Generation ===")
  const testContext = await buildTestContext(octokit, baseContext)
  await handleTestGeneration(octokit, testContext, reviewAnalysis)

  // 8) Run tests locally (on the GitHub Actions runner).
  console.log("=== Running local tests ===")
  let testResult = runLocalTests()

  // 9) Iterative fix attempts - up to 3 times.
  let iteration = 0
  const maxIterations = 3

  // IMPORTANT FIX: We loop while tests fail (instead of while tests pass).
  while (testResult.jestFailed && iteration < maxIterations) {
    iteration++
    console.log(`\n=== Attempting AI Test Fix #${iteration} ===`)
    // Pass the error logs to the fix function so the AI sees the actual failure
    await handleTestFix(octokit, testContext, iteration, testResult.output)
    // Re-run tests after the fix attempt
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

// --------------------------------------------------------------------------
// Pull Request Context: Types & Functions
// --------------------------------------------------------------------------

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

/**
 * buildPRContext
 *
 * Given a repo/PR, fetch:
 *  - The PR metadata (head ref, base ref, title, etc.)
 *  - The changed files with patches & file contents
 *  - The commit messages
 *
 * We skip large files (over 32,000 characters) to avoid
 * overloading the prompt. We also skip lock files.
 */
async function buildPRContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PullRequestContext> {
  // Get the PR details (so we know the head ref, base ref, etc.)
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber
  })

  // List all files changed in the PR
  const filesRes = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber
  })

  // Get the commit messages for the PR
  const commitsRes = await octokit.pulls.listCommits({
    owner,
    repo,
    pull_number: pullNumber
  })

  // For each changed file, store relevant data
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

    // If the file isn't removed and isn't in the excluded pattern list:
    if (file.status !== "removed" && !shouldExcludeFile(file.filename)) {
      // We fetch the file content from the PR's head branch
      const content = await getFileContent(
        octokit,
        owner,
        repo,
        file.filename,
        pr.head.ref
      )
      // Exclude giant files to avoid blowing up the LLM context
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

/**
 * shouldExcludeFile
 * Helper to filter out package lock files, etc.,
 * so we don't feed them to the AI for review or test generation.
 */
function shouldExcludeFile(filename: string): boolean {
  const EXCLUDE_PATTERNS = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]
  return EXCLUDE_PATTERNS.some(pattern => filename.endsWith(pattern))
}

/**
 * getFileContent
 * Uses the GitHub API to fetch file contents from a specific ref (branch/commit).
 * We decode the Base64 content before returning it.
 */
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
    // If the file doesn't exist at that ref, just return undefined
    if (err.status === 404) {
      console.log(`File ${path} not found at ref ${ref}`)
      return undefined
    }
    throw err
  }
}

// --------------------------------------------------------------------------
// Code Review Step
// --------------------------------------------------------------------------

interface ReviewAnalysis {
  summary: string
  fileAnalyses: Array<{ path: string; analysis: string }>
  overallSuggestions: string[]
}

/**
 * handleReviewAgent
 *
 * 1. Creates a placeholder comment on the PR to indicate we're doing a review.
 * 2. Calls generateReview() to get the AI-based review text.
 * 3. Updates the placeholder comment with the final review analysis.
 */
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

  // Generate the code review using an LLM
  const analysis = await generateReview(context)

  // Build a Markdown body that includes a summary, file analyses, suggestions
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
  // Update the placeholder comment with the final result
  await updateComment(octokit, context, placeholderId, body)
  return analysis
}

/**
 * generateReview
 *
 * Builds a prompt that includes:
 *  - The PR title
 *  - The commit messages
 *  - The changed files (patches + content, unless excluded)
 *
 * The AI response is parsed from an XML structure to extract
 * a summary, file analyses, and suggestions.
 */
async function generateReview(
  context: PullRequestContext
): Promise<ReviewAnalysis> {
  console.log("Generating AI code review...")

  // Build the text prompt from changed files
  const changedFilesPrompt = context.changedFiles
    .map(file => {
      if (file.excluded) {
        return `File: ${file.filename}\n[EXCLUDED FROM PROMPT]\n`
      }
      return `File: ${file.filename}\nPatch:\n${file.patch}\nContent:\n${file.content ?? ""}`
    })
    .join("\n---\n")

  // Full prompt for the LLM
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
    // "generateText" calls the LLM with the prompt
    const { text } = await generateText({
      model: modelInfo,
      prompt
    })
    // The AI should return XML, so we parse it into structured data
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

/**
 * parseReviewXml
 *
 * Since the AI responds in an XML format, we:
 *  - Search for <review> ... </review> in the text
 *  - Use xml2js to parse that portion
 *  - Extract a summary, file analyses, suggestions
 */
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

// --------------------------------------------------------------------------
// Test Generation Step
// --------------------------------------------------------------------------

interface PullRequestContextWithTests extends PullRequestContext {
  existingTestFiles: {
    filename: string
    content: string
  }[]
}

/**
 * buildTestContext
 *
 * Extends the PullRequestContext by also fetching any existing
 * test files in the "__tests__" directory. The AI can then see
 * how tests are structured and either update or create new ones.
 */
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

/**
 * getAllTestFiles
 *
 * Recursively fetches every file from the "__tests__" directory
 * (and its subfolders) at a given ref (branch).
 */
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
          // Recurse subfolders
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

/**
 * handleTestGeneration
 *
 * 1. Creates a placeholder comment (to indicate test generation).
 * 2. Runs a "gating" step that decides if we should generate tests or not.
 * 3. If yes, we gather proposals from AI, commit them to the PR, and update the comment.
 */
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

  // Merge the gating's recommendation with any code review results
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
    // Update the placeholder comment with a list of proposed test files
    await updateCommentWithResults(octokit, context, placeholderId, proposals)
  } else {
    console.log("No proposals from AI.")
    await updateCommentWithResults(octokit, context, placeholderId, [])
  }
}

// --------------------------------------------------------------------------
// "Gating" Step: We ask the AI if we should even generate tests or not
// --------------------------------------------------------------------------

const gatingSchema = z.object({
  decision: z.object({
    shouldGenerateTests: z.boolean(),
    reasoning: z.string(),
    recommendation: z.string()
  })
})

/**
 * gatingStep
 *
 * Asks the LLM to examine the changed files and the existing tests.
 * The AI then returns a JSON object with:
 *  - shouldGenerateTests (boolean)
 *  - reasoning (string)
 *  - recommendation (string)
 */
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

  // This is the prompt we send to the AI, telling it to return JSON only.
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
    // "generateObject" can parse the AI output directly into a zod schema
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

// --------------------------------------------------------------------------
// Generating Test Proposals
// --------------------------------------------------------------------------

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
 * generateTestsForChanges
 *
 * Sends the changes to the AI, along with any existing test files,
 * telling it to propose new or updated test files.
 *
 * The AI returns them as an XML block. We parse that XML and produce
 * an array of TestProposal objects.
 */
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

  // We instruct the AI to return only valid XML that describes the proposed test files.
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
    // generateText calls the AI with our big prompt
    const { text } = await generateText({
      model: modelInfo,
      prompt: fullPrompt
    })
    // parseTestXml extracts the test proposals from the returned XML
    return await parseTestXml(text, context)
  } catch (err) {
    console.error("Error generating test proposals:", err)
    return []
  }
}

/**
 * parseTestXml
 *
 * Looks for <tests> ... </tests> in the AI's response, uses xml2js
 * to parse the proposals, and ensures the file extension is correct
 * (.test.ts or .test.tsx) based on whether the PR changes React code.
 */
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
    // If testContent is an object with "_" field, handle that
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

    // If we have a valid filename and some content, finalize extension
    if (filename && testContent) {
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

/**
 * finalizeFileExtension
 *
 * If the code changed is React-based, we ensure the test file ends with .test.tsx.
 * Otherwise, we ensure it ends with .test.ts.
 */
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

/**
 * commitTests
 *
 * Takes the generated test proposals and commits them directly
 * to the existing PR branch.
 */
async function commitTests(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  proposals: TestProposal[]
) {
  for (const p of proposals) {
    // If the AI wants to rename, we first delete the old file
    if (
      p.actions?.action === "rename" &&
      p.actions?.oldFilename &&
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

    // Then we create or update the new file
    const encoded = Buffer.from(p.testContent, "utf8").toString("base64")
    try {
      // Check if it already exists
      const { data: existingFile } = await octokit.repos.getContent({
        owner,
        repo,
        path: p.filename,
        ref: branch
      })
      // If found, update
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
      // If 404, create a new file
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

/**
 * updateCommentWithResults
 *
 * Replaces the placeholder comment with a summary of which test files
 * were generated or updated.
 */
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

// --------------------------------------------------------------------------
// Iterative Test Fix Step
// --------------------------------------------------------------------------

/**
 * handleTestFix
 *
 * If tests fail, this tries to fix them by:
 * 1) Posting a placeholder comment ("AI Test Fix #X in progress...")
 * 2) Generating new proposals from AI (like updates/edits to existing tests)
 * 3) Committing them
 * 4) Commenting results back to the PR
 */
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
  // Provide the actual Jest error logs so the AI knows what happened
  const fixPrompt = `We have failing tests (attempt #${iteration}). Here is the error output:\n\n${testErrorOutput}\n\nPlease fix or create new tests as needed.`

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

// --------------------------------------------------------------------------
// Running Tests Locally
// --------------------------------------------------------------------------

/**
 * runLocalTests
 *
 * We run "npm run test" on the GitHub Actions runner. If the tests
 * fail, we capture the error output so it can be passed to the AI
 * for a fix attempt.
 */
function runLocalTests(): {
  jestFailed: boolean
  output: string
} {
  let jestFailed = false
  let output = ""

  try {
    // Capture stdout so we can pass it to the AI if it fails
    output = execSync("npm run test", { encoding: "utf8" })
  } catch (err: any) {
    jestFailed = true
    // Try to grab whatever output we can from the error
    output = err.stdout || err.message || "Unknown error"
  }

  console.log(`Jest failed? ${jestFailed}`)
  return { jestFailed, output }
}

// --------------------------------------------------------------------------
// GitHub Comment Helpers
// --------------------------------------------------------------------------

/**
 * createComment
 *
 * Creates a new comment on the PR. We use this for placeholders
 * like "in progress..." so the user sees immediate feedback.
 */
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

/**
 * updateComment
 *
 * Updates a previously created comment (by ID) with new text.
 */
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

/**
 * postComment
 *
 * Creates a brand-new comment. We use this for final "Success/Fail" messages
 * at the end of the process, or for additional info we want to share.
 */
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

// --------------------------------------------------------------------------
// Finally, we call runFlow() to start the entire AI workflow logic.
// --------------------------------------------------------------------------
runFlow()
  .then(() => {
    console.log("Done with AI flow script.")
  })
  .catch(err => {
    console.error("Error in ai-flow:", err)
    // If we haven't exited yet, do so here with code 1
    process.exit(1)
  })
