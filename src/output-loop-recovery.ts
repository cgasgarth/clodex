import { randomUUID } from 'node:crypto';
import { streamText } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import type { FullStreamPart } from './proxy-shared.js';

const OUTPUT_LOOP_MIN_REPEATED_CHARS = 1_024;
const OUTPUT_LOOP_MIN_REPEATS = 8;
const OUTPUT_LOOP_MAX_PERIOD_CHARS = 512;

const OUTPUT_LOOP_CHECK_INTERVAL_CHARS = 64;
const OUTPUT_LOOP_SAMPLE_SIZES = [
  OUTPUT_LOOP_MIN_REPEATED_CHARS,
  OUTPUT_LOOP_MIN_REPEATED_CHARS * 2,
  OUTPUT_LOOP_MIN_REPEATED_CHARS * 4,
] as const;
const OUTPUT_LOOP_MAX_SAMPLE_CHARS = OUTPUT_LOOP_SAMPLE_SIZES.at(-1)!;

export interface OutputLoopMatch {
  periodChars: number;
  repeatedChars: number;
  repeats: number;
  repeatStart: number;
  safePrefix: string;
}

export interface OutputLoopDiagnostic {
  periodChars: number;
  repeatedChars: number;
  repeats: number;
  recoveryAttempt: number;
}

/** Return the shortest exact period for a string, including a partial final cycle. */
function exactPeriod(text: string): number {
  const prefix = new Uint32Array(text.length);
  for (let index = 1; index < text.length; index += 1) {
    let candidate = prefix[index - 1] ?? 0;
    while (candidate > 0 && text[index] !== text[candidate]) {
      candidate = prefix[candidate - 1] ?? 0;
    }
    if (text[index] === text[candidate]) candidate += 1;
    prefix[index] = candidate;
  }
  return text.length - (prefix[text.length - 1] ?? 0);
}

function repeatedSuffixPeriod(text: string): number | undefined {
  for (const sampleSize of OUTPUT_LOOP_SAMPLE_SIZES) {
    if (text.length < sampleSize) continue;
    const period = exactPeriod(text.slice(-sampleSize));
    if (
      period <= OUTPUT_LOOP_MAX_PERIOD_CHARS
      && Math.floor(sampleSize / period) >= OUTPUT_LOOP_MIN_REPEATS
    ) return period;
  }
  return undefined;
}

/**
 * Detect sustained exact suffix repetition across arbitrary streaming chunks.
 * This deliberately ignores semantic similarity: false positives are kept low
 * by requiring a long exact periodic suffix before recovery starts.
 */
export class StreamingOutputLoopDetector {
  private text = '';
  private uncheckedChars = 0;

  reset(): void {
    this.text = '';
    this.uncheckedChars = 0;
  }

  append(delta: string): OutputLoopMatch | undefined {
    if (!delta) return undefined;
    this.text += delta;
    this.uncheckedChars += delta.length;
    if (
      this.text.length < OUTPUT_LOOP_MIN_REPEATED_CHARS
      || this.uncheckedChars < OUTPUT_LOOP_CHECK_INTERVAL_CHARS
    ) return undefined;
    this.uncheckedChars = 0;

    // Period detection needs only a bounded suffix. The full text is retained
    // so the recovery request can keep all useful output before the loop.
    const bounded = this.text.slice(-OUTPUT_LOOP_MAX_SAMPLE_CHARS);
    const periodChars = repeatedSuffixPeriod(bounded);
    if (periodChars === undefined) return undefined;

    const finalUnit = this.text.slice(-periodChars);
    let repeatStart = this.text.length - periodChars;
    while (
      repeatStart >= periodChars
      && this.text.slice(repeatStart - periodChars, repeatStart) === finalUnit
    ) repeatStart -= periodChars;
    // The stream can end in the middle of the repeated unit. The aligned walk
    // above then leaves that leading fragment attached to the useful prefix.
    // Extend one character at a time to remove the complete periodic suffix.
    while (
      repeatStart > 0
      && repeatStart - 1 + periodChars < this.text.length
      && this.text[repeatStart - 1] === this.text[repeatStart - 1 + periodChars]
    ) repeatStart -= 1;

    const repeatedChars = this.text.length - repeatStart;
    const repeats = Math.floor(repeatedChars / periodChars);
    if (
      repeatedChars < OUTPUT_LOOP_MIN_REPEATED_CHARS
      || repeats < OUTPUT_LOOP_MIN_REPEATS
    ) return undefined;

    return {
      periodChars,
      repeatedChars,
      repeats,
      repeatStart,
      safePrefix: this.text.slice(0, repeatStart).trimEnd(),
    };
  }
}

