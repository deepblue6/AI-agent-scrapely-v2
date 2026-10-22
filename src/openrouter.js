/**
 * Claude via OpenRouter, with retry + model fallback
 */

const RETRY_CONFIG = [
  { model: "anthropic/claude-sonnet-4.6", delay: 0 },
  { model: "anthropic/claude-haiku-4.5", delay: 2000 },
  { model: "anthropic/claude-haiku-4.5", delay: 5000 },
];

/**
 * Call Claude through OpenRouter
 * @param {string} apiKey - OpenRouter API key
 * @param {Array} messages - Array of {role, content} messages
 * @param {Object} options - { system, maxTokens, temperature }
 * @returns {string|null} - Reply text or null on failure
 */
export async function callClaude(apiKey, messages, options = {}) {
  const { system, maxTokens = 300, temperature = 0.45 } = options;

  for (let attempt = 0; attempt < RETRY_CONFIG.length; attempt++) {
    const { model, delay } = RETRY_CONFIG[attempt];

    if (delay > 0) {
      console.log(`[LLM] Waiting ${delay / 1000}s before retry (attempt ${attempt + 1})...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Scrapely AI Setter",
        },
        body: JSON.stringify({
          model,
          messages: system ? [{ role: "system", content: system }, ...messages] : messages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[LLM] API error (attempt ${attempt + 1}, ${model}): ${response.status} ${errorText}`);

        // Human-readable hints for common errors
        if (response.status === 401) {
          console.error(`[LLM] ⚠️  Your OPENROUTER_API_KEY is invalid or expired. Double-check it at https://openrouter.ai/settings/keys`);
        } else if (response.status === 402) {
          console.error(`[LLM] ⚠️  Your OpenRouter account is out of credits. Add some at https://openrouter.ai/settings/credits`);
        } else if (response.status === 429) {
          console.error(`[LLM] ⚠️  Rate limited — too many requests. The agent will retry automatically.`);
        } else if (response.status >= 500) {
          console.error(`[LLM] ⚠️  The model provider is temporarily unavailable. The agent will retry automatically.`);
        }

        if (attempt === RETRY_CONFIG.length - 1) return null;
        continue;
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) {
        console.error(`[LLM] Empty response (attempt ${attempt + 1})${data?.error ? `: ${JSON.stringify(data.error)}` : ""}`);
        if (attempt === RETRY_CONFIG.length - 1) return null;
        continue;
      }

      if (attempt > 0) console.log(`[LLM] Success on attempt ${attempt + 1} with ${model}`);
      return text;
    } catch (error) {
      console.error(`[LLM] Request failed (attempt ${attempt + 1}, ${model}): ${error.message}`);
      if (attempt === RETRY_CONFIG.length - 1) return null;
    }
  }

  return null;
}

export default callClaude;
