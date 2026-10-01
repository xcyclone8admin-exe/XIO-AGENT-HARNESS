import { defineCapability } from '@xyra/contracts';
import { z } from 'zod';

const Empty = z.object({});

const ChatStatusSchema = z.enum(['active', 'archived']);
const AlertSeveritySchema = z.enum(['info', 'warning', 'critical']);
const ActionPrioritySchema = z.enum(['low', 'normal', 'high']);
const BlueprintNodeKindSchema = z.enum([
  'operator',
  'agent',
  'department',
  'connector',
  'store',
  'page',
  'daemon',
  'model',
  'skill',
]);

export type ChatStatus = z.infer<typeof ChatStatusSchema>;
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;
export type ActionPriority = z.infer<typeof ActionPrioritySchema>;
export type BlueprintNodeKind = z.infer<typeof BlueprintNodeKindSchema>;

const Chat = z.object({
  id: z.uuid(),
  title: z.string(),
  agent_id: z.string().nullable(),
  status: ChatStatusSchema,
  created_at: z.union([z.date(), z.string()]),
});

const ChatMessage = z.object({
  id: z.uuid(),
  chat_id: z.uuid(),
  role: z.enum(['user', 'agent', 'system']),
  content: z.string(),
  created_at: z.union([z.date(), z.string()]),
});

const Alert = z.object({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  severity: AlertSeveritySchema,
  dismissed_at: z.union([z.date(), z.string()]).nullable(),
  created_at: z.union([z.date(), z.string()]),
});

const Action = z.object({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  priority: ActionPrioritySchema,
  done_at: z.union([z.date(), z.string()]).nullable(),
  dismissed_at: z.union([z.date(), z.string()]).nullable(),
  created_at: z.union([z.date(), z.string()]),
});

const BlueprintNode = z.object({
  id: z.uuid(),
  label: z.string(),
  kind: BlueprintNodeKindSchema,
  x: z.number(),
  y: z.number(),
  meta: z.record(z.string(), z.unknown()).default({}),
});

const BlueprintEdge = z.object({
  id: z.uuid(),
  source_id: z.uuid(),
  target_id: z.uuid(),
  label: z.string().nullable(),
});

const Persona = z.object({
  id: z.uuid(),
  title: z.string(),
  summary: z.string(),
  north_star_metric: z.string().nullable(),
  pillars: z.array(z.string()).default([]),
});

const DashboardSummary = z.object({
  greeting: z.string(),
  systems_live: z.number().int(),
  systems_total: z.number().int(),
  agents_live: z.number().int(),
  agents_total: z.number().int(),
  pending_approvals: z.number().int(),
  unread_alerts: z.number().int(),
});

const DoctorCheck = z.object({
  id: z.uuid(),
  check_id: z.string(),
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  detail: z.string(),
  created_at: z.union([z.date(), z.string()]),
});

