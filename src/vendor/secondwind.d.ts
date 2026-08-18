declare module 'secondwind' {
  export type SecondwindValue = string | number | boolean | null | SecondwindValue[] | SecondwindRequest;

  export interface SecondwindRequest {
    [key: string]: SecondwindValue;
  }
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
    request: SecondwindRequest;
    stats?: SecondwindRewriteStats;
  }

  export class Session {
    constructor(options?: SecondwindSessionOptions);
    rewrite(request: SecondwindRequest): SecondwindRewriteResult;
    close(): void;
  }
}
