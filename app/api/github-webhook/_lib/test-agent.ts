import { createOpenAI } from "@ai-sdk/openai"
import { generateObject, generateText } from "ai"
import { parseStringPromise } from "xml2js"
import { z } from "zod"
import { createPlaceholderComment, updateComment } from "./comments"
import { octokit } from "./github"
import { PullRequestContext, PullRequestContextWithTests } from "./handlers"

/**
 * The shape we parse from the AI's XML output for test proposals.
 */
interface TestProposal {
  filename: string
  testType?: "unit" | "e2e"
  testContent: string
}

// Zod schema for gating the decision on test generation
const gatingSchema = z.object({
  decision: z.object({
    shouldGenerateTests: z.boolean(),
    reasoning: z.string()
  })
})

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  compatibility: "strict"
})

const TEST_GENERATION_LABEL = "needs-tests"

/**
 * parseTestXml:
 * Extracts <tests> ... </tests> from the AI output and
 * returns an array of test proposals.
 */
async function parseTestXml(xmlText: string): Promise<TestProposal[]> {
  try {
    const startTag = "<tests>"
    const endTag = "</tests>"
    const startIndex = xmlText.indexOf(startTag)
    const endIndex = xmlText.indexOf(endTag) + endTag.length

    if (startIndex === -1 || endIndex === -1) {
      console.warn("Could not locate <tests> tags in AI output.")
      return []
    }

    const xmlPortion = xmlText.slice(startIndex, endIndex)
    const parsed = await parseStringPromise(xmlPortion)

    // Example structure:
    // {
    //   tests: {
    //     testProposals: [
    //       {
    //         proposal: [
    //           { filename: [...], testType: [...], testContent: [...] },
    //           ...
    //         ]
    //       }
    //     ]
    //   }
    // }
    const proposals: TestProposal[] = []
    const root = parsed.tests

    if (!root?.testProposals) {
      console.warn("No <testProposals> found in the parsed XML.")
      return []
    }

    const testProposalsArr = root.testProposals[0].proposal
    if (!Array.isArray(testProposalsArr)) {
      console.warn("No <proposal> array found under <testProposals>.")
      return []
    }

    for (const item of testProposalsArr) {
      const filename = item.filename?.[0] ?? ""
      const testType = item.testType?.[0] ?? ""
      const testContent = item.testContent?.[0] ?? ""

      if (!filename || !testContent) {
        console.warn(
          "Skipping incomplete proposal (missing filename or testContent)."
        )
        continue
      }

      proposals.push({
        filename,
        testType: testType === "e2e" ? "e2e" : "unit",
        testContent
      })
    }

    return proposals
  } catch (err) {
    console.error("Error parsing AI-generated test XML:", err)
    return []
  }
}

/**
 * generateTestsForChanges:
 * Uses a robust prompt. It includes existing test files so that the model
 * can update them if needed instead of always creating new ones.
 */
async function generateTestsForChanges(
  context: PullRequestContextWithTests
): Promise<TestProposal[]> {
  const { title, changedFiles, commitMessages, existingTestFiles } = context

  // Provide full listing of existing test files + content:
  const existingTestsPrompt = existingTestFiles
    .map(
      f => `
Existing test file: ${f.filename}
---
${f.content}
---
`
    )
    .join("\n")

  const prompt = `
You are an expert software developer specializing in writing tests for a Next.js codebase.
We have two categories of tests:
1) Unit tests (Jest + Testing Library), typically in __tests__/unit/.
2) E2E tests (Playwright), typically in __tests__/e2e/.

We allow updating existing tests or creating new ones. If a file below matches 
the functionality of a changed file, update that existing test instead of 
creating a new one. Return the full final content for every file you modify 
and for every new file you create.

Also note:
- If a React component is a **Server Component** (no "use client" at the top, or it uses server APIs), 
  we must handle it asynchronously in tests. The test function should be \`async\` and the component 
  must be awaited before rendering, e.g.:
  
  \`\`\`ts
  it("renders MyServerComp properly", async () => {
    render(await MyServerComp());
    // assertions...
  });
  \`\`\`
- If the component is a Client Component (explicit "use client" at the top), we can test it normally 
  with synchronous \`render(<MyClientComp />)\`.

Analyze this pull request:
Title: ${title}
Commit Messages:
${commitMessages.map(msg => `- ${msg}`).join("\n")}

Changed Files:
${changedFiles
  .map(
    file => `
File: ${file.filename}
Status: ${file.status}
Patch:
${file.patch}
Current Content:
${file.content ?? "N/A"}
`
  )
  .join("\n---\n")}

Existing Test Files:
${existingTestsPrompt}

Output MUST be valid XML with a single root <tests>. 
Inside it, place <testProposals> containing one or more <proposal>. 
For each <proposal>:
  <filename> (the file path in __tests__/...),
  <testType> (either "unit" or "e2e"),
  <testContent> (the ENTIRE updated or new test file content, no code blocks).

Example:
<tests>
  <testProposals>
    <proposal>
      <filename>__tests__/unit/MyUtil.test.ts</filename>
      <testType>unit</testType>
      <testContent>// entire updated code here</testContent>
    </proposal>
  </testProposals>
</tests>

ONLY return the <tests> XML with proposals. Do not add extra commentary.
`

  try {
    const { text } = await generateText({
      model: openai("o1"),
      prompt
    })

    console.log(
      "\n=== AI Response (Test Generation) ===\n",
      text,
      "\n================\n"
    )

    const proposals = await parseTestXml(text)
    return proposals
  } catch (err) {
    console.error("Error generating tests from AI:", err)
    return []
  }
}

