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

  // If this is a newly opened (or "ready_for_review") PR, run both agents
  if (
    eventType === "pull_request" &&
    (payload.action === "opened" || payload.action === "ready_for_review")
  ) {
    // 1) Gather context
    const context = await handlePullRequest(payload)

    // 2) Fire off the "Level 1" code review agent
    await handleReviewAgent(context)

    // 3) Fire off the "Level 2" test generation agent
    await handleTestGeneration(context)

    // If you want them to run conditionally, you could add logic here,
    // e.g. run only if certain files changed, etc.
  }

  return res.status(200).json({ message: "OK" })
}
