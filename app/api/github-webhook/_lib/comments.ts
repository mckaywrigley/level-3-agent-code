import { octokit } from "./github"

/**
 * createPlaceholderComment:
 * Creates a new comment on the PR. Returns the comment ID for future updates.
 */
export async function createPlaceholderComment(
  owner: string,
  repo: string,
  pullNumber: number,
  placeholderMessage: string
): Promise<number> {
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: placeholderMessage
  })
  return data.id
}

/**
 * updateComment:
 * Updates an existing comment by comment ID.
 */
export async function updateComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string
) {
  await octokit.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body
  })
}
