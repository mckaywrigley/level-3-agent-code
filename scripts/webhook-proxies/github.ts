import dotenv from "dotenv"
import SmeeClient from "smee-client"

// Load environment variables from .env.local file
dotenv.config({ path: ".env.local" })

// Get port from env vars or default to 3000
const PORT = process.env.PORT || 3000

// Get webhook proxy URL from env vars
const WEBHOOK_PROXY_URL = process.env.WEBHOOK_PROXY_URL

// Only start proxy client if webhook URL is configured
if (WEBHOOK_PROXY_URL) {
  // Initialize Smee client to proxy GitHub webhooks
  const smee = new SmeeClient({
    source: WEBHOOK_PROXY_URL, // The Smee.io URL that GitHub will send events to
    target: `http://localhost:${PORT}/api/github-webhook`, // Local endpoint to forward events to
    logger: console // Use console for logging
  })

  // Start the proxy client
  smee.start()
  console.log("Webhook proxy client started")
}
