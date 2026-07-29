import { describe, expect, it } from 'bun:test';
import {
  accountDisplayName,
  cyclePeriod,
  deviceCodeInstruction,
  formatUsd,
  lineChart,
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
    expect(VIEW_SWITCH_HINT).toBe('Press 1–4 to switch views');
  });
});
