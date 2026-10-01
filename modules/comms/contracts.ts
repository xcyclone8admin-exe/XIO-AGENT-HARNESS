import { defineCapability } from '@xyra/contracts';
import { z } from 'zod';

const Empty = z.object({});

const ChannelSchema = z.enum(['email', 'slack', 'sms', 'in_app']);
const ThreadStatusSchema = z.enum(['open', 'snoozed', 'done']);
const EventStatusSchema = z.enum(['tentative', 'confirmed', 'cancelled']);

export type Channel = z.infer<typeof ChannelSchema>;
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

const Thread = z.object({
  id: z.uuid(),
  subject: z.string(),
  channel: ChannelSchema,
  status: ThreadStatusSchema,
  participants: z.array(z.unknown()).default([]),
  labels: z.array(z.string()).default([]),
  snoozed_until: z.union([z.date(), z.string()]).nullable(),
  created_at: z.union([z.date(), z.string()]),
});

const Message = z.object({
  id: z.uuid(),
  thread_id: z.uuid(),
  body: z.string(),
  direction: z.enum(['inbound', 'outbound']),
  external_id: z.string().nullable(),
  send_approval_id: z.uuid().nullable(),
  created_at: z.union([z.date(), z.string()]),
});

const Event = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  starts_at: z.union([z.date(), z.string()]),
  ends_at: z.union([z.date(), z.string()]),
  location: z.string().nullable(),
  attendees: z.array(z.unknown()).default([]),
  status: EventStatusSchema,
});

const Meeting = z.object({
  id: z.uuid(),
  title: z.string(),
  event_id: z.uuid().nullable(),
  summary: z.string().nullable(),
  action_items: z.array(z.unknown()).default([]),
  recording_url: z.string().nullable(),
  created_at: z.union([z.date(), z.string()]),
});

export const commsCapabilities = {
  threads: defineCapability({
    id: 'comms.threads.list',
    title: 'List threads',
    description: 'List inbox threads',
    kind: 'read',
    permission: 'comms:thread:read',
    input: z.object({ status: ThreadStatusSchema.optional(), channel: ChannelSchema.optional() }),
    output: z.array(Thread),
  }),

  createThread: defineCapability({
    id: 'comms.threads.create',
    title: 'Create thread',
    description: 'Create a new inbox thread',
    kind: 'write',
    permission: 'comms:thread:write',
    input: z.object({
      subject: z.string().trim().min(1).max(500),
      channel: ChannelSchema,
    }),
    output: Thread,
  }),

  snoozeThread: defineCapability({
    id: 'comms.threads.snooze',
    title: 'Snooze thread',
    description: 'Snooze a thread until a given time',
    kind: 'write',
    permission: 'comms:thread:write',
    input: z.object({ threadId: z.uuid(), until: z.string().datetime() }),
    output: Thread.nullable(),
  }),

  doneThread: defineCapability({
    id: 'comms.threads.done',
    title: 'Mark thread done',
    description: 'Mark a thread as done',
    kind: 'write',
    permission: 'comms:thread:write',
    input: z.object({ threadId: z.uuid() }),
    output: Thread.nullable(),
  }),

  messages: defineCapability({
    id: 'comms.messages.list',
    title: 'List messages',
    description: 'List messages in a thread',
    kind: 'read',
    permission: 'comms:thread:read',
    input: z.object({ threadId: z.uuid() }),
    output: z.array(Message),
  }),

  sendMessage: defineCapability({
    id: 'comms.messages.send',
    title: 'Send message',
    description: 'Queue an outbound message for send (requires approval)',
    kind: 'consequential',
    permission: 'comms:thread:send',
    risk: 'high',
    approvalPolicy: 'comms.message.send',
    input: z.object({
      threadId: z.uuid(),
      body: z.string().trim().min(1).max(50000),
    }),
    output: z.object({ queued: z.boolean(), approvalId: z.uuid().nullable() }),
  }),

  events: defineCapability({
    id: 'comms.events.list',
    title: 'List events',
    description: 'List calendar events',
    kind: 'read',
    permission: 'comms:event:read',
    input: z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }),
    output: z.array(Event),
  }),

  createEvent: defineCapability({
    id: 'comms.events.create',
    title: 'Create event',
    description: 'Create a calendar event',
    kind: 'write',
    permission: 'comms:event:write',
    input: z.object({
      title: z.string().trim().min(1).max(300),
      starts_at: z.string().datetime(),
      ends_at: z.string().datetime(),
      location: z.string().max(500).optional(),
      description: z.string().max(5000).optional(),
    }),
    output: Event,
  }),

  meetings: defineCapability({
    id: 'comms.meetings.list',
    title: 'List meetings',
    description: 'List meeting records with recordings and follow-ups',
    kind: 'read',
    permission: 'comms:meeting:read',
    input: Empty,
    output: z.array(Meeting),
  }),
} as const;
