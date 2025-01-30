import { NextRequest, NextResponse } from "next/server"
import { handlePullRequest } from "./_lib/handlers"
import { handleReviewAgent } from "./_lib/review-agent"
import { handleTestGeneration } from "./_lib/test-agent"
import { verifyGitHubSignature } from "./_lib/verify-signature"

export async function POST(request: NextRequest) {
  try {
    // 1) Read the raw body as text so we can verify signature
    const rawBody = await request.text()

    // 2) If we have a secret, verify the signature
    const secret = process.env.GITHUB_WEBHOOK_SECRET
    if (secret) {
      const signature = request.headers.get("x-hub-signature-256") || ""
      const valid = verifyGitHubSignature(rawBody, secret, signature)
      if (!valid) {
        return NextResponse.json(
          { error: "Invalid signature." },
          { status: 401 }
        )
      }
    }

    // 3) Parse the JSON from rawBody now that signature is verified
    const payload = JSON.parse(rawBody)

    // 4) Check the event type from headers
    const eventType = request.headers.get("x-github-event")

    // We only care about "pull_request" events in this example
    if (eventType === "pull_request") {
      // Gather PR context (owner, repo, changed files, etc.)
      const context = await handlePullRequest(payload)

      // --------------------------------------------
      // Keep your existing code review logic
      // --------------------------------------------
      if (payload.action === "opened") {
        // If the PR is newly opened, run a code review
        await handleReviewAgent(context)
      }

      if (payload.action === "ready_for_review") {
        // If a draft PR is converted to ready, generate tests
        await handleTestGeneration(context)
      }

      // --------------------------------------------
      // NEW: Trigger test generation if user adds "agent-ready-for-tests" label
      // --------------------------------------------
      if (payload.action === "labeled") {
        // Double-check that this is the label we want to trigger on
        if (payload.label?.name === "agent-ready-for-tests") {
          await handleTestGeneration(context)
        }
      }
    }

    return NextResponse.json({ message: "OK" })
  } catch (error) {
    console.error("Error in webhook route:", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
