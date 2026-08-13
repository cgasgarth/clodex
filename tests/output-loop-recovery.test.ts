import { describe, expect, it } from 'bun:test';
import {
  StreamingOutputLoopDetector,
  outputLoopRecoveryMessages,
} from '../src/output-loop-recovery.js';

describe('StreamingOutputLoopDetector', () => {
  it('detects the recover-thought-loop sentence across arbitrary chunks', () => {
    const detector = new StreamingOutputLoopDetector();
    const prefix = 'Six agents are still running. I will wait for their results.\n';
    const repeated = "I'll continue as soon as they finish. ";
    const output = prefix + repeated.repeat(80);
    let match;

    for (let offset = 0; offset < output.length && !match; offset += 37) {
      match = detector.append(output.slice(offset, offset + 37));
    }

    expect(match).toBeDefined();
    expect(match?.periodChars).toBe(repeated.length);
    expect(match?.repeatedChars).toBeGreaterThanOrEqual(1_024);
    expect(match?.repeats).toBeGreaterThanOrEqual(8);
    expect(match?.safePrefix).toBe(prefix.trimEnd());
  });

  it('detects the short extra-token loop from the same Claude session', () => {
    const detector = new StreamingOutputLoopDetector();
    const prefix = "I'll apply the remaining one-line TypeScript change";
    const repeated = ' extra';
    const output = prefix + repeated.repeat(4_100);
    let match;

    // Eleven-character chunks force the six-character period to cross stream
    // boundaries, as it did in the live provider response.
    for (let offset = 0; offset < output.length && !match; offset += 11) {
      match = detector.append(output.slice(offset, offset + 11));
    }

    expect(match).toBeDefined();
    expect(match?.periodChars).toBe(repeated.length);
    expect(match?.repeatedChars).toBeGreaterThanOrEqual(1_024);
    expect(match?.repeatedChars).toBeLessThan(1_100);
    expect(match?.safePrefix).toBe(prefix);
  });

  it('does not flag long non-periodic prose', () => {
    const detector = new StreamingOutputLoopDetector();
    let match;
    for (let index = 0; index < 500; index += 1) {
      match = detector.append(
        `Step ${index} examines file ${index * 17} and records result ${index * 31}.\n`,
      );
      if (match) break;
    }
    expect(match).toBeUndefined();
  });

  it('requires at least eight repeats even when the repeated text exceeds 1 KiB', () => {
    const detector = new StreamingOutputLoopDetector();
    const unit = `A deliberately long repeated paragraph ${'detail '.repeat(18)}#`;
    expect(unit.length).toBeGreaterThan(128);
    expect(detector.append(unit.repeat(7))).toBeUndefined();
  });

  it('resets between independent text blocks', () => {
    const detector = new StreamingOutputLoopDetector();
    const repeated = 'This sentence belongs to one output block. ';
    expect(detector.append(repeated.repeat(15))).toBeUndefined();
    detector.reset();
    expect(detector.append(repeated.repeat(15))).toBeUndefined();
  });
});

describe('outputLoopRecoveryMessages', () => {
  it('keeps the useful prefix and adds a unique hidden recovery turn', () => {
    const messages = outputLoopRecoveryMessages(
      [{ role: 'user', content: 'Finish the task.' }],
      'Useful partial answer.',
      '123e4567-e89b-12d3-a456-426614174000',
    );

    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Useful partial answer.' });
    expect(messages[2]).toMatchObject({ role: 'user' });
    const recovery = String(messages[2]?.content);
    expect(recovery).toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(recovery).toContain('exact verbatim output loop');
    expect(recovery).toContain('Do not continue or restate it');
  });
});
