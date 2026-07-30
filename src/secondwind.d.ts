declare module 'secondwind' {
  export interface SecondwindSessionOptions {
    proposers?: boolean;
  }

  export interface SecondwindRewriteStats {
    blocks_rewritten?: number;
    blocks_first_seen?: number;
    blocks_kept?: number;
    input_tokens?: number;
    output_tokens?: number;
    tokens_saved?: number;
    transforms?: string[];
  }

  export interface SecondwindRewriteResult {
    request: Record<string, unknown>;
    stats?: SecondwindRewriteStats;
  }

  export class Session {
    constructor(options?: SecondwindSessionOptions);
    rewrite(request: Record<string, unknown>): SecondwindRewriteResult;
    close(): void;
  }
}
