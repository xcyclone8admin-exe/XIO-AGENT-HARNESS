export * from './repository';
export * from './pipeline-engine';
export * from './csv';

import type { AnyCapability, CapabilityBusLike, ModuleManifest, ModuleServer } from '@xyra/contracts';
import { dataCapabilities } from '../contracts';
import type { DataRepository} from './repository';
import { type DataActor } from './repository';

export interface DataCall {
  readonly principal: Pick<DataActor, 'id' | 'tenantId'>;
  readonly workspaceId: string;
}

const actor = (call?: DataCall): DataActor => {
  if (!call) throw new Error('DATA_TRUSTED_CALL_CONTEXT_REQUIRED');
  return { id: call.principal.id, tenantId: call.principal.tenantId, workspaceId: call.workspaceId };
};

export function registerData(bus: CapabilityBusLike, manifest: ModuleManifest, repository: DataRepository): void {
  bus.register(manifest, dataCapabilities.datasetList, (_input, call) => repository.datasets(actor(call as unknown as DataCall)));
  bus.register(manifest, dataCapabilities.datasetCreate, (input, call) => repository.createDataset(actor(call as unknown as DataCall), input));
  bus.register(manifest, dataCapabilities.sheetGet, (input, call) => repository.sheetCells(actor(call as unknown as DataCall), input));
  bus.register(manifest, dataCapabilities.sheetUpsertCells, (input, call) => repository.upsertCells(actor(call as unknown as DataCall), input));
  bus.register(manifest, dataCapabilities.sheetImportCsv, (input, call) => repository.importCsv(actor(call as unknown as DataCall), input));
  bus.register(manifest, dataCapabilities.sheetExportCsv, (input, call) => repository.exportCsv(actor(call as unknown as DataCall), input));
  bus.register(manifest, dataCapabilities.sqlQuery, (input, call) => repository.runSqlQuery(actor(call as unknown as DataCall), input));
  bus.register(manifest, dataCapabilities.pipelineCreate, (input, call) => repository.createPipeline(actor(call as unknown as DataCall), input));
  bus.register(manifest, dataCapabilities.pipelineRun, (input, call) => repository.runPipeline(actor(call as unknown as DataCall), input));
  bus.register(manifest, dataCapabilities.pipelineRunsList, (input, call) => repository.pipelineRuns(actor(call as unknown as DataCall), input));
  bus.register(manifest, dataCapabilities.pipelineCheckpoint, (input, call) => repository.recordCheckpoint(actor(call as unknown as DataCall), input));
  bus.register(manifest, dataCapabilities.pipelineScheduleDescribe, (input, call) => repository.scheduleDescribe(actor(call as unknown as DataCall), input));
  bus.register(manifest, dataCapabilities.lineageGet, (input, call) => repository.lineage(actor(call as unknown as DataCall), input));
}

export function createDataServer(repository: DataRepository): ModuleServer {
  return {
    id: 'data',
    capabilities: Object.values(dataCapabilities) as readonly AnyCapability[],
    register: (bus, manifest) => registerData(bus, manifest, repository),
  };
}

const DataServer: ModuleServer = {
  id: 'data',
  capabilities: Object.values(dataCapabilities) as readonly AnyCapability[],
  register: () => { throw new Error('DATA_SCOPED_REPOSITORY_FACTORY_REQUIRED'); },
};

export default DataServer;
