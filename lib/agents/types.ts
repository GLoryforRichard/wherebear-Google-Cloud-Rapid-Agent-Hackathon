// Event format emitted by both Agent A and Agent B over SSE.
// Each event represents one observable step in the agent's plan,
// so the frontend can render them in the "thinking panel".

export type AgentEventType =
  | 'plan_start'
  | 'tool_call'
  | 'tool_result'
  | 'agent_message'
  | 'cost'
  | 'done'
  | 'error';

export interface AgentEvent {
  type: AgentEventType;
  ts: number;
  // For tool_call / tool_result
  tool?: string;
  args?: unknown;
  result?: unknown;
  // For agent_message / plan_start
  message?: string;
  // For done
  summary?: string;
  data?: unknown;
  // For error
  error?: string;
  // For cost — partial UsageTotals (sums client-side across all events)
  usage?: unknown;
}
