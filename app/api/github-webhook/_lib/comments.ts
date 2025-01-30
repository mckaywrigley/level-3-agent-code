import { octokit } from "./github"

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
