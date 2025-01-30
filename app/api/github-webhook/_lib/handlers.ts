import { getFileContent, octokit } from "./github"

export interface PullRequestContext {
  owner: string
  repo: string
  pullNumber: number
  headRef: string
  baseRef: string
  title: string
  changedFiles: {
    filename: string
    patch: string
    status: string
    additions: number
    deletions: number
    content?: string
  }[]
  commitMessages: string[]
}

export interface PullRequestContextWithTests extends PullRequestContext {
  existingTestFiles: {
    filename: string
    content: string
  }[]
}

/**
 * The basic function that collects minimal PR data:
 * - Owner, repo, PR number, branch info
 * - changedFiles with patch + content
 * - commitMessages
 */
export async function handlePullRequestBase(
  payload: any
): Promise<PullRequestContext> {
  const owner = payload.repository.owner.login
  const repo = payload.repository.name
  const pullNumber = payload.pull_request.number
  const headRef = payload.pull_request.head.ref
  const baseRef = payload.pull_request.base.ref
  const title = payload.pull_request.title

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

  // 2) Collect commit messages
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
    title,
    changedFiles,
    commitMessages
  }
}

/**
 * Recursively fetches all files under __tests__/ to build an array of test files with content.
 */
async function getAllTestFiles(
  owner: string,
  repo: string,
  ref: string,
  dirPath = "__tests__"
): Promise<{ filename: string; content: string }[]> {
  const results: { filename: string; content: string }[] = []

  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: dirPath,
      ref
    })

    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.type === "file") {
          const fileContent = await getFileContent(owner, repo, item.path, ref)
          if (fileContent) {
            results.push({
              filename: item.path,
              content: fileContent
            })
          }
        } else if (item.type === "dir") {
          // Recurse into subdir
          const subDirFiles = await getAllTestFiles(owner, repo, ref, item.path)
          results.push(...subDirFiles)
        }
      }
    }
  } catch (err: any) {
    if (err.status === 404) {
      // If the directory doesn't exist, skip
      console.log(`No ${dirPath} folder found, skipping.`)
    } else {
      console.error("Error in getAllTestFiles:", err)
    }
  }

  return results
}

/**
 * Extends the base pull request context with existing test file info.
 * Use this ONLY for test generation, not for code review.
 */
export async function handlePullRequestForTestAgent(
  payload: any
): Promise<PullRequestContextWithTests> {
  // Start with the base context
  const baseContext = await handlePullRequestBase(payload)

  // Gather existing test files
  const existingTestFiles = await getAllTestFiles(
    baseContext.owner,
    baseContext.repo,
    baseContext.headRef
  )

  return {
    ...baseContext,
    existingTestFiles
  }
}
