import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"
import { Buffer } from "buffer"

const { GH_APP_ID, GH_PRIVATE_KEY, GH_INSTALLATION_ID } = process.env

if (!GH_APP_ID || !GH_PRIVATE_KEY || !GH_INSTALLATION_ID) {
  throw new Error(
    "Missing GitHub App environment variables: GH_APP_ID, GH_PRIVATE_KEY, GH_INSTALLATION_ID."
  )
}

export const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: GH_APP_ID,
    privateKey: GH_PRIVATE_KEY,
    installationId: GH_INSTALLATION_ID
  }
})

/**
 * Retrieve file content from a GitHub repo at a specific ref. Returns decoded string or undefined if not found.
 */
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
