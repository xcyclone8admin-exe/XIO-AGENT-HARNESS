import { coreCapabilities } from '@xyra/mod-core/contracts';
import coreManifest from '@xyra/mod-core/manifest';
import type { CoreService } from '@xyra/mod-core/server';
import { opsCapabilities } from '@xyra/mod-ops/contracts';
import opsManifest from '@xyra/mod-ops/manifest';
import type { OpsService } from '@xyra/mod-ops/server';
import type { CapabilityBus } from './bus';

/** Register the same vetted capability descriptors used by UI and agent catalogs. */
export function registerFoundationCapabilities(bus: CapabilityBus, core: CoreService, ops: OpsService): void {
  const scope = (tenantId: string, workspaceId: string) => ({ tenantId, workspaceId });
  bus.register(coreManifest, coreCapabilities.workspace, (_input, call) =>
    core.workspace(scope(call.principal.tenantId, call.workspaceId)));
  bus.register(coreManifest, coreCapabilities.members, (_input, call) =>
    core.members(scope(call.principal.tenantId, call.workspaceId)));
  bus.register(coreManifest, coreCapabilities.approvals, (_input, call) =>
    core.approvals(scope(call.principal.tenantId, call.workspaceId)));
  bus.register(coreManifest, coreCapabilities.audit, (_input, call) =>
    core.audit(scope(call.principal.tenantId, call.workspaceId)));
  bus.register(coreManifest, coreCapabilities.theme, async (_input, call) => ({
    theme: await core.theme(scope(call.principal.tenantId, call.workspaceId)),
  }));
  bus.register(coreManifest, coreCapabilities.setTheme, async (input, call) => {
    const { theme } = coreCapabilities.setTheme.input.parse(input);
    return { theme: await core.setTheme(scope(call.principal.tenantId, call.workspaceId), theme) };
  });

  bus.register(opsManifest, opsCapabilities.projects, (_input, call) =>
    ops.projects(scope(call.principal.tenantId, call.workspaceId)));
  bus.register(opsManifest, opsCapabilities.tasks, (input, call) => {
    const { projectId } = opsCapabilities.tasks.input.parse(input);
    return ops.tasks(scope(call.principal.tenantId, call.workspaceId), projectId);
  });
  bus.register(opsManifest, opsCapabilities.createProject, (input, call) => {
    const { name, description } = opsCapabilities.createProject.input.parse(input);
    return ops.createProject(scope(call.principal.tenantId, call.workspaceId), call.principal.id, name, description);
  });
  bus.register(opsManifest, opsCapabilities.createTask, (input, call) => {
    const { projectId, title, description } = opsCapabilities.createTask.input.parse(input);
    return ops.createTask(scope(call.principal.tenantId, call.workspaceId), call.principal.id, projectId, title, description);
  });
  bus.register(opsManifest, opsCapabilities.setTaskStatus, (input, call) => {
    const { taskId, status } = opsCapabilities.setTaskStatus.input.parse(input);
    return ops.setTaskStatus(scope(call.principal.tenantId, call.workspaceId), taskId, status);
  });
}
