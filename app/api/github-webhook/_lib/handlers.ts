/*
<ai_context>
This file contains functions for handling GitHub webhook events.
It processes pull request data and prepares it for analysis by the AI agents.
</ai_context>
*/

import { getFileContent, octokit } from "./github"

// Size limit for files to be included in the analysis (32KB)
// We exclude files larger than this to avoid token limit issues in the AI
const SIZE_THRESHOLD = 32000

// List of files to always exclude from analysis (like lock files)
const EXCLUDE_PATTERNS = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]

/**
 * Checks if a file should be excluded from analysis based on its filename.
 *
 * @param filename - The name of the file to check
 * @returns true if the file matches the exclude patterns, false otherwise
 */
function shouldExcludeFile(filename: string): boolean {
  return EXCLUDE_PATTERNS.some(pattern => filename.endsWith(pattern))
}

/**
 * Base interface for pull request context.
 * This includes the minimal data needed to run reviews or generate tests.
 */
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
    excluded?: boolean
  }[]
  commitMessages: string[]
}

/**
 * Extended interface that includes information about existing test files
 * Used by the test generation agent.
 */
export interface PullRequestContextWithTests extends PullRequestContext {
  existingTestFiles: {
    filename: string
    content: string
  }[]
}

/**
 * Processes a GitHub webhook payload to extract basic pull request information.
 * This is the core data structure for subsequent AI-based analysis.
 *
 * @param payload - The raw webhook payload from GitHub
 * @returns A structured PullRequestContext object
 */
export async function handlePullRequestBase(
  payload: any
): Promise<PullRequestContext> {
  // Extract meta information about the PR
  const owner = payload.repository.owner.login
  const repo = payload.repository.name
  const pullNumber = payload.pull_request.number
  const headRef = payload.pull_request.head.ref
  const baseRef = payload.pull_request.base.ref
  const title = payload.pull_request.title

  // Fetch the list of files changed in this PR using octokit
  const filesRes = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber
  })

  // Process each changed file
  const changedFiles = await Promise.all(
    filesRes.data.map(async file => {
      const fileObj = {
        filename: file.filename,
        patch: file.patch ?? "",
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        content: undefined as string | undefined,
        excluded: false
      }

      // Only fetch file content if the file wasn't removed and doesn't match exclude patterns
      if (file.status !== "removed" && !shouldExcludeFile(file.filename)) {
        const fileContent = await getFileContent(
          owner,
          repo,
          file.filename,
          headRef
        )

        // Exclude files that exceed the SIZE_THRESHOLD to avoid large embeddings
        if (fileContent && fileContent.length <= SIZE_THRESHOLD) {
          fileObj.content = fileContent
        } else {
          fileObj.excluded = true
        }
      } else {
        // If removed or explicitly excluded by pattern, mark it as excluded
        fileObj.excluded = true
      }

      return fileObj
    })
  )

  // Fetch commit messages in the PR to give the AI more context
  const commitsRes = await octokit.pulls.listCommits({
    owner,
    repo,
    pull_number: pullNumber
  })
  const commitMessages = commitsRes.data.map(c => c.commit.message)

  // Return the final PR context
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
 * Recursively fetches all test files from a repository folder for additional context.
 * This is primarily used by the test agent to see what tests already exist.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param ref - Git reference (branch/commit) to fetch from
 * @param dirPath - Directory path to look in (defaults to "__tests__")
 * @returns Array of {filename, content} for each test file found
 */
async function getAllTestFiles(
  owner: string,
  repo: string,
  ref: string,
  dirPath = "__tests__"
): Promise<{ filename: string; content: string }[]> {
  const results: { filename: string; content: string }[] = []

  try {
    // Attempt to list contents of the given directory
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: dirPath,
      ref
    })

    // If it's an array, it represents a directory listing
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.type === "file") {
          // If it's a file, fetch its content
          const fileContent = await getFileContent(owner, repo, item.path, ref)
          if (fileContent) {
            results.push({
              filename: item.path,
              content: fileContent
            })
          }
        } else if (item.type === "dir") {
          // If it's a directory, recurse into it
          const subDirFiles = await getAllTestFiles(owner, repo, ref, item.path)
          results.push(...subDirFiles)
        }
      }
    }
  } catch (err: any) {
    // If the directory doesn't exist, it's not an error; we just skip
    if (err.status === 404) {
      console.log(`No ${dirPath} folder found, skipping.`)
    } else {
      console.error("Error in getAllTestFiles:", err)
    }
  }

  return results
}

/**
 * Enhanced version of handlePullRequestBase that also fetches existing test files.
 * Useful for the test agent, which needs to know about prior tests.
 *
 * @param payload - The raw webhook payload
 * @returns PullRequestContextWithTests object containing basic PR info + existing tests
 */
export async function handlePullRequestForTestAgent(
  payload: any
): Promise<PullRequestContextWithTests> {
  // Grab the base context
  const baseContext = await handlePullRequestBase(payload)

  // Fetch existing tests from the repo
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

/**
 * Removes a given label from a GitHub issue or pull request.
 * This is typically used after an agent is done working.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param issueNumber - Issue or PR number
 * @param label - The label to remove
 */
export async function removeLabel(
  owner: string,
  repo: string,
  issueNumber: number,
  label: string
) {
  try {
    await octokit.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: label
    })
  } catch (error: any) {
    // If the label doesn't exist, we ignore the 404
    if (error.status !== 404) {
      console.error(`Error removing label ${label}:`, error)
    }
  }
}
