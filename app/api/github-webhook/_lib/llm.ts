/*
<ai_context>
This file contains the logic for selecting and configuring the LLM (Large Language Model) provider.
It supports both OpenAI and Anthropic's Claude models, with configuration determined by environment variables.
</ai_context>
*/

import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"

/**
 * Creates and returns a configured LLM client based on environment settings.
 * This function handles the logic of choosing between different AI providers
 * and configuring them with the appropriate API keys and models.
 *
 * @returns A configured LLM client (either OpenAI or Anthropic)
 * @throws Error if required API keys are missing
 */
export function getLLMModel() {
  // Read the chosen provider from the environment, defaulting to "openai" if not set
  const provider = process.env.LLM_PROVIDER || "openai"

  // Default model names if none are specified in environment variables
  const openAIDefaultModel = "o1"
  const anthropicDefaultModel = "claude-3-5-sonnet-latest"

  // If the user has specified "anthropic" as provider, we configure Anthropic
  if (provider === "anthropic") {
    // Check for Anthropic API key
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("Missing ANTHROPIC_API_KEY for Anthropic usage.")
    }

    // Create an Anthropic client instance
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    })

    // Return a handle to the desired model, defaulting if not specified
    return anthropic(process.env.LLM_MODEL || anthropicDefaultModel)
  }

  // Otherwise, handle the default or "openai" scenario
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY for OpenAI usage.")
  }

  // Create an OpenAI client instance
  const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    compatibility: "strict" // Strict ensures we adhere to the official API
  })

  // Return the configured OpenAI model
  return openai(process.env.LLM_MODEL || openAIDefaultModel)
}
