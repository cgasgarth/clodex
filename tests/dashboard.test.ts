import { describe, expect, it } from 'vitest';
import { accountDisplayName, sparkline } from '../src/dashboard.js';

describe('dashboard sparkline', () => {
  it('renders idle periods as gaps and activity proportionally', () => {
    expect(sparkline([0, 0, 0], 3)).toBe('···');
    expect(sparkline([0, 5, 10], 3)).toMatch(/^·[▁-█][▁-█]$/);
  });
});

describe('dashboard account identity', () => {
  it('uses only the OpenAI email and never a legacy account label', () => {
    expect(accountDisplayName({ email: 'person@example.com' })).toBe('person@example.com');
    expect(accountDisplayName({})).toBe('Email unavailable');
  });
});
