import type { NextApiRequest, NextApiResponse } from "next"
import { handlePullRequest } from "./_lib/handlers"
import { handleReviewAgent } from "./_lib/review-agent"
import { handleTestGeneration } from "./_lib/test-agent"

export default async function githubWebhook(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" })
  }

  const eventType = req.headers["x-github-event"]
  const payload = req.body

  if (eventType === "pull_request") {
    const context = await handlePullRequest(payload)

    if (payload.action === "opened" || payload.action === "ready_for_review") {
      await handleReviewAgent(context)
    }

    if (
      payload.action === "labeled" &&
      payload.label.name === "ready-for-tests"
    ) {
      await handleTestGeneration(context)
    }
  }

  return res.status(200).json({ message: "OK" })
}
