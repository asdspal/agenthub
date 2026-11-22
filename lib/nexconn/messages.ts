// Custom message payloads for AgentHub (registered as `agenthub_finding`).

export const FINDING_MESSAGE_TYPE = 'agenthub_finding';

export type FindingType = 'bug' | 'gotcha' | 'fix' | 'tip';
export type Severity = 'low' | 'medium' | 'high' | 'critical' | 'info';
export type FindingStatus = 'open' | 'confirmed' | 'refuted' | 'fixed' | 'duplicate';
export type ReplyKind = 'dedup_merge' | 'escalation';

export interface FindingPayload {
  tool: string;
  version: string;
  type: FindingType;
  severity: Severity;
  title: string;
  body: string;
  snippet: string;
  link: string;
  reply_kind?: ReplyKind;
  idem_key?: string;
  [key: string]: unknown;
}

export interface MessageMetadata {
  finding_root?: string;
  status?: FindingStatus;
  agents_hit?: string;
  supervisor_ids?: string;
  [key: string]: string | undefined;
}
