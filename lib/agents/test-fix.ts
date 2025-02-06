import { PullRequestContextWithTests } from "./pr-context"
import { handleTestGeneration } from "./test-proposals"

export async function handleTestFix(
  octokit: any,
  context: PullRequestContextWithTests,
  iteration: number,
  testErrorOutput: string,
  testCommentId: number,
  testBody: string
) {
  const fixPrompt = `
We have failing tests (attempt #${iteration}).
Here is the error output:
${testErrorOutput}

Please fix or create new tests as needed, returning JSON in the same format.
`
  await handleTestGeneration(
    octokit,
    context,
    undefined,
    testCommentId,
    testBody + fixPrompt
  )
}
