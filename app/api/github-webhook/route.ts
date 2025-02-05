/*
<ai_context>
This route contains the main logic for handling GitHub webhook events.
It acts as the entry point for all GitHub webhook requests and routes them
to the appropriate handlers based on the event type and action.
</ai_context>
*/

import { NextRequest, NextResponse } from "next/server"
import {
  handlePullRequestBase,
  handlePullRequestForTestAgent
} from "./_lib/handlers"
import { handleReviewAgent } from "./_lib/review-agent"
import { handleTestFix, handleTestGeneration } from "./_lib/test-agent"

export async function POST(request: NextRequest) {
  try {
    const bodyText = await request.text()

    const payload = JSON.parse(bodyText || "{}")

    const eventType = request.headers.get("x-github-event")
    console.log("Webhook event type:", eventType)

    // Normal pull_request events
    if (eventType === "pull_request") {
      const action = payload.action
      console.log("pull_request action:", action)

      // If a PR is newly opened/updated, do code review first, then test generation
      if (
        action === "opened" ||
        action === "synchronize" ||
        action === "reopened"
      ) {
        console.log("Running code review, then test generation...")

        const baseContext = await handlePullRequestBase(payload)

        // 1) Review agent
        const reviewAnalysis = await handleReviewAgent(baseContext)
        console.log("Code review complete. Now building test context...")

        // 2) Build test context
        const testContext = await handlePullRequestForTestAgent(payload)
        console.log(
          "Test context built. Invoking handleTestGeneration with code review result..."
        )

        await handleTestGeneration(testContext, reviewAnalysis)
      }
    }

    // Our custom "test_fix" event from the GitHub Action
    else if (eventType === "test_fix") {
      console.log("Received test_fix event from GH Action...")

      const pr = payload.pull_request
      if (!pr) {
        console.log("No pull_request data in test_fix payload. Exiting.")
        return NextResponse.json({ message: "No PR data for test_fix" })
      }

      // We'll re-use the PR context approach
      const mockPayload = {
        repository: payload.repository,
        pull_request: {
          number: pr.number,
          head: {
            ref: pr.head.ref
          },
          body: pr.body
        }
      }

      console.log("Building base context for test fix...")
      const baseContext = await handlePullRequestBase(mockPayload)

      console.log("Building test context for test fix...")
      const testContext = await handlePullRequestForTestAgent(mockPayload)

      // Now call handleTestFix
      await handleTestFix(testContext, payload.iteration)
    }

    return NextResponse.json({ message: "OK" })
  } catch (error) {
    console.error("Error in webhook route:", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
