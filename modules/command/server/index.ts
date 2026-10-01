import type { CapabilityBusLike, CapabilityCallContext, ModuleServer, ModuleManifest } from '@xyra/contracts';
import type { LocalScopedStore } from '@xyra/db';
import { commandCapabilities } from '../contracts';
import { CommandService } from './service';

function scope(call: CapabilityCallContext) {
  return { tenantId: call.principal.tenantId, workspaceId: call.workspaceId };
}

export type ModuleServerFactory = (store: LocalScopedStore) => ModuleServer;

export function makeCommandServer(store: LocalScopedStore): ModuleServer {
  const svc = new CommandService(store);
  return {
    id: 'command',
    capabilities: Object.values(commandCapabilities),
    register(bus: CapabilityBusLike, manifest: ModuleManifest): void {
      const c = commandCapabilities;

      bus.register(manifest, c.dashboard, (_i, call) => svc.dashboardSummary(scope(call)));

      bus.register(manifest, c.chats, (_i, call) => svc.chats(scope(call)));
      bus.register(manifest, c.createChat, (i, call) => {
        const { title } = c.createChat.input.parse(i);
        return svc.createChat(scope(call), call.principal.id, title);
      });
      bus.register(manifest, c.chatMessages, (i, call) => {
        const { chatId } = c.chatMessages.input.parse(i);
        return svc.chatMessages(scope(call), chatId);
      });
      bus.register(manifest, c.sendChatMessage, (i, call) => {
        const { chatId, content } = c.sendChatMessage.input.parse(i);
        return svc.sendChatMessage(scope(call), call.principal.id, chatId, 'user', content);
      });
      // runConductor is consequential and routes to SWARM. Return queued:false until integrated.
      bus.register(manifest, c.runConductor, async () => ({
        queued: false,
        reason: 'agent_runtime_not_connected',
      }));

      bus.register(manifest, c.alerts, (i, call) => {
        const { includeDismissed } = c.alerts.input.parse(i);
        return svc.alerts(scope(call), includeDismissed);
      });
      bus.register(manifest, c.createAlert, (i, call) => {
        const { title, body, severity } = c.createAlert.input.parse(i);
        return svc.createAlert(scope(call), call.principal.id, title, body, severity);
      });
      bus.register(manifest, c.dismissAlert, (i, call) => {
        const { alertId } = c.dismissAlert.input.parse(i);
        return svc.dismissAlert(scope(call), alertId);
      });

      bus.register(manifest, c.actions, (i, call) => {
        const { includeDone } = c.actions.input.parse(i);
        return svc.actions(scope(call), includeDone);
      });
      bus.register(manifest, c.createAction, (i, call) => {
        const { title, body, priority } = c.createAction.input.parse(i);
        return svc.createAction(scope(call), call.principal.id, title, body, priority);
      });
      bus.register(manifest, c.completeAction, (i, call) => {
        const { actionId } = c.completeAction.input.parse(i);
        return svc.completeAction(scope(call), actionId);
      });

      bus.register(manifest, c.blueprintNodes, (_i, call) => svc.blueprintNodes(scope(call)));
      bus.register(manifest, c.blueprintEdges, (_i, call) => svc.blueprintEdges(scope(call)));

      bus.register(manifest, c.doctor, (_i, call) => svc.doctorChecks(scope(call)));
      bus.register(manifest, c.personas, (_i, call) => svc.personas(scope(call)));
    },
  };
}
export default makeCommandServer;
