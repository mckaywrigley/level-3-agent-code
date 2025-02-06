import { runFlow } from "@/lib/agents/flow-runner"

runFlow().catch(err => {
  console.error("Error in ai-flow:", err)
  process.exit(1)
})
