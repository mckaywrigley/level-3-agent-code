import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"
import { Buffer } from "buffer"

/****************************
 * 1) ENV / CREDENTIAL CHECKS
 ****************************/
const { GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_INSTALLATION_ID } =
  process.env

if (!GITHUB_APP_ID || !GITHUB_PRIVATE_KEY || !GITHUB_INSTALLATION_ID) {
  throw new Error(
    "Missing GitHub App environment variables: GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_INSTALLATION_ID."
  )
}

/****************************
 * 2) OCTOKIT / OPENAI CLIENT
 ****************************/
export const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_PRIVATE_KEY,
    installationId: GITHUB_INSTALLATION_ID
  }
})

/*******************************
 * 3) DATA STRUCTURES / HELPERS
 *******************************/
export interface FileChange {
  filename: string
  patch: string
  status: string
  additions: number
  deletions: number
  content?: string // base64-decoded
}

export interface GeneratedTestProposal {
  filename: string
  testContent: string
}

export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string
) {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path, ref })
    if (
      "content" in response.data &&
      typeof response.data.content === "string"
    ) {
      return Buffer.from(response.data.content, "base64").toString("utf8")
    }
    return undefined
  } catch (err: any) {
    if (err.status === 404) {
      console.log(`File ${path} not found at ref ${ref}`)
      return undefined
    }
    throw err
  }
}

/*****************************************************
 * 5) CREATING OR UPDATING TEST FILES VIA OCTOKIT
 * This version simply commits new test files on a new branch
 * and then creates a Pull Request from that branch.
 *****************************************************/
export async function createCommitWithTests(
  owner: string,
  repo: string,
  baseBranch: string,
  newBranchName: string,
  proposals: GeneratedTestProposal[]
) {
  // 1) Get the latest commit SHA of baseBranch
  const { data: refData } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`
  })

  const latestCommitSha = refData.object.sha

  // 2) Create new branch from that commit
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${newBranchName}`,
    sha: latestCommitSha
  })

  // 3) For each test file, create or update it
  for (const proposal of proposals) {
    const path = proposal.filename
    const contentBase64 = Buffer.from(proposal.testContent, "utf8").toString(
      "base64"
    )

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message: `Add test: ${path}`,
      content: contentBase64,
      branch: newBranchName
    })
  }
}
