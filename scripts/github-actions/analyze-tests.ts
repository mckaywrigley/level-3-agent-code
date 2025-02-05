/*
<ai_context>
This script analyzes test results and updates the PR body with the iteration count.
It then calls the Next.js webhook to fix the tests.
</ai_context>
*/

import * as fs from "fs"
import fetch from "node-fetch"

/**
 * Main entry point for analyzing test results.
 * 1) Parse jest-results.json & playwright-report/report.json
 * 2) Read iteration from PR body
 * 3) Possibly increment iteration and call Next.js webhook to fix tests
 */
async function analyzeAndFixTests() {
  console.log("Starting analyzeAndFixTests...")

  // 1) We read environment variables set by the GitHub Actions workflow
  const githubToken = process.env.GITHUB_TOKEN
  const githubEventPath = process.env.GITHUB_EVENT_PATH
  const githubRepository = process.env.GITHUB_REPOSITORY

  if (!githubToken || !githubEventPath || !githubRepository) {
    throw new Error(
      "Missing required environment variables (GITHUB_TOKEN, GITHUB_EVENT_PATH, or GITHUB_REPOSITORY)."
    )
  }

  // 2) Parse the GitHub event to figure out PR number, branch, etc.
  console.log(`Reading GitHub event from: ${githubEventPath}`)
  const eventData = JSON.parse(fs.readFileSync(githubEventPath, "utf8"))
  // For pull_request events, eventData.pull_request might exist
  const pullRequest = eventData.pull_request
  if (!pullRequest) {
    console.log("No pull_request object in the event. Exiting.")
    return
  }

  const prNumber = pullRequest.number
  console.log(`Detected PR number: ${prNumber}`)

  // The GitHub repository string is typically "owner/repo"
  const [owner, repo] = githubRepository.split("/")

  // 3) Read test results from local files
  let jestFailed = 0
  let pwFailed = 0

  try {
    console.log("Parsing jest-results.json...")
    const jestRaw = fs.readFileSync("jest-results.json", "utf8")
    const jestData = JSON.parse(jestRaw)
    jestFailed = jestData.numFailedTests || 0
    console.log(`Jest failed tests: ${jestFailed}`)
  } catch (err) {
    console.log("Could not read or parse jest-results.json:", err)
  }

  try {
    console.log("Parsing playwright-report/report.json...")
    const pwRaw = fs.readFileSync("playwright-report/report.json", "utf8")
    const pwData = JSON.parse(pwRaw)
    const stats = pwData.stats || {}
    pwFailed = stats.unexpected || 0
    console.log(`Playwright failed tests: ${pwFailed}`)
  } catch (err) {
    console.log("Could not read or parse playwright-report/report.json:", err)
  }

  // 4) Post a test summary comment. (We use GitHub's REST API via fetch or an npm library.)
  //    We'll do a simple fetch approach here. We can also do an Octokit approach if you prefer.

  // Combined comment text
  let commentBody = `### Full Test Results\n\n`
  commentBody += `Jest Failed: ${jestFailed}, Playwright Failed: ${pwFailed}\n\n`
  console.log("Combined comment body:\n", commentBody)

  // Post the comment to the PR
  await githubApiRequest(
    `repos/${owner}/${repo}/issues/${prNumber}/comments`,
    githubToken,
    {
      body: commentBody
    },
    "POST"
  )

  // 5) If no tests failed, post success comment and exit
  if (jestFailed === 0 && pwFailed === 0) {
    console.log("All tests passing!")
    await githubApiRequest(
      `repos/${owner}/${repo}/issues/${prNumber}/comments`,
      githubToken,
      {
        body: "All tests passing! ✅"
      },
      "POST"
    )
    return
  }

  console.log("Tests have failures. Checking iteration count in PR body...")

  // 6) Get updated PR info to read the current body. We'll do a GET request to the "pulls" API.
  const prData = await githubApiRequest(
    `repos/${owner}/${repo}/pulls/${prNumber}`,
    githubToken,
    null,
    "GET"
  )
  let currentBody = prData.body || ""
  console.log("Current PR body is:", currentBody)

  // 7) Parse iteration
  let iteration = 0
  const match = currentBody.match(/AI Test Iteration:\s*(\d+)/)
  if (match) {
    iteration = parseInt(match[1], 10)
  }
  console.log(`Current iteration is: ${iteration}`)

  if (iteration >= 3) {
    console.log("Already tried 3 times. Stopping attempts.")
    await githubApiRequest(
      `repos/${owner}/${repo}/issues/${prNumber}/comments`,
      githubToken,
      {
        body: "❌ Tests failed after 3 AI fix attempts. Stopping iterative process."
      },
      "POST"
    )
    return
  }

  iteration++
  console.log(`Incrementing iteration to: ${iteration}`)

  // 8) Update the PR body with the new iteration
  const iterationLine = `AI Test Iteration: ${iteration}`
  if (match) {
    currentBody = currentBody.replace(/AI Test Iteration:\s*\d+/, iterationLine)
  } else {
    currentBody += `\n\n${iterationLine}`
  }

  console.log("Updating PR body with new iteration count...")
  await githubApiRequest(
    `repos/${owner}/${repo}/pulls/${prNumber}`,
    githubToken,
    {
      body: currentBody
    },
    "PATCH"
  )

  // 9) Post comment announcing next fix attempt
  await githubApiRequest(
    `repos/${owner}/${repo}/issues/${prNumber}/comments`,
    githubToken,
    {
      body: `Attempting AI test fix #${iteration}...`
    },
    "POST"
  )

  // 10) Finally, call the Next.js route to fix the tests
  console.log("Calling Next.js route for test fix attempt...")
  const routeUrl = `http://localhost:3000/api/github-webhook`
  await fetch(routeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-github-event": "test_fix"
    },
    body: JSON.stringify({
      repository: {
        owner: { login: owner },
        name: repo
      },
      pull_request: {
        number: prNumber,
        body: currentBody,
        head: { ref: pullRequest.head.ref }
      },
      iteration,
      testFix: true
    })
  })
  console.log("Done calling Next.js route for test fix.")
}

/**
 * Helper function to call GitHub's REST API with minimal boilerplate.
 */
async function githubApiRequest(
  endpoint: string,
  token: string,
  data: any,
  method: string = "POST"
): Promise<any> {
  const url = `https://api.github.com/${endpoint}`
  console.log(`GitHub API request to ${url} with method=${method}`)

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: data ? JSON.stringify(data) : null
  })

  if (!res.ok) {
    console.log(`GitHub API request failed with status ${res.status}`)
    const text = await res.text()
    throw new Error(
      `GitHub API error: ${res.status} ${res.statusText}\n${text}`
    )
  }

  if (
    method !== "DELETE" &&
    method !== "PATCH" &&
    method !== "POST" &&
    method !== "GET"
  ) {
    // If we do other methods, handle accordingly. For now we assume minimal usage.
    return null
  }

  // Return JSON if any
  let responseBody = null
  try {
    responseBody = await res.json()
  } catch {
    // no JSON in response
  }
  return responseBody
}

/**
 * If run directly via "node scripts/analyze-tests.js" or "npx tsx scripts/analyze-tests.ts"
 * we call analyzeAndFixTests() immediately.
 */
if (require.main === module) {
  analyzeAndFixTests()
    .then(() => {
      console.log("analyzeAndFixTests completed successfully.")
      process.exit(0)
    })
    .catch(err => {
      console.error("analyzeAndFixTests error:", err)
      process.exit(1)
    })
}

// If you want to import { analyzeAndFixTests } in another file, we can export it here
export { analyzeAndFixTests }
