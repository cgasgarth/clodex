import React from 'react';
import { Box, Text } from 'ink';
import type { SecondwindModeMetrics } from '../daemon/secondwind.js';
import {
  compactNumber,
  formatUsd,
  secondwindPercentSaved,
  secondwindTokenSummary,
} from './dashboard-data.js';

export function SecondwindMetricLine({
  label,
  metrics,
  savingsLabel,
}: {
  label: string;
  metrics: SecondwindModeMetrics | undefined;
  savingsLabel: string;
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>
      <Text>
        {metrics?.requests ?? 0} requests · {metrics?.blocksRewritten ?? 0} blocks rewritten
      </Text>
      <Text>
        {secondwindTokenSummary(metrics)}
        {' · '}{secondwindPercentSaved(metrics)} of tool-output tokens saved
        {' · '}{savingsLabel} {formatUsd(metrics?.estimatedSavingsUsd ?? 0)}
      </Text>
      {((metrics?.savedInputTokens ?? 0)
        + (metrics?.savedCachedInputTokens ?? 0)
        + (metrics?.savedCacheWriteTokens ?? 0)) > 0 && (
        <Text dimColor>
          saved attribution: {compactNumber(metrics?.savedInputTokens ?? 0)} uncached
          {' / '}{compactNumber(metrics?.savedCachedInputTokens ?? 0)} cache reads
          {' / '}{compactNumber(metrics?.savedCacheWriteTokens ?? 0)} cache writes
        </Text>
      )}
      {((metrics?.estimatedInputSavingsUsd ?? 0)
        + (metrics?.estimatedCacheSavingsUsd ?? 0)
        + (metrics?.estimatedOutputSavingsUsd ?? 0)) > 0 && (
        <Text dimColor>
          estimated dollars: {formatUsd(metrics?.estimatedInputSavingsUsd ?? 0)} input
          {' + '}{formatUsd(metrics?.estimatedCacheSavingsUsd ?? 0)} cache
          {' + '}{formatUsd(metrics?.estimatedOutputSavingsUsd ?? 0)} output threshold
        </Text>
      )}
      {(metrics?.unpricedRequests ?? 0) > 0 && (
        <Text dimColor>{metrics!.unpricedRequests} unsupported-model requests excluded from dollars</Text>
      )}
    </Box>
  );
}
