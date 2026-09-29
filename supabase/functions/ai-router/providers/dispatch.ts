// Shared provider dispatch — the one place that maps an AiProvider name to its adapter call.
// Used by both index.ts's Phase 1 PHASE1_TEST_* path and taskRunner.ts's Task Registry path, so
// neither duplicates the Groq/OpenRouter config or the gemini/groq/openrouter branch.
import { AiCallInput, AiCallSuccess, AiProvider } from '../types.ts';
import { callGemini } from './gemini.ts';
import { callOpenAiCompatible, OpenAiCompatibleConfig } from './openaiCompatible.ts';

const GROQ_CONFIG: OpenAiCompatibleConfig = {
  provider: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
  apiKeyEnvVar: 'GROQ_API_KEY',
  modelEnvVar: 'GROQ_MODEL',
};

const OPENROUTER_CONFIG: OpenAiCompatibleConfig = {
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
  apiKeyEnvVar: 'OPENROUTER_API_KEY',
  modelEnvVar: 'OPENROUTER_MODEL',
};

export function callProvider(provider: AiProvider, input: AiCallInput): Promise<AiCallSuccess> {
  if (provider === 'gemini') return callGemini(input);
  if (provider === 'groq') return callOpenAiCompatible(GROQ_CONFIG, input);
  return callOpenAiCompatible(OPENROUTER_CONFIG, input);
}

// Phase 3: the router needs to know which model a provider is actually configured to use BEFORE
// calling it, to build the 'provider:model' key checked against ai_provider_state (see
// ../providers/cooldown.ts) — something no adapter exposed on its own until now. This simply
// re-reads the same env var each adapter already reads for itself (GEMINI_MODEL/GROQ_MODEL/
// OPENROUTER_MODEL) — a small, acceptable duplication rather than restructuring every adapter to
// also export its own model getter. Returns '' when the env var is unset, same as each adapter's
// own read; callProvider still throws its own clear "not configured" error in that case.
export function resolveProviderModel(provider: AiProvider): string {
  if (provider === 'gemini') return Deno.env.get('GEMINI_MODEL') || '';
  if (provider === 'groq') return Deno.env.get('GROQ_MODEL') || '';
  return Deno.env.get('OPENROUTER_MODEL') || '';
}
