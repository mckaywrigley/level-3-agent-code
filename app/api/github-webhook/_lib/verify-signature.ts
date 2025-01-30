import crypto from "crypto"

/**
 * verifyGitHubSignature:
 *   - The GitHub 'x-hub-signature-256' is "sha256=..."
 *   - We compute an HMAC with your secret, compare to that signature.
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
