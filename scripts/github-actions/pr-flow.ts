import { execSync } from "child_process"
import * as fs from "fs"
import fetch from "node-fetch"

async function runSinglePassFlow() {
  console.log("Starting single-pass flow with existing Next.js route...")

  // 1) Load environment
  const githubToken = process.env.GITHUB_TOKEN
  const githubEventPath = process.env.GITHUB_EVENT_PATH
  const repoStr = process.env.GITHUB_REPOSITORY
  if (!githubToken || !githubEventPath || !repoStr) {
    throw new Error(
      "Missing GITHUB_TOKEN, GITHUB_EVENT_PATH, or GITHUB_REPOSITORY."
    )
  }

  // 2) Read the GH event for PR data
  const eventData = JSON.parse(fs.readFileSync(githubEventPath, "utf8"))
  const pullRequest = eventData.pull_request
  if (!pullRequest) {
    console.log("Not a pull_request event. Exiting.")
    return
  }

  const prNumber = pullRequest.number
  const [owner, repo] = repoStr.split("/")
  console.log(`Handling PR #${prNumber} on ${owner}/${repo}`)

  // 3) Call our Next.js route with eventType=single_pass to do code review + test generation
  console.log("Calling Next.js route => single_pass (review + test gen)...")
  await postToAiRoute(
    "single_pass",
    {
      repository: { owner: { login: owner }, name: repo },
      pull_request: { number: prNumber, head: { ref: pullRequest.head.ref } }
    },
    githubToken
  )

  // We assume the route commits new tests to the PR branch (like "bot: add AI tests").
  // Now we re-checkout the new commit that has the tests:
  console.log("Pulling updated PR branch with new tests...")
  execSync(`git pull origin HEAD`, { stdio: "inherit" })

  // 4) Run tests locally
  let testResult = runLocalTests()
  console.log("Initial test result after generation:", testResult)

  // 5) If fail, do iterative fix
  let iteration = 0
  const maxIterations = 3

  while (!testResult.allPassed && iteration < maxIterations) {
    iteration++
    console.log(`=== Iteration #${iteration} fix attempt ===`)

    // Call route => test_fix
    await postToAiRoute(
      "test_fix",
      {
        repository: { owner: { login: owner }, name: repo },
        pull_request: { number: prNumber, head: { ref: pullRequest.head.ref } },
        iteration
      },
      githubToken
    )

    // The route presumably commits a fix. Pull again:
    console.log("Pulling updated PR branch after fix commit...")
    execSync(`git pull origin HEAD`, { stdio: "inherit" })

    // Re-run tests
    testResult = runLocalTests()
    console.log(`After iteration #${iteration}, test result:`, testResult)
  }

  if (testResult.allPassed) {
    console.log("All tests passing now! 🎉")
    await postComment(
      owner,
      repo,
      prNumber,
      githubToken,
      "✅ All tests passing after AI generation/fixes!"
    )
  } else {
    console.log(`Still failing after ${maxIterations} attempts. ❌`)
    await postComment(
      owner,
      repo,
      prNumber,
      githubToken,
      `❌ Tests failing after ${maxIterations} fix attempts.`
    )
  }

  console.log("Single-pass flow complete.")
}

/**
 * Post to our Next.js route on /api/github-webhook with a custom event type.
 */
async function postToAiRoute(eventType: string, payload: any, token: string) {
  const routeUrl = "http://localhost:3000/api/github-webhook"
  console.log(`POST -> ${routeUrl}, x-github-event=${eventType}`)
  const res = await fetch(routeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-github-event": eventType,
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`AI route error: HTTP ${res.status} => ${text}`)
  }
  console.log("AI route request succeeded.")
}

/**
 * Runs your local tests (Jest/Playwright). Return a pass/fail object.
 * Adjust as needed to parse actual results or do coverage.
 */
function runLocalTests(): {
  allPassed: boolean
  jestFailed: number
  pwFailed: number
} {
  let jestFailed = 0
  let pwFailed = 0

  console.log("Running local Jest tests...")
  try {
    execSync(`npm run test:unit`, { stdio: "inherit" })
  } catch (e) {
    jestFailed = 1
  }

  console.log("Running local Playwright tests...")
  try {
    execSync(`npm run test:e2e`, { stdio: "inherit" })
  } catch (e) {
    pwFailed = 1
  }

  const allPassed = jestFailed === 0 && pwFailed === 0
  return { allPassed, jestFailed, pwFailed }
}

/**
 * Helper to post a comment on the PR using GitHub's REST API.
 */
async function postComment(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  body: string
) {
  console.log(`Posting comment to PR #${issueNumber}:`, body)
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ body })
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to post comment: ${text}`)
  }
}

// Run if directly invoked
if (require.main === module) {
  runSinglePassFlow()
    .then(() => {
      console.log("pr-flow done.")
      process.exit(0)
    })
    .catch(err => {
      console.error("pr-flow error:", err)
      process.exit(1)
    })
}