/**
 * commitTestsToExistingBranch:
 * Commits each test proposal to the existing PR branch (headRef).
 * If the file already exists, GitHub will treat this as an update.
 */
async function commitTestsToExistingBranch(
  owner: string,
  repo: string,
  branchName: string,
  proposals: TestProposal[]
) {
  // Get the latest commit SHA
  const { data: refData } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${branchName}`
  })
  const latestCommitSha = refData.object.sha

  // For each proposal, create or update the file
  for (const proposal of proposals) {
    const contentBase64 = Buffer.from(proposal.testContent, "utf8").toString(
      "base64"
    )

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: proposal.filename,
      message: `Add/Update tests: ${proposal.filename}`,
      content: contentBase64,
      branch: branchName,
      sha: latestCommitSha
    })
  }
}

/**
 * Updates the comment with final test generation results.
 */
async function updateCommentWithResults(
  owner: string,
  repo: string,
  commentId: number,
  headRef: string,
  testProposals: TestProposal[]
) {
  const testList = testProposals.map(t => `- **${t.filename}**`).join("\n")
  const body = `### AI Test Generator

${
  testProposals.length > 0
    ? `✅ Added/updated these test files on branch \`${headRef}\`:
${testList}

*(Pull from that branch to see & modify them.)*`
    : `⚠️ No test proposals were generated.`
}`

  await updateComment(owner, repo, commentId, body)
}

/**
 * Uses an LLM to decide if we should generate front-end tests.
 */
async function shouldGenerateFrontendTests(
  changedFiles: PullRequestContext["changedFiles"]
): Promise<{ shouldGenerate: boolean; reason: string }> {
  const changedFilesList = changedFiles.map(cf => `- ${cf.filename}`).join("\n")

  try {
    const result = await generateObject({
      model: openai("o1", { structuredOutputs: true }),
      schema: gatingSchema,
      schemaName: "decision",
      schemaDescription: "A decision about whether to generate front-end tests",
      prompt: `You are an expert developer focusing on Next.js front-end code. 
We only generate tests for front-end related changes (e.g., .tsx files in 'app/' or 'components/', custom React hooks, etc.). 
We do not generate tests for purely backend or config files.

Here is the list of changed files:
${changedFilesList}

Analyze whether any of them warrant front-end tests. Provide a boolean (shouldGenerateTests) and a short reasoning.
`
    })

    return {
      shouldGenerate: result.object.decision.shouldGenerateTests,
      reason: result.object.decision.reasoning
    }
  } catch (err) {
    console.error("Error in gating step for front-end tests:", err)
    return { shouldGenerate: false, reason: "Error in gating check" }
  }
}

/**
 * handleTestGeneration:
 * 1) Creates a placeholder comment
 * 2) Runs gating check
 * 3) If yes, generate or update test proposals
 * 4) Commit to existing PR branch
 * 5) Update comment with results
 * 6) Remove label
 */
export async function handleTestGeneration(
  context: PullRequestContextWithTests
) {
  const { owner, repo, pullNumber, headRef, changedFiles, existingTestFiles } =
    context
  let commentId: number | undefined

  try {
    // 1) Create placeholder comment
    commentId = await createPlaceholderComment(
      owner,
      repo,
      pullNumber,
      "🧪 AI Test Generation in progress..."
    )

    // 2) Decide if we should generate tests
    const { shouldGenerate, reason } =
      await shouldGenerateFrontendTests(changedFiles)
    if (!shouldGenerate) {
      await updateComment(
        owner,
        repo,
        commentId,
        `⏭️ Skipping test generation: ${reason}`
      )
      return
    }

    // 3) Generate test proposals
    const testProposals = await generateTestsForChanges(context)

    // 4) If we have proposals, commit them
    if (testProposals.length > 0) {
      await commitTestsToExistingBranch(owner, repo, headRef, testProposals)
    }

    // 5) Update the comment
    await updateCommentWithResults(
      owner,
      repo,
      commentId,
      headRef,
      testProposals
    )

    // 6) Remove the test label
    try {
      await octokit.issues.removeLabel({
        owner,
        repo,
        issue_number: pullNumber,
        name: TEST_GENERATION_LABEL
      })
    } catch (labelError) {
      console.warn("Failed to remove label:", labelError)
    }
  } catch (err) {
    console.error("Error in handleTestGeneration:", err)
    if (typeof commentId !== "undefined") {
      await updateComment(
        owner,
        repo,
        commentId,
        "❌ Error generating tests. Please check the logs."
      )
    }
  }
}
