import dotenv from "dotenv"
import SmeeClient from "smee-client"

dotenv.config({ path: ".env.local" })

const PORT = process.env.PORT || 3000
const WEBHOOK_PROXY_URL = process.env.WEBHOOK_PROXY_URL
if (WEBHOOK_PROXY_URL) {
  const smee = new SmeeClient({
    source: WEBHOOK_PROXY_URL,
    target: `http://localhost:${PORT}/api/github-webhook`,
    logger: console
  })
  smee.start()
  console.log("Webhook proxy client started")
}
