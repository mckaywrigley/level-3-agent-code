import { Octokit } from "@octokit/rest"
import * as fs from "fs"
import { handleReviewAgent, ReviewAnalysis } from "./code-review"
import { createComment, updateComment } from "./github-comments"
import { buildPRContext, buildTestContext } from "./pr-context"
import { handleTestFix } from "./test-fix"
import { gatingStep } from "./test-gating"
import { handleTestGeneration } from "./test-proposals"
import { runLocalTests } from "./test-runner"

export async function runFlow() {
  const githubToken = process.env.GITHUB_TOKEN
  if (!githubToken) {
    console.error("Missing GITHUB_TOKEN - cannot proceed.")
    process.exit(1)
  }

  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) {
    console.log("No GITHUB_EVENT_PATH found. Not in GitHub Actions? Exiting.")
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
  const octokit = new Octokit({ auth: githubToken })

  const baseContext = await buildPRContext(octokit, owner, repo, prNumber)

  let reviewBody = "### AI Code Review\n_(initializing...)_"
  const reviewCommentId = await createComment(octokit, baseContext, reviewBody)
  const reviewAnalysis: ReviewAnalysis | undefined = await handleReviewAgent(
    octokit,
    baseContext,
    reviewCommentId,
    reviewBody
  )

  let testBody = "### AI Test Generation\n_(initializing...)_"
  const testCommentId = await createComment(octokit, baseContext, testBody)
  const testContext = await buildTestContext(octokit, baseContext)

  const gating = await gatingStep(
    testContext,
    octokit,
    testCommentId,
    testBody,
    reviewAnalysis
  )
  if (!gating.shouldGenerate) {
    process.exit(0)
  }

  testBody = gating.testBody
  await handleTestGeneration(
    octokit,
    testContext,
    reviewAnalysis,
    testCommentId,
    testBody
  )

  let testResult = runLocalTests()
  let iteration = 0
  const maxIterations = 3

  while (testResult.jestFailed && iteration < maxIterations) {
    iteration++
    testBody += `\n\n**Test Fix #${iteration}**\nTests are failing. Attempting a fix...`
    await updateComment(octokit, baseContext, testCommentId, testBody)
    await handleTestFix(
      octokit,
      testContext,
      iteration,
      testResult.output,
      testCommentId,
      testBody
    )
    testResult = runLocalTests()
  }

  if (!testResult.jestFailed) {
    testBody += "\n\n✅ All tests passing after AI generation/fixes!"
    await updateComment(octokit, baseContext, testCommentId, testBody)
    process.exit(0)
  } else {
    testBody += `\n\n❌ Tests failing after ${maxIterations} fix attempts.`
    await updateComment(octokit, baseContext, testCommentId, testBody)
    process.exit(1)
  }
}
