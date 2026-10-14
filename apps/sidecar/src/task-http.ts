import type { Hono, Context } from 'hono';
import { z } from 'zod';
import { ModelConnection, TaskAdmission, TaskApproval, TaskControl, type Principal } from '@xyra/contracts';
import { BusFault } from './bus';
import { taskScope } from './task-store';
import type { TaskService } from './tasks';

async function body(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new BusFault('CONTENT_TYPE_REQUIRED', 415, 'JSON required');
  if (!request.body) throw new BusFault('INVALID_BODY', 400, 'JSON required');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > 100000) { await reader.cancel(); throw new BusFault('BODY_TOO_LARGE', 413, 'Task request too large'); }
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new BusFault('INVALID_JSON', 400, 'Invalid JSON'); }
  } finally { reader.releaseLock(); }
}
const RequestScope = z.strictObject({ workspaceId: z.uuid() });
const AdmissionBody = RequestScope.extend({ input: TaskAdmission });
const ApprovalBody = RequestScope.extend({ input: TaskApproval });
const ControlBody = RequestScope.extend({ input: TaskControl });
const TestBody = RequestScope.extend({ connectionId: z.string().min(1).max(120) });

/** Mounted inside the existing host/origin/launch-token middleware. */
export function registerTaskRoutes(app: Hono, service: TaskService, resolve: () => Promise<Principal>): void {
  app.get('/api/v1/models', async (c) => {
    try {
      const workspaceId = z.uuid().parse(c.req.query('workspaceId'));
      const principal = await resolve();
      return c.json(z.array(ModelConnection).parse(await service.models.list(taskScope(principal, workspaceId))));
    } catch (error) { return fault(c, error); }
  });
  app.post('/api/v1/models/test', async (c) => {
    try {
      const request = TestBody.parse(await body(c.req.raw)); const principal = await resolve();
      return c.json(ModelConnection.parse(await service.models.test(taskScope(principal, request.workspaceId), request.connectionId)));
    } catch (error) { return fault(c, error); }
  });
  app.get('/api/v1/tasks', async (c) => {
    try {
      const workspaceId = z.uuid().parse(c.req.query('workspaceId')); const chatId = z.uuid().parse(c.req.query('chatId'));
      return c.json(await service.list(await resolve(), workspaceId, chatId));
    } catch (error) { return fault(c, error); }
  });
  app.get('/api/v1/tasks/:id', async (c) => {
    try {
      return c.json(await service.get(await resolve(), z.uuid().parse(c.req.query('workspaceId')), z.uuid().parse(c.req.param('id'))));
    } catch (error) { return fault(c, error); }
  });
  app.post('/api/v1/tasks/:operation', async (c) => {
    try {
      const raw = await body(c.req.raw); const principal = await resolve();
      switch (c.req.param('operation')) {
        case 'admit': { const b = AdmissionBody.parse(raw); return c.json(await service.admit(principal, b.workspaceId, b.input), 202); }
        case 'approve': { const b = ApprovalBody.parse(raw); return c.json(await service.approve(principal, b.workspaceId, b.input)); }
        case 'control': { const b = ControlBody.parse(raw); return c.json(await service.control(principal, b.workspaceId, b.input)); }
        default: return c.json({ code: 'TASK_ROUTE_NOT_FOUND' }, 404);
      }
    } catch (error) { return fault(c, error); }
  });
}
function fault(c: Context, error: unknown) {
  if (error instanceof BusFault) return c.json({ code: error.code, detail: error.message }, error.httpStatus as 400);
  if (error instanceof z.ZodError) return c.json({ code: 'INVALID_TASK_REQUEST' }, 400);
  return c.json({ code: 'TASK_SERVICE_UNAVAILABLE' }, 503);
}
