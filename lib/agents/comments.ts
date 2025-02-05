/*
<ai_context>
This file contains functions for creating and updating comments on GitHub pull requests.
These functions are used by both the review agent and test generation agent to provide
feedback on pull requests.
</ai_context>
*/

import { octokit } from "./github"

/**
 * Creates an initial placeholder comment on a GitHub pull request.
 * This is typically used to show that an operation (like review or test generation)
 * is in progress, and will be updated later with the final results.
 *
 * @param owner - The GitHub username or organization that owns the repository
 * @param repo - The name of the repository
 * @param pullNumber - The number of the pull request
 * @param placeholderMessage - The initial message to display
 * @returns The ID of the created comment, which can be used later to update it
 */
export async function createPlaceholderComment(
  owner: string,
  repo: string,
  pullNumber: number,
  placeholderMessage: string
): Promise<number> {
  // Create a new comment on the PR (GitHub calls PRs "issues" in the API)
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: placeholderMessage
  })

  // Return the ID of the newly created comment so we can update it later
  return data.id
}

/**
 * Updates an existing comment on a GitHub pull request.
 * This is used to replace the placeholder message with the final results
 * (like the completed review or test generation results).
 *
 * @param owner - The GitHub username or organization that owns the repository
 * @param repo - The name of the repository
 * @param commentId - The ID of the comment to update (returned by createPlaceholderComment)
 * @param body - The new content to replace the comment with
 */
export async function updateComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string
) {
  // Use the GitHub API to update the existing comment
  await octokit.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body
  })
}
