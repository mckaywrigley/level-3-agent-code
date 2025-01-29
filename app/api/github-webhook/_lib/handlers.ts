import { getFileContent, octokit } from "./github"

/**
 * Basic shape for the pull request context that we feed
 * into each of our AI "agent" functions (review, test gen, etc.)
 */
export interface PullRequestContext {
  owner: string
  repo: string
  pullNumber: number
  headRef: string
  baseRef: string
  changedFiles: {
    filename: string
    patch: string
    status: string
    additions: number
    deletions: number
    content?: string
  }[]
  commitMessages: string[] // <--- We also collect commit messages for the code review agent
}

/**
 * handlePullRequest:
 * Gathers all relevant data from the PR, such as changed files and commit messages,
 * and returns that info in a structured object (PullRequestContext).
 */
export async function handlePullRequest(
  payload: any
): Promise<PullRequestContext> {
  const owner = payload.repository.owner.login
  const repo = payload.repository.name
  const pullNumber = payload.pull_request.number
  const headRef = payload.pull_request.head.ref
  const baseRef = payload.pull_request.base.ref

  // 1) List changed files
  const filesRes = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber
  })

  const changedFiles = await Promise.all(
    filesRes.data.map(async file => {
      let content: string | undefined
      if (file.status !== "removed") {
        content = await getFileContent(owner, repo, file.filename, headRef)
      }
      return {
        filename: file.filename,
        patch: file.patch ?? "",
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        content
      }
    })
  )

  // 2) Also collect commit messages
  const commitsRes = await octokit.pulls.listCommits({
    owner,
    repo,
    pull_number: pullNumber
  })
  const commitMessages = commitsRes.data.map(c => c.commit.message)

  return {
    owner,
    repo,
    pullNumber,
    headRef,
    baseRef,
    changedFiles,
    commitMessages
  }
}
