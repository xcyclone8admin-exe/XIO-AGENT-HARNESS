import {
  CloudBrainIngestionBeginRequest, CloudBrainIngestionBeginResult, CloudBrainIngestionFinalizeRequest,
  CloudBrainIngestionFinalizationReceipt, CloudBrainIngestionStatus,
  type CloudBrainIngestionBeginRequest as BeginRequest,
  type CloudBrainIngestionBeginResult as BeginResult,
  type CloudBrainIngestionFinalizeRequest as FinalizeRequest,
  type CloudBrainIngestionFinalizationReceipt as FinalizationReceipt,
  type CloudBrainIngestionStatus as IngestionStatus,
  type CloudBrainIngestionMode,
} from '@xyra/contracts';

export const BrainIngestionBeginInput = CloudBrainIngestionBeginRequest;
export const BrainIngestionBeginResult = CloudBrainIngestionBeginResult;
export const BrainIngestionFinalizeInput = CloudBrainIngestionFinalizeRequest;
export const BrainIngestionFinalizationReceipt = CloudBrainIngestionFinalizationReceipt;
export const BrainIngestionStatus = CloudBrainIngestionStatus;
export type { CloudBrainIngestionMode };
/** Structural port implemented by the authenticated host SDK adapter. */
export interface CloudBrainIngestionClient {
  begin(input: BeginRequest): Promise<BeginResult>;
  finalize(ingestionId: string, input: FinalizeRequest): Promise<FinalizationReceipt>;
  status(ingestionId: string): Promise<IngestionStatus>;
}
