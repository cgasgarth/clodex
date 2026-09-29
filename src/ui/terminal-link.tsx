import React from 'react';
import { Text } from 'ink';
import { link } from 'ansi-escapes';

export function TerminalLink({ href, children }: { href: string; children: string }): React.ReactNode {
  return <Text color="cyan" underline>{link(children, href)}</Text>;
}
