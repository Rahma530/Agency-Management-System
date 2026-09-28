// Phase 2: the generic multi-stage task runner. Reads a TaskDefinition (taskRegistry.ts) and
// executes its stages in order — this is the "dispatch code" that a new registry entry should
// never need to change. Execution model, exactly as specified: sequential stages, each stage tries
// its primary provider, then its declared fallback (if any) only on an ok:false from the primary —
// no cooldown memory yet (Phase 3 owns that, against ai_provider_state), so a rate-limited provider
// is retried again on the very next call regardless of how recently it failed.
import { callProvider } from './providers/dispatch.ts';
import { AiProviderError, AiProvider, RateLimitHeaders } from './types.ts';
import { SupportedLanguage, TaskDefinition, TaskStageDefinition } from './taskRegistry.ts';

export interface StageOutcome {
  stage: string;
  provider: AiProvider;
  model: string;
  usedFallback: boolean;
}

export interface TaskFailure {
  ok: false;
  task: string;
  stage: string;
  kind: 'rate_limit' | 'error';
  reason?: string;
  message: string;
  rateLimitHeaders?: RateLimitHeaders;
  limitSource?: string;
}

export type RunTaskResult =
  | { ok: true; task: string; result: unknown; stages: StageOutcome[] }
  | TaskFailure;

// Models are told never to wrap output in markdown fences (see both system prompts in
// taskRegistry.ts), but a cheap defensive strip of a leading/trailing ``` fence costs nothing and
// guards against the common case of a model doing it anyway.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

type StageAttemptResult =
  | { ok: true; text: string; provider: AiProvider; model: string; usedFallback: boolean }
  | { ok: false; kind: 'rate_limit' | 'error'; reason?: string; message: string; rateLimitHeaders?: RateLimitHeaders; limitSource?: string };

function toFailure(err: unknown): Extract<StageAttemptResult, { ok: false }> {
  if (err instanceof AiProviderError) {
    return { ok: false, kind: err.kind, reason: err.reason, message: err.message, rateLimitHeaders: err.rateLimitHeaders, limitSource: err.limitSource };
  }
  return { ok: false, kind: 'error', message: err instanceof Error ? err.message : String(err) };
}

async function runStage(stage: TaskStageDefinition, inputText: string, language: SupportedLanguage): Promise<StageAttemptResult> {
  const systemPrompt = stage.systemPrompt(language);
  const attempt = (provider: AiProvider) =>
    callProvider(provider, { prompt: inputText, systemPrompt, maxOutputTokens: stage.maxOutputTokens });

  try {
    const result = await attempt(stage.provider);
    return { ok: true, text: result.text, provider: result.provider, model: result.model, usedFallback: false };
  } catch (primaryErr) {
    if (!stage.fallbackProvider) return toFailure(primaryErr);
    try {
      const result = await attempt(stage.fallbackProvider);
      return { ok: true, text: result.text, provider: result.provider, model: result.model, usedFallback: true };
    } catch (fallbackErr) {
      // The fallback's own failure is the one reported — it's the more recent, more relevant
      // signal for why this stage ultimately failed.
      return toFailure(fallbackErr);
    }
  }
}

export async function runRegistryTask(task: TaskDefinition, rawPayload: unknown, language: SupportedLanguage): Promise<RunTaskResult> {
  let currentInput: unknown;
  try {
    currentInput = task.buildInitialInput(rawPayload);
  } catch (err) {
    return {
      ok: false,
      task: task.name,
      stage: task.stages[0]?.name || 'INPUT',
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const stages: StageOutcome[] = [];

  for (const stage of task.stages) {
    const inputText = JSON.stringify(currentInput);
    const outcome = await runStage(stage, inputText, language);

    if (!outcome.ok) {
      return { ok: false, task: task.name, stage: stage.name, ...outcome };
    }
    stages.push({ stage: stage.name, provider: outcome.provider, model: outcome.model, usedFallback: outcome.usedFallback });

    if (stage.outputFormat === 'json') {
      try {
        currentInput = JSON.parse(stripCodeFence(outcome.text));
      } catch {
        return {
          ok: false,
          task: task.name,
          stage: stage.name,
          kind: 'error',
          message: `${stage.name} stage produced invalid JSON.`,
        };
      }
    } else {
      currentInput = outcome.text;
    }
  }

  return { ok: true, task: task.name, result: currentInput, stages };
}
