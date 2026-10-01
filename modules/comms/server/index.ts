import type { CapabilityBusLike, CapabilityCallContext, ModuleServer, ModuleManifest } from '@xyra/contracts';
import type { LocalScopedStore } from '@xyra/db';
import { commsCapabilities } from '../contracts';
import { CommsService } from './service';

function scope(call: CapabilityCallContext) {
  return { tenantId: call.principal.tenantId, workspaceId: call.workspaceId };
}

export function makeCommsServer(store: LocalScopedStore): ModuleServer {
  const svc = new CommsService(store);
  return {
    id: 'comms',
    capabilities: Object.values(commsCapabilities),
    register(bus: CapabilityBusLike, manifest: ModuleManifest): void {
      const c = commsCapabilities;

      bus.register(manifest, c.threads, (i, call) => {
        const { status, channel } = c.threads.input.parse(i);
        return svc.threads(scope(call), status, channel);
      });
      bus.register(manifest, c.createThread, (i, call) => {
        const { subject, channel } = c.createThread.input.parse(i);
        return svc.createThread(scope(call), call.principal.id, subject, channel);
      });
      bus.register(manifest, c.snoozeThread, (i, call) => {
        const { threadId, until } = c.snoozeThread.input.parse(i);
        return svc.snoozeThread(scope(call), threadId, until);
      });
      bus.register(manifest, c.doneThread, (i, call) => {
        const { threadId } = c.doneThread.input.parse(i);
        return svc.doneThread(scope(call), threadId);
      });
      bus.register(manifest, c.messages, (i, call) => {
        const { threadId } = c.messages.input.parse(i);
        return svc.messages(scope(call), threadId);
      });
      // sendMessage is consequential; bus verifies the approval before this handler runs.
      // call.approvalId is the bus-verified token — bind it to the message record, not caller input.
      bus.register(manifest, c.sendMessage, async (i, call) => {
        const { threadId, body } = c.sendMessage.input.parse(i);
        const msg = await svc.appendOutboundMessage(scope(call), call.principal.id, threadId, body, call.approvalId);
        return { queued: true, approvalId: msg.send_approval_id ?? null };
      });
      bus.register(manifest, c.events, (i, call) => {
        const { from, to } = c.events.input.parse(i);
        return svc.events(scope(call), from, to);
      });
      bus.register(manifest, c.createEvent, (i, call) => {
        const { title, starts_at, ends_at, location, description } = c.createEvent.input.parse(i);
        return svc.createEvent(scope(call), call.principal.id, title, starts_at, ends_at, location, description);
      });
      bus.register(manifest, c.meetings, (_i, call) => svc.meetings(scope(call)));
    },
  };
}
export default makeCommsServer;