export const commandCapabilities = {
  dashboard: defineCapability({
    id: 'command.dashboard.summary',
    title: 'Dashboard summary',
    description: 'Read the command-center dashboard summary',
    kind: 'read',
    permission: 'command:dashboard:read',
    input: Empty,
    output: DashboardSummary,
  }),

  chats: defineCapability({
    id: 'command.chats.list',
    title: 'List chats',
    description: 'List chat threads in the workspace',
    kind: 'read',
    permission: 'command:chat:read',
    input: Empty,
    output: z.array(Chat),
  }),
  createChat: defineCapability({
    id: 'command.chats.create',
    title: 'Create chat',
    description: 'Create a new chat thread',
    kind: 'write',
    permission: 'command:chat:write',
    input: z.object({ title: z.string().trim().min(1).max(200) }),
    output: Chat,
  }),
  chatMessages: defineCapability({
    id: 'command.chats.messages',
    title: 'Chat messages',
    description: 'List messages in a chat thread',
    kind: 'read',
    permission: 'command:chat:read',
    input: z.object({ chatId: z.uuid() }),
    output: z.array(ChatMessage),
  }),
  sendChatMessage: defineCapability({
    id: 'command.chats.send',
    title: 'Send chat message',
    description: 'Send a message to a chat thread',
    kind: 'write',
    permission: 'command:chat:write',
    input: z.object({ chatId: z.uuid(), content: z.string().trim().min(1).max(10000) }),
    output: ChatMessage,
  }),
  runConductor: defineCapability({
    id: 'command.chats.conductor.run',
    title: 'Run Conductor',
    description: 'Route a user message to the agent runtime via Conductor',
    kind: 'consequential',
    permission: 'command:chat:write',
    risk: 'high',
    approvalPolicy: 'command.conductor.run',
    input: z.object({ chatId: z.uuid(), content: z.string().trim().min(1).max(10000) }),
    output: z.object({ queued: z.boolean(), reason: z.string() }),
  }),

  alerts: defineCapability({
    id: 'command.alerts.list',
    title: 'List alerts',
    description: 'List workspace alerts',
    kind: 'read',
    permission: 'command:alert:read',
    input: z.object({ includeDismissed: z.boolean().default(false) }),
    output: z.array(Alert),
  }),
  createAlert: defineCapability({
    id: 'command.alerts.create',
    title: 'Create alert',
    description: 'Create a workspace alert',
    kind: 'write',
    permission: 'command:alert:write',
    input: z.object({
      title: z.string().trim().min(1).max(200),
      body: z.string().max(2000).default(''),
      severity: AlertSeveritySchema.default('info'),
    }),
    output: Alert,
  }),
  dismissAlert: defineCapability({
    id: 'command.alerts.dismiss',
    title: 'Dismiss alert',
    description: 'Dismiss a workspace alert',
    kind: 'write',
    permission: 'command:alert:write',
    input: z.object({ alertId: z.uuid() }),
    output: Alert.nullable(),
  }),

  actions: defineCapability({
    id: 'command.actions.list',
    title: 'List actions',
    description: 'List next-best actions',
    kind: 'read',
    permission: 'command:action:read',
    input: z.object({ includeDone: z.boolean().default(false) }),
    output: z.array(Action),
  }),
  createAction: defineCapability({
    id: 'command.actions.create',
    title: 'Create action',
    description: 'Create a next-best action',
    kind: 'write',
    permission: 'command:action:write',
    input: z.object({
      title: z.string().trim().min(1).max(200),
      body: z.string().max(2000).default(''),
      priority: ActionPrioritySchema.default('normal'),
    }),
    output: Action,
  }),
  completeAction: defineCapability({
    id: 'command.actions.complete',
    title: 'Complete action',
    description: 'Mark a next-best action as done',
    kind: 'write',
    permission: 'command:action:write',
    input: z.object({ actionId: z.uuid() }),
    output: Action.nullable(),
  }),

  blueprintNodes: defineCapability({
    id: 'command.blueprint.nodes',
    title: 'Blueprint nodes',
    description: 'List system blueprint nodes',
    kind: 'read',
    permission: 'command:blueprint:read',
    input: Empty,
    output: z.array(BlueprintNode),
  }),
  blueprintEdges: defineCapability({
    id: 'command.blueprint.edges',
    title: 'Blueprint edges',
    description: 'List system blueprint edges',
    kind: 'read',
    permission: 'command:blueprint:read',
    input: Empty,
    output: z.array(BlueprintEdge),
  }),

  doctor: defineCapability({
    id: 'command.doctor.checks',
    title: 'Doctor checks',
    description: 'Run diagnostic checks',
    kind: 'read',
    permission: 'command:doctor:read',
    input: Empty,
    output: z.array(DoctorCheck),
  }),

  personas: defineCapability({
    id: 'command.personas.list',
    title: 'List personas',
    description: 'List business persona templates',
    kind: 'read',
    permission: 'command:persona:read',
    input: Empty,
    output: z.array(Persona),
  }),
} as const;
