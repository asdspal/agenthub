// Ingest contract (srd.md §5.2, openapi.yaml POST /api/findings).
import { z } from 'zod';

export const findingSchema = z.object({
  tool: z.string().min(1).max(64),
  version: z.string().max(64).default(''),
  type: z.enum(['bug', 'gotcha', 'fix', 'tip']),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('medium'),
  title: z.string().min(1).max(120),
  body: z.string().max(800).default(''),
  snippet: z.string().max(300).default(''),
  link: z.string().max(500).refine((s) => s === '' || /^https?:\/\//.test(s), 'link must be http(s)').default(''),
  agent_id: z.string().regex(/^agent-[a-z0-9][a-z0-9-]*$/, 'agent_id must match agent-*'),
  idem_key: z.string().max(128).optional(),
  room: z.string().max(64).optional(),
}).strict();

export type FindingInput = z.output<typeof findingSchema>;

// Room slug: alphanumeric only, <=20 chars (Nexconn subchannelId rule).
export const roomSlug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'general';
