export type ShellTraceCall = {
  id: string;
  command: string | null;
  result: string | null;
};

export type ExecutionStep = {
  id: string;
  at: string;
  number: number;
  workerSlot: number;
  tools: string[];
  tokens: number;
  shellCallCount: number;
};

export type ExecutionTracePage = {
  steps: ExecutionStep[];
  nextBefore: number | null;
};