function outputLoopRecoveryInstruction(nonce: string = randomUUID()): string {
  return [
    `<clodex-output-loop-recovery nonce="${nonce}">`,
    'Your preceding response entered an exact verbatim output loop.',
    'The repeated suffix was removed. Do not continue or restate it.',
    'Continue this same turn from the last useful point and take the next concrete action.',
    'Use the nonce only to change the next-token path. Do not quote or discuss this recovery note.',
    '</clodex-output-loop-recovery>',
  ].join('\n');
}

export function outputLoopRecoveryMessages(
  messages: ModelMessage[],
  safePrefix: string,
  nonce?: string,
): ModelMessage[] {
  return [
    ...messages,
    ...(safePrefix ? [{ role: 'assistant' as const, content: safePrefix }] : []),
    { role: 'user', content: outputLoopRecoveryInstruction(nonce) },
  ];
}

const OUTPUT_LOOP_RECOVERY_FAILED_NOTICE =
  '\n\n[Clodex stopped repetitive Grok output after one automatic recovery attempt.]';

function isToolStreamPart(partType: string): boolean {
  return partType.startsWith('tool-');
}

function hiddenRecoveryProgressPart(): FullStreamPart {
  return { type: 'clodex-recovery-progress' };
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === 'string' ? signal.reason : 'Output-loop recovery aborted',
  );
  error.name = 'AbortError';
  return error;
}

function forwardAbortSignal(source: AbortSignal, target: AbortController): () => void {
  const forward = () => {
    if (!target.signal.aborted) target.abort(source.reason);
  };
  if (source.aborted) {
    forward();
    return () => {};
  }
  source.addEventListener('abort', forward, { once: true });
  return () => source.removeEventListener('abort', forward);
}

interface OutputLoopStreamState {
  attemptText: string;
  currentBlockStart: number;
  sawToolPart: boolean;
}

type OutputLoopPartAction =
  | { kind: 'forward'; part: FullStreamPart }
  | { kind: 'hidden' }
  | {
      kind: 'loop';
      match: OutputLoopMatch;
      safeAssistantText: string;
      safePart: FullStreamPart;
    };

function inspectOutputLoopPart(
  part: FullStreamPart,
  recoveryAttempt: number,
  detector: StreamingOutputLoopDetector,
  state: OutputLoopStreamState,
): OutputLoopPartAction {
  if (isToolStreamPart(part.type)) state.sawToolPart = true;
  if (part.type === 'text-start') {
    state.currentBlockStart = state.attemptText.length;
    detector.reset();
    return recoveryAttempt > 0 ? { kind: 'hidden' } : { kind: 'forward', part };
  }
  if (part.type === 'text-delta') {
    const delta = part.text ?? '';
    const previousLength = state.attemptText.length;
    state.attemptText += delta;
    const match = detector.append(delta);
    if (match) {
      const absoluteRepeatStart = state.currentBlockStart + match.repeatStart;
      const safeDeltaChars = Math.max(
        0,
        Math.min(delta.length, absoluteRepeatStart - previousLength),
      );
      return {
        kind: 'loop',
        match,
        safeAssistantText: state.attemptText.slice(0, absoluteRepeatStart).trimEnd(),
        safePart: safeDeltaChars > 0
          ? { ...part, text: delta.slice(0, safeDeltaChars) }
          : hiddenRecoveryProgressPart(),
      };
    }
  }
  // The retry can reason again, but emitting thinking after the first attempt's
  // text would violate Anthropic block order. Keep hidden progress events alive
  // for timeout tracking; reasoning-end still carries a tool-call signature.
  if (
    recoveryAttempt > 0
    && (part.type === 'reasoning-start' || part.type === 'reasoning-delta')
  ) return { kind: 'hidden' };
  return { kind: 'forward', part };
}

