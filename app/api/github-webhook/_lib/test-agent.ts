import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import { parseStringPromise } from "xml2js"
import { octokit } from "./github"
import { PullRequestContext } from "./handlers"

/**
 * The shape we parse from the XML.
 * We might have a root <testProposals> with multiple <proposal> children.
 */
interface TestProposal {
  filename: string
  testType?: "unit" | "e2e"
  testContent: string
}

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  compatibility: "strict"
})

/**
 * We'll parse the XML we get from the AI.
 * Example structure that we ask the AI to produce:
 *
 * <tests>
 *   <testProposals>
 *     <proposal>
 *       <filename>__tests__/unit/MyUtil.test.ts</filename>
 *       <testType>unit</testType>
 *       <testContent>...</testContent>
 *     </proposal>
 *     <proposal>
 *       ...
 *     </proposal>
 *   </testProposals>
 * </tests>
 */
async function parseTestXml(xmlText: string): Promise<TestProposal[]> {
  try {
    // Try to find <tests> ... </tests>
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

    // The structure might be:
    // {
    //   tests: {
    //     testProposals: [
    //       {
    //         proposal: [
    //           { filename: [..], testType: [..], testContent: [..] },
    //           ...
    //         ]
    //       }
    //     ]
    //   }
    // }
    // We'll gather them up:
    const proposals: TestProposal[] = []
    const root = parsed.tests

    if (!root?.testProposals) {
      console.warn("No <testProposals> found in the parsed XML.")
      return []
    }

    // .testProposals[0].proposal might be an array of proposals
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
        testType: testType === "e2e" ? "e2e" : "unit", // fallback to "unit" if missing
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
 * Takes the changed files, crafts a prompt, and asks for test proposals in XML.
 */
async function generateTestsForChanges(
  changedFiles: PullRequestContext["changedFiles"]
): Promise<TestProposal[]> {
  // The prompt uses XML. No code blocks or extra commentary.
  // Let’s show an example structure for <tests> ... </tests>.
  const prompt = `
You are an expert software developer who specializes in writing tests for a Next.js codebase. 
We have two categories of tests:
1) Unit tests (Jest + Testing Library), typically in \`__tests__/unit/\`.
2) E2E tests (Playwright), typically in \`__tests__/e2e/\`.

Please provide test proposals in the following XML format, with a single root <tests> element and nested <testProposals>. 
For each test file, produce a <proposal> with:
<filename>  e.g. __tests__/unit/MyUtil.test.ts  </filename>
<testType>  either "unit" or "e2e"  </testType>
<testContent> the entire test code, no code blocks. </testContent>

Example XML:
<tests>
  <testProposals>
    <proposal>
      <filename>__tests__/unit/MyUtil.test.ts</filename>
      <testType>unit</testType>
      <testContent>// test code here</testContent>
    </proposal>
    <proposal>
      <filename>__tests__/e2e/SomeFlow.spec.ts</filename>
      <testType>e2e</testType>
      <testContent>// e2e test code here</testContent>
    </proposal>
  </testProposals>
</tests>

For each changed file:
${changedFiles
  .map(
    file => `
File: ${file.filename}
Patch (diff):
${file.patch}
Current Content:
${file.content ?? "N/A"}
`
  )
  .join("\n---\n")}

Return ONLY valid XML (no code blocks, no extra commentary) in the structure above.
`

  try {
    const { text } = await generateText({
      model: openai("gpt-4"),
      prompt
    })

    // Parse the XML
    const proposals = await parseTestXml(text)
    return proposals
  } catch (err) {
    console.error("Error generating tests from AI (v3):", err)
    return []
  }
}

/**
 * commitTestsToExistingBranch:
 * For the open PR, we know the "headRef" from context. We'll push new commits
 * directly to that branch. (No new branch.)
 */
async function commitTestsToExistingBranch(
  owner: string,
  repo: string,
  branchName: string,
  proposals: TestProposal[]
) {
  // 1) Get the latest commit SHA of branchName
  const { data: refData } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${branchName}`
  })
  const latestCommitSha = refData.object.sha

  // 2) For each proposal, create or update the file
  // Because we might place them in unit or e2e folder
  // depending on testType or the filename the AI gave us.
  for (const proposal of proposals) {
    // "filename" might be e.g. "__tests__/unit/MyUtil.test.ts"
    // or maybe the user wants to ensure it's fully path-ed, etc.
    const finalFilename = proposal.filename

    // Convert content to base64
    const contentBase64 = Buffer.from(proposal.testContent, "utf8").toString(
      "base64"
    )

    // "message" can reference the finalFilename
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: finalFilename,
      message: `Add tests: ${finalFilename}`,
      content: contentBase64,
      branch: branchName,
      sha: latestCommitSha // or you can omit sha if you want GitHub to figure out
    })
  }

  // That will effectively create multiple commits or multiple calls in the same commit?
  // Typically each "createOrUpdateFileContents" call commits individually.
  // So you might prefer to do something like create a tree + commit manually if you want a single commit.
}

/**
 * handleTestGeneration (v3):
 * 1) Generate test proposals in XML
 * 2) Commit them to the existing branch (headRef)
 * 3) Post a comment with which files we committed
 */
export async function handleTestGeneration(context: PullRequestContext) {
  const { owner, repo, pullNumber, headRef, changedFiles } = context

  try {
    // 1) Generate test proposals
    const testProposals = await generateTestsForChanges(changedFiles)
    if (testProposals.length === 0) {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: "No test proposals were generated by the AI (v3)."
      })
      return
    }

    // 2) Commit them to the existing PR branch
    await commitTestsToExistingBranch(owner, repo, headRef, testProposals)

    // 3) Post a comment listing the added test files
    const testList = testProposals.map(t => `- **${t.filename}**`).join("\n")
    const body = `### AI Test Generator (v3)
    
Added these new/updated test files to branch \`${headRef}\`:
${testList}

*(You can pull from that branch to see & modify them.)*`

    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body
    })
  } catch (err) {
    console.error("Error in handleTestGeneration (v3):", err)
  }
}
