import crypto from "crypto"

/**
 * verifyGitHubSignature:
 * Checks the X-Hub-Signature-256 header from GitHub to ensure the payload is valid.
 */
export function verifyGitHubSignature(
  rawBody: string,
  secret: string,
  signature: string
): boolean {
  // signature is typically: "sha256=hexstuff"
  const [algo, rawSig] = signature.split("=")
  if (algo !== "sha256" || !rawSig) return false

  const hmac = crypto.createHmac("sha256", secret)
  hmac.update(rawBody, "utf-8")
  const expected = hmac.digest("hex")

  // Use timingSafeEqual to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(rawSig, "hex"),
      Buffer.from(expected, "hex")
    )
  } catch {
    return false
  }
}
