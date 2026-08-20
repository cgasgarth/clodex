import React from 'react';
import { Box, Text, render } from 'ink';
import { SecondwindMetricLine } from '../../src/ui/secondwind-metric-line.js';

const instance = render(
  <Box flexDirection="column">
    <SecondwindMetricLine
      label="Applied"
      metrics={undefined}
      savingsLabel="estimated savings"
    />
    <Text> </Text>
    <SecondwindMetricLine
      label="Shadow potential"
      metrics={undefined}
      savingsLabel="estimated possible savings"
    />
  </Box>,
  { exitOnCtrlC: false, patchConsole: false },
);

instance.unmount();
