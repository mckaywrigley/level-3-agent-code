/*
<ai_context>
We removed or commented out the old label-based triggers. 
We keep handleReviewAgent, handleTestGeneration, and handleTestFix for calls from our script.
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
    console.log("Webhook route called with body:", bodyText)

    const payload = JSON.parse(bodyText || "{}")
    const eventType = request.headers.get("x-github-event")
    console.log("x-github-event:", eventType)

    // We removed the old "pull_request" event logic that automatically did stuff.

    // Instead, if we see eventType === 'single_pass',
    // we do code review + test generation in a single call:
    if (eventType === "single_pass") {
      console.log("Single-pass AI flow invoked from external script...")

      // Build context
      const baseContext = await handlePullRequestBase(payload)
      console.log("Base context built. Running code review...")

      const reviewAnalysis = await handleReviewAgent(baseContext)
      console.log("Review done. Building test context to generate tests...")

      const testContext = await handlePullRequestForTestAgent(payload)
      await handleTestGeneration(testContext, reviewAnalysis)

      console.log("Single-pass flow done in route.")
    }

    // If we see eventType === 'test_fix', do iterative fix:
    else if (eventType === "test_fix") {
      console.log("Test fix event from external script...")

      const baseContext = await handlePullRequestBase(payload)
      const testContext = await handlePullRequestForTestAgent(payload)
      const iteration = payload.iteration || 1

      await handleTestFix(testContext, iteration)
    }

    return NextResponse.json({ message: "OK" })
  } catch (error) {
    console.error("Error in route:", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
