import { defineCapability } from '@xyra/contracts';
import { z } from 'zod';

const Empty = z.object({});
const Project = z.object({ id: z.uuid(), name: z.string(), description: z.string(),
  status: z.enum(['active','paused','complete']) });
const Task = z.object({ id: z.uuid(), project_id: z.uuid(), title: z.string(),
  description: z.string(), status: z.enum(['todo','doing','blocked','done']),
  assignee_id: z.uuid().nullable(), due_at: z.union([z.date(), z.string()]).nullable() });

export const opsCapabilities = {
  projects: defineCapability({
    id: 'ops.projects.list', title: 'Projects', description: 'List workspace projects',
    kind: 'read', permission: 'ops:project:read', input: Empty, output: z.array(Project),
  }),
  createProject: defineCapability({
    id: 'ops.projects.create', title: 'Create project', description: 'Create a workspace project',
    kind: 'write', permission: 'ops:project:write',
    input: z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(10000).default('') }),
    output: Project,
  }),
  tasks: defineCapability({
    id: 'ops.tasks.list', title: 'Tasks', description: 'List workspace tasks',
    kind: 'read', permission: 'ops:task:read', input: z.object({ projectId: z.uuid().optional() }),
    output: z.array(Task),
  }),
  createTask: defineCapability({
    id: 'ops.tasks.create', title: 'Create task', description: 'Create a task in a project',
    kind: 'write', permission: 'ops:task:write',
    input: z.object({ projectId: z.uuid(), title: z.string().trim().min(1).max(300),
      description: z.string().max(10000).default('') }), output: Task,
  }),
  setTaskStatus: defineCapability({
    id: 'ops.tasks.set-status', title: 'Set task status', description: 'Change a task status',
    kind: 'write', permission: 'ops:task:write',
    input: z.object({ taskId: z.uuid(), status: z.enum(['todo','doing','blocked','done']) }),
    output: Task.nullable(),
  }),
} as const;
