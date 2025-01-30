import { NextRequest, NextResponse } from "next/server"
import {
  handlePullRequestBase,
  handlePullRequestForTestAgent
} from "./_lib/handlers"
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

    // 3) Parse the JSON from rawBody
    const payload = JSON.parse(rawBody)

    // 4) Check the event type from headers
    const eventType = request.headers.get("x-github-event")

    // We only care about "pull_request" events in this example
    if (eventType === "pull_request") {
      // Review agent - uses base context without tests
      if (payload.action === "opened") {
        const context = await handlePullRequestBase(payload)
        await handleReviewAgent(context)
      }

      // Test agent - needs context with existing tests
      if (payload.action === "ready_for_review") {
        const context = await handlePullRequestForTestAgent(payload)
        await handleTestGeneration(context)
      }

      // Manual label triggers
      if (payload.action === "labeled") {
        const labelName = payload.label?.name

        if (labelName === "agent-ready-for-tests") {
          const context = await handlePullRequestForTestAgent(payload)
          await handleTestGeneration(context)
        }

        if (labelName === "agent-review") {
          const context = await handlePullRequestBase(payload)
          await handleReviewAgent(context)
        }
      }
    }

    return NextResponse.json({ message: "OK" })
  } catch (error) {
    console.error("Error in webhook route:", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
