import { createHash } from 'node:crypto';
import { uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope } from '@xyra/db';
import type { ModuleManifest } from '@xyra/contracts';
import { corporateCapabilities } from '../contracts';

type Row=Record<string,unknown>;
export function ownershipTotal(values: readonly number[]): number { return values.reduce((sum,value)=>sum+value,0); }
export function progressBps(baseline: string,target: string,current: string): number {
 const b=BigInt(baseline),t=BigInt(target),c=BigInt(current); if(t===b) return 0;
 const numerator=(c-b)*10000n; const denominator=t-b; const value=numerator/denominator;
 return Number(value<0n?0n:value>10000n?10000n:value);
}
export function dilution(units: readonly {holder_ref:string;units:string}[],newUnits:string) {
 const rows=[...units,{holder_ref:'proposed-issuance',units:newUnits}]; const total=rows.reduce((sum,row)=>sum+BigInt(row.units),0n);
 if(total===0n) return rows.map((row)=>({...row,ownership_bps:0}));
 return rows.map((row)=>({...row,ownership_bps:Number(BigInt(row.units)*10000n/total)}));
}

export class CorporateService {
 constructor(private readonly store:LocalScopedStore){}
 async entities(scope:Scope){return (await this.store.query<Row>(scope,`SELECT id,legal_name,jurisdiction,registration_number,entity_type,parent_entity_id,status FROM corporate_entities WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY legal_name`,[scope.tenantId,scope.workspaceId])).rows;}
 async createEntity(scope:Scope,actorId:string,input:{legalName:string;jurisdiction:string;registrationNumber:string|null;entityType:string;parentEntityId:string|null}){
  const r=await this.store.query<Row>(scope,`INSERT INTO corporate_entities(id,tenant_id,workspace_id,legal_name,jurisdiction,registration_number,entity_type,parent_entity_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,legal_name,jurisdiction,registration_number,entity_type,parent_entity_id,status`,[uuidv7(),scope.tenantId,scope.workspaceId,input.legalName,input.jurisdiction,input.registrationNumber,input.entityType,input.parentEntityId,actorId]); if(!r.rows[0])throw new Error('Entity insert failed');return r.rows[0];
 }
 async setOwnership(scope:Scope,actorId:string,input:{entityId:string;ownerEntityId:string|null;ownerRef:string|null;ownershipBps:number;validFrom:string}){
  const r=await this.store.query<Row>(scope,`WITH inserted AS (INSERT INTO corporate_ownership(id,tenant_id,workspace_id,entity_id,owner_entity_id,owner_ref,ownership_bps,valid_from,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,entity_id,ownership_bps), total AS (SELECT COALESCE(SUM(ownership_bps),0)::integer total_bps FROM corporate_ownership WHERE tenant_id=$2 AND workspace_id=$3 AND entity_id=$4 AND valid_to IS NULL) SELECT inserted.id,inserted.ownership_bps,total.total_bps FROM inserted CROSS JOIN total`,[uuidv7(),scope.tenantId,scope.workspaceId,input.entityId,input.ownerEntityId,input.ownerRef,input.ownershipBps,input.validFrom,actorId]); if(!r.rows[0])throw new Error('Ownership insert failed');return r.rows[0];
 }
 async consolidatedBalances(scope:Scope,entityIds:string[],environment:'actual'|'paper'){
  // Correlations explicitly marked intercompany are removed from the consolidated view. No FX conversion is inferred.
  return (await this.store.query<Row>(scope,`SELECT e.asset,a.code account_code,a.type account_type,SUM(-e.units)::text units FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id AND t.tenant_id=e.tenant_id AND t.workspace_id=e.workspace_id JOIN ledger_books b ON b.id=t.book_id AND b.tenant_id=t.tenant_id AND b.workspace_id=t.workspace_id AND b.owner_module='corporate' JOIN ledger_accounts a ON a.id=e.account_id AND a.book_id=b.id WHERE e.tenant_id=$1 AND e.workspace_id=$2 AND b.subject_id=ANY($3::uuid[]) AND t.environment=$4 AND NOT EXISTS(SELECT 1 FROM corporate_intercompany_links l WHERE l.tenant_id=$1 AND l.workspace_id=$2 AND l.correlation_id=t.correlation_id) GROUP BY e.asset,a.code,a.type ORDER BY e.asset,a.code`,[scope.tenantId,scope.workspaceId,entityIds,environment])).rows;
 }
 async adoptResolution(scope:Scope,actorId:string,resolutionId:string,votes:{votesFor:number;votesAgainst:number;votesAbstain:number}){
  const lock=await this.store.query<Row>(scope,`SELECT r.id,r.title,r.body,m.quorum FROM corporate_resolutions r JOIN corporate_board_meetings m ON m.tenant_id=r.tenant_id AND m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.id=$3 AND r.status='draft'`,[scope.tenantId,scope.workspaceId,resolutionId]);
  const found=lock.rows[0]; if(!found || votes.votesFor+votes.votesAgainst+votes.votesAbstain<Number(found.quorum))return null;
  const approved=votes.votesFor>votes.votesAgainst; const status=approved?'approved':'rejected';
  const contentHash=createHash('sha256').update(JSON.stringify({id:resolutionId,title:found.title,body:found.body,...votes,status})).digest('hex');
  const result=await this.store.query<Row>(scope,`UPDATE corporate_resolutions SET votes_for=$1,votes_against=$2,votes_abstain=$3,status=$4,adopted_at=now(),content_hash=$5 WHERE tenant_id=$6 AND workspace_id=$7 AND id=$8 AND status='draft' RETURNING id,title,status,votes_for,votes_against,votes_abstain,content_hash`,[votes.votesFor,votes.votesAgainst,votes.votesAbstain,status,contentHash,scope.tenantId,scope.workspaceId,resolutionId]); void actorId;return result.rows[0]??null;
 }
 async okrRollup(scope:Scope,objectiveId:string){
  const r=await this.store.query<Row>(scope,`SELECT baseline::text,target::text,current_value::text FROM corporate_key_results WHERE tenant_id=$1 AND workspace_id=$2 AND objective_id=$3 ORDER BY id`,[scope.tenantId,scope.workspaceId,objectiveId]);
  const values=r.rows.map(row=>progressBps(String(row.baseline),String(row.target),String(row.current_value)));
  return {objectiveId,progressBps:values.length?Math.trunc(values.reduce((a,b)=>a+b,0)/values.length):0,keyResultCount:values.length};
 }
 async overdueCompliance(scope:Scope,asOf=new Date().toISOString().slice(0,10)){
  return (await this.store.query<Row>(scope,`SELECT id,title,due_on::text,owner_ref,(CURRENT_DATE-due_on)::integer AS days_overdue FROM corporate_compliance_items WHERE tenant_id=$1 AND workspace_id=$2 AND due_on<$3::date AND status NOT IN ('complete','submitted') ORDER BY due_on`,[scope.tenantId,scope.workspaceId,asOf])).rows;
 }
 async reportingLines(scope:Scope){return (await this.store.query<Row>(scope,`SELECT person_id,manager_id FROM corporate_reporting_lines WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY person_id`,[scope.tenantId,scope.workspaceId])).rows;}
 async setReportingLine(scope:Scope,actorId:string,personId:string,managerId:string){
  const r=await this.store.query<Row>(scope,`WITH RECURSIVE ancestors(id) AS (SELECT $4::uuid UNION ALL SELECT l.manager_id FROM corporate_reporting_lines l JOIN ancestors a ON l.person_id=a.id WHERE l.tenant_id=$1 AND l.workspace_id=$2), inserted AS (INSERT INTO corporate_reporting_lines(id,tenant_id,workspace_id,person_id,manager_id,created_by) SELECT $5,$1,$2,$3,$4,$6 WHERE $3<>$4 AND NOT EXISTS(SELECT 1 FROM ancestors WHERE id=$3) ON CONFLICT(workspace_id,person_id) DO UPDATE SET manager_id=EXCLUDED.manager_id RETURNING person_id,manager_id) SELECT * FROM inserted`,[scope.tenantId,scope.workspaceId,personId,managerId,uuidv7(),actorId]);return r.rows[0]??null;
 }
 async dilution(scope:Scope,shareClassId:string,newUnits:string){const r=await this.store.query<Row>(scope,`SELECT holder_ref,granted_units::text units FROM corporate_equity_grants WHERE tenant_id=$1 AND workspace_id=$2 AND share_class_id=$3 ORDER BY holder_ref,id`,[scope.tenantId,scope.workspaceId,shareClassId]);return dilution(r.rows.map(row=>({holder_ref:String(row.holder_ref),units:String(row.units)})),newUnits);}
 async matchingApprovalPolicies(scope:Scope,capabilityId:string,amountUnits:string,asset:string){return (await this.store.query<Row>(scope,`SELECT id,approver_refs,minimum_approvers FROM corporate_approval_policies WHERE tenant_id=$1 AND workspace_id=$2 AND enabled=true AND (entity_id IS NULL OR entity_id IN (SELECT id FROM corporate_entities WHERE tenant_id=$1 AND workspace_id=$2)) AND $3 LIKE capability_pattern AND (threshold_units IS NULL OR (asset=$4 AND $5::numeric>=threshold_units)) ORDER BY threshold_units NULLS FIRST`,[scope.tenantId,scope.workspaceId,capabilityId,asset,amountUnits])).rows;}
 async audit(scope:Scope,from?:string,to?:string,limit=100){return (await this.store.query<Row>(scope,`SELECT id,actor_id,action,target_type,target_id,detail,occurred_at FROM audit_events WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::timestamptz IS NULL OR occurred_at >= $3) AND ($4::timestamptz IS NULL OR occurred_at <= $4) ORDER BY occurred_at DESC LIMIT $5`,[scope.tenantId,scope.workspaceId,from??null,to??null,limit])).rows;}
}

/** Current sidecar ModuleServer has no DB injection seam; don't advertise unbound handlers. */
const server={id:'corporate',capabilities:Object.values(corporateCapabilities),register(_bus:unknown,_moduleManifest:ModuleManifest):void{}};
export default server;
