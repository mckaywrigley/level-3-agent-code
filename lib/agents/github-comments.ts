import { PullRequestContext } from "./pr-context"

export async function createComment(
  octokit: any,
  context: PullRequestContext,
  body: string
): Promise<number> {
  const { data } = await octokit.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullNumber,
    body
  })
  return data.id
}

export async function updateComment(
  octokit: any,
  context: PullRequestContext,
  commentId: number,
  body: string
) {
  await octokit.issues.updateComment({
    owner: context.owner,
    repo: context.repo,
    comment_id: commentId,
    body
  })
}
