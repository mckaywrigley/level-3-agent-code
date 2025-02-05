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
import { handleReviewAgent, REVIEW_LABEL } from "./_lib/review-agent"
import { handleTestGeneration, TEST_GENERATION_LABEL } from "./_lib/test-agent"

/**
 * Handles POST requests from GitHub webhooks.
 * Depending on the event type and action, calls the appropriate agent or handler.
 *
 * @param request - The incoming webhook request from GitHub
 * @returns A response indicating success or failure
 */
export async function POST(request: NextRequest) {
  try {
    // Extract the raw body from the request
    const rawBody = await request.text()
    // Parse it as JSON (GitHub sends JSON payload)
    const payload = JSON.parse(rawBody)

    // Determine what kind of GitHub event this is
    const eventType = request.headers.get("x-github-event")

    // Handle pull request events
    if (eventType === "pull_request") {
      // If a PR is newly opened, automatically run the review agent
      if (payload.action === "opened") {
        const context = await handlePullRequestBase(payload)
        await handleReviewAgent(context)
      }

      // If a label is added to the PR, check which label it is
      if (payload.action === "labeled") {
        const labelName = payload.label?.name

        // If the label is for review, run the review agent
        if (labelName === REVIEW_LABEL) {
          const context = await handlePullRequestBase(payload)
          await handleReviewAgent(context)
        }

        // If the label is for test generation, run the test agent
        if (labelName === TEST_GENERATION_LABEL) {
          const context = await handlePullRequestForTestAgent(payload)
          await handleTestGeneration(context)
        }
      }
    }

    // Return a success response to GitHub
    return NextResponse.json({ message: "OK" })
  } catch (error) {
    // Log any errors that occur and return a 500 status
    console.error("Error in webhook route:", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
