import { describe, expect, it } from 'bun:test';
import {
  accountDisplayName,
  cyclePeriod,
  deviceCodeInstruction,
  formatUsd,
  lineChart,
  secondwindPercentSaved,
  secondwindSessionSummary,
  secondwindTokenSummary,
  usageRange,
  VIEW_SWITCH_HINT,
} from '../src/dashboard.js';

describe('dashboard usage chart', () => {
  it('renders visible x and y axes with activity points', () => {
    const range = usageRange('day', 0, new Date(2026, 6, 29, 12));
    const chart = lineChart([0, 5, 10], range, { width: 3, height: 3 });
    expect(chart.some(line => line.includes('┤'))).toBe(true);
    expect(chart.some(line => line.includes('└───'))).toBe(true);
    expect(chart.join('\n')).toContain('●');
  });

  it('uses a zero y-axis for an empty range', () => {
    const range = usageRange('month', -1, new Date(2026, 6, 29, 12));
    const chart = lineChart([], range, {
      width: 3,
      height: 3,
      formatY: formatUsd,
    });
    expect(chart[0]).toContain('$0.00');
    expect(chart.join('\n')).not.toContain('$1.00');
  });

  it('navigates calendar day, week, and month ranges', () => {
    const now = new Date(2026, 6, 29, 12);
    expect(usageRange('day', -1, now).start.getDate()).toBe(28);
    expect(usageRange('week', 0, now).start.getDay()).toBe(1);
    expect(usageRange('month', -1, now).start.getMonth()).toBe(5);
    expect(cyclePeriod('day', 1)).toBe('week');
    expect(cyclePeriod('day', -1)).toBe('month');
  });

  it('formats small API-equivalent costs without rounding them away', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(12.345)).toBe('$12.35');
  });
});

describe('dashboard account identity', () => {
  it('uses only the OpenAI email and never a legacy account label', () => {
    expect(accountDisplayName({ email: 'person@example.com' })).toBe('person@example.com');
    expect(accountDisplayName({})).toBe('Email unavailable');
  });
});

describe('dashboard device-code login', () => {
  it('renders the complete device code independently of refresh status', () => {
    expect(deviceCodeInstruction({
      url: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGHI',
    })).toBe('Enter code ABCD-EFGHI in the browser.');
  });
});

describe('dashboard controls', () => {
  it('explicitly tells users to press the numbered view keys', () => {
    expect(VIEW_SWITCH_HINT).toBe('Press 1–5 to switch views');
  });

  it('labels native Secondwind token accounting as measured', () => {
    expect(secondwindTokenSummary({
      requests: 1,
      pricedRequests: 1,
      unpricedRequests: 0,
      blocksRewritten: 1,
      inputTokensConsidered: 1_503,
      tokensReduced: 732,
      estimatedTokenRequests: 0,
      estimatedSavingsUsd: 0.001,
    })).toBe('732 tool-output tokens compacted · measured by Secondwind');
  });

  it('labels compatibility token accounting as estimated', () => {
    expect(secondwindTokenSummary({
      requests: 2,
      pricedRequests: 2,
      unpricedRequests: 0,
      blocksRewritten: 1,
      inputTokensConsidered: 4_000,
      tokensReduced: 1_200,
      estimatedTokenRequests: 1,
      estimatedSavingsUsd: 0.002,
    })).toBe('~1.2K tool-output tokens compacted · 1 fallback estimate');
  });

  it('reports measured input-token reduction as a percentage', () => {
    expect(secondwindPercentSaved({
      inputTokensConsidered: 4_000,
      tokensReduced: 1_000,
    })).toBe('25%');
    expect(secondwindPercentSaved({
      inputTokensConsidered: 0,
      tokensReduced: 0,
    })).toBe('0%');
  });

  it('formats ranked current-daemon session savings', () => {
    expect(secondwindSessionSummary({
      sessionHash: '1234567890abcdef',
      requests: 4,
      pricedRequests: 4,
      unpricedRequests: 0,
      blocksRewritten: 8,
      inputTokensConsidered: 50_000,
      tokensReduced: 12_345,
      estimatedTokenRequests: 0,
      estimatedSavingsUsd: 0.042,
    }, 0)).toBe(
      '1. session 12345678 · 12.3K tokens (24.7% input) · $0.042 estimated savings · 4 req',
    );
  });
});