export interface OutputLoopRecoveryStreamOptions {
  nonce?: () => string;
  onDetected?: (event: OutputLoopDiagnostic) => void;
  log?: (message: () => string) => void;
}

/**
 * Replace one exact text loop with a fresh provider request. Both attempts feed
 * one downstream Anthropic message, so Claude Code keeps the current turn.
 */
export async function* streamWithOutputLoopRecovery<
  Params extends { messages: ModelMessage[] },
>(
  model: LanguageModel,
  params: Params,
  abortSignal: AbortSignal,
  streamTextImpl: typeof streamText,
  options: OutputLoopRecoveryStreamOptions = {},
): AsyncIterable<FullStreamPart> {
  let attemptParams = params;
  let recoveryAttempt = 0;

  for (;;) {
    const attemptAbort = new AbortController();
    const stopForwardingAbort = forwardAbortSignal(abortSignal, attemptAbort);
    const detector = new StreamingOutputLoopDetector();
    let loopMatch: OutputLoopMatch | undefined;
    let safeAssistantText = '';
    const state: OutputLoopStreamState = {
      attemptText: '',
      currentBlockStart: 0,
      sawToolPart: false,
    };
    const result = streamTextImpl({
      model,
      ...attemptParams,
      abortSignal: attemptAbort.signal,
      onError: () => {},
    });

    try {
      for await (const part of result.stream as AsyncIterable<FullStreamPart>) {
        if (abortSignal.aborted) throw abortError(abortSignal);
        const action = inspectOutputLoopPart(part, recoveryAttempt, detector, state);
        if (action.kind === 'hidden') {
          yield hiddenRecoveryProgressPart();
          continue;
        }
        if (action.kind === 'loop') {
          loopMatch = action.match;
          safeAssistantText = action.safeAssistantText;
          yield action.safePart;
          const diagnostic: OutputLoopDiagnostic = {
            periodChars: action.match.periodChars,
            repeatedChars: action.match.repeatedChars,
            repeats: action.match.repeats,
            recoveryAttempt,
          };
          options.onDetected?.(diagnostic);
          options.log?.(() =>
            `Grok output loop detected attempt=${recoveryAttempt + 1} `
            + `period_chars=${diagnostic.periodChars} repeated_chars=${diagnostic.repeatedChars}; `
            + (recoveryAttempt === 0 ? 'recovering once' : 'stopping'),
          );
          attemptAbort.abort(new Error('Grok output repetition detected'));
          break;
        }
        yield action.part;
      }
    } catch (error) {
      if (!loopMatch) throw error;
      // The attempt was intentionally aborted after the detector fired.
    } finally {
      stopForwardingAbort();
      if (!attemptAbort.signal.aborted) attemptAbort.abort();
    }

    if (!loopMatch) return;

    // A replay after tool output could create an inconsistent downstream
    // message. Stop safely instead. The common status-text loop is replayable.
    if (recoveryAttempt >= 1 || state.sawToolPart) {
      yield { type: 'text-delta', text: OUTPUT_LOOP_RECOVERY_FAILED_NOTICE };
      yield { type: 'finish', finishReason: 'stop' };
      return;
    }

    yield { type: 'text-delta', text: '\n\n' };
    attemptParams = {
      ...params,
      messages: outputLoopRecoveryMessages(
        params.messages,
        safeAssistantText,
        options.nonce?.(),
      ),
    };
    recoveryAttempt += 1;
  }
}
