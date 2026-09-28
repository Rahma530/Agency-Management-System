// Phase 2: the generic multi-stage task runner. Reads a TaskDefinition (taskRegistry.ts) and
// executes its stages in order — this is the "dispatch code" that a new registry entry should
// never need to change. A task may define any number of stages (one, two, or more) with no
// special-casing here — see taskRegistry.ts's header comment for when a task needs more than one.
// Execution model, exactly as specified: within a stage, its provider order (TaskStageDefinition.
// providers(), possibly more than one fallback) is tried in sequence, moving to the next only on an
// ok:false from the current one — no cooldown memory yet (Phase 3 owns that, against
// ai_provider_state), so a rate-limited provider is retried again on the very next call regardless
// of how recently it failed.
import { callProvider } from './providers/dispatch.ts';
import { AiProviderError, AiProvider, RateLimitHeaders } from './types.ts';
import { DetailLevel, SupportedLanguage, TaskDefinition, TaskStageDefinition } from './taskRegistry.ts';

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

async function runStage(
  stage: TaskStageDefinition,
  inputText: string,
  language: SupportedLanguage,
  detail: DetailLevel
): Promise<StageAttemptResult> {
  // stage.providers() can throw (e.g. CAMPAIGN_SUMMARY_ANALYZE_ORDER set to an invalid value) —
  // caught the same way a provider call's own failure is, so a misconfigured order fails this one
  // stage, not the whole request path.
  let providerOrder: AiProvider[];
  try {
    providerOrder = stage.providers();
  } catch (err) {
    return toFailure(err);
  }

  const systemPrompt = stage.systemPrompt(language, detail);
  const maxOutputTokens = stage.maxOutputTokens(detail);

  let lastFailure: Extract<StageAttemptResult, { ok: false }> | null = null;
  for (let i = 0; i < providerOrder.length; i++) {
    try {
      const result = await callProvider(providerOrder[i], { prompt: inputText, systemPrompt, maxOutputTokens });
      return { ok: true, text: result.text, provider: result.provider, model: result.model, usedFallback: i > 0 };
    } catch (err) {
      // Move to the next provider in the order only after this one returns ok:false (throws) — the
      // last one's failure is what gets reported if every provider in the order is exhausted, since
      // it's the most recent, most relevant signal for why the stage ultimately failed.
      lastFailure = toFailure(err);
    }
  }
  return lastFailure ?? { ok: false, kind: 'error', message: `${stage.name} has no configured providers.` };
}

export async function runRegistryTask(
  task: TaskDefinition,
  rawPayload: unknown,
  language: SupportedLanguage,
  detail: DetailLevel
): Promise<RunTaskResult> {
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
    const outcome = await runStage(stage, inputText, language, detail);

    if (!outcome.ok) {
      return { ok: false, task: task.name, stage: stage.name, ...outcome };
    }
    stages.push({ stage: stage.name, provider: outcome.provider, model: outcome.model, usedFallback: outcome.usedFallback });

    if (stage.outputFormat === 'json') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripCodeFence(outcome.text));
      } catch {
        return {
          ok: false,
          task: task.name,
          stage: stage.name,
          kind: 'error',
          message: `${stage.name} stage produced invalid JSON.`,
        };
      }
      // Applies to whichever provider actually answered — primary or fallback — since a fallback
      // model can just as easily produce syntactically valid but wrongly-shaped JSON. Never passes
      // an unvalidated result on to the next stage or back to the caller.
      if (stage.validateOutput) {
        const validation = stage.validateOutput(parsed, detail);
        if (!validation.ok) {
          return {
            ok: false,
            task: task.name,
            stage: stage.name,
            kind: 'error',
            message: `${stage.name} stage produced output that did not match the expected schema.`,
          };
        }
        currentInput = validation.value;
      } else {
        currentInput = parsed;
      }
    } else {
      currentInput = outcome.text;
    }
  }

  return { ok: true, task: task.name, result: currentInput, stages };
}
