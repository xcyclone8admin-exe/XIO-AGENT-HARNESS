import { uuidv7 } from '@xyra/core';
import type { ModuleManifest } from '@xyra/contracts';
import type { LocalScopedStore, Scope } from '@xyra/db';
import { decidePolicy, type PolicyRequest } from '@xyra/policy';
import { studioCapabilities } from '../contracts';
import manifest from '../manifest';

const PHASES = ['development','pre-production','production','post','delivery','release'] as const;
type Phase = (typeof PHASES)[number];
type Row = Record<string, unknown>;

/** Canonical base-10 integer arithmetic; money never passes through JS floating point. */
export function exactVariance(planned: string, actual: string, committed: string): { variance: string; estimate: string } {
  const p = BigInt(planned); const a = BigInt(actual); const c = BigInt(committed);
  return { variance: (p-a).toString(), estimate: (a+c).toString() };
}
export function nextPhase(from: Phase, to: Phase): boolean {
  return PHASES.indexOf(to) === PHASES.indexOf(from) + 1;
}

export class StudioService {
  constructor(private readonly store: LocalScopedStore) {}

  async productions(scope: Scope) {
    const r = await this.store.query<Row>(scope, `SELECT id,title,format,phase,owner_id FROM studio_productions WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY created_at DESC`, [scope.tenantId,scope.workspaceId]);
    return r.rows;
  }
  async createProduction(scope: Scope, actorId: string, input: { title:string; format:string; ownerId:string }) {
    const id=uuidv7();
    const r=await this.store.query<Row>(scope, `WITH created AS (INSERT INTO studio_productions(id,tenant_id,workspace_id,title,format,owner_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,title,format,phase,owner_id), history AS (INSERT INTO studio_production_history(id,tenant_id,workspace_id,production_id,from_phase,to_phase,actor_id) SELECT $8,$2,$3,id,NULL,'development',$7 FROM created RETURNING id) SELECT created.* FROM created`,[id,scope.tenantId,scope.workspaceId,input.title,input.format,input.ownerId,actorId,uuidv7()]);
    if(!r.rows[0]) throw new Error('Production insert failed'); return r.rows[0];
  }
  async advanceProduction(scope: Scope, actorId: string, productionId: string, phase: Phase) {
    const current=await this.store.query<Row>(scope,`SELECT phase FROM studio_productions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,[scope.tenantId,scope.workspaceId,productionId]);
    const from=current.rows[0]?.phase as Phase|undefined;
    if(!from || !nextPhase(from,phase)) return null;
    const changed=await this.store.query<Row>(scope,`WITH changed AS (UPDATE studio_productions SET phase=$1,updated_at=now() WHERE tenant_id=$2 AND workspace_id=$3 AND id=$4 AND phase=$5 RETURNING id,title,format,phase,owner_id), history AS (INSERT INTO studio_production_history(id,tenant_id,workspace_id,production_id,from_phase,to_phase,actor_id) SELECT $6,$2,$3,id,$5,$1,$7 FROM changed RETURNING id) SELECT changed.* FROM changed`,[phase,scope.tenantId,scope.workspaceId,productionId,from,uuidv7(),actorId]);
    if(!changed.rows[0]) return null;
    return changed.rows[0];
  }
  async schedule(scope: Scope, productionId?: string) {
    const r=await this.store.query<Row>(scope,`SELECT s.id,s.production_id,s.title,s.kind,s.starts_at,s.ends_at,EXISTS(SELECT 1 FROM studio_schedule_items x WHERE x.tenant_id=s.tenant_id AND x.workspace_id=s.workspace_id AND x.id<>s.id AND x.starts_at<s.ends_at AND x.ends_at>s.starts_at) AS conflict FROM studio_schedule_items s WHERE s.tenant_id=$1 AND s.workspace_id=$2 AND ($3::uuid IS NULL OR s.production_id=$3) ORDER BY s.starts_at`,[scope.tenantId,scope.workspaceId,productionId??null]);
    return r.rows;
  }
  async createScheduleItem(scope: Scope, actorId: string, input: {productionId:string; title:string; kind:string; startsAt:string; endsAt:string}) {
    if(Date.parse(input.endsAt)<=Date.parse(input.startsAt)) throw new Error('Schedule end must follow start');
    const r=await this.store.query<Row>(scope,`INSERT INTO studio_schedule_items(id,tenant_id,workspace_id,production_id,title,kind,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,production_id,title,kind,starts_at,ends_at`,[uuidv7(),scope.tenantId,scope.workspaceId,input.productionId,input.title,input.kind,input.startsAt,input.endsAt,actorId]);
    if(!r.rows[0]) throw new Error('Schedule insert failed'); return r.rows[0];
  }
  async crewConflicts(scope: Scope, personRef: string, startsAt: string, endsAt: string) {
    const r=await this.store.query<Row>(scope,`SELECT id,production_id,role,starts_at,ends_at FROM studio_crew_assignments WHERE tenant_id=$1 AND workspace_id=$2 AND person_ref=$3 AND starts_at<$5 AND ends_at>$4 ORDER BY starts_at`,[scope.tenantId,scope.workspaceId,personRef,startsAt,endsAt]);
    return r.rows;
  }
  async budgetActuals(scope: Scope, productionId: string, environment: 'actual'|'paper') {
    // Studio actuals are sourced from ledger entries. The engine migration is owned by WP-MONEY;
    // absence is surfaced as a storage error and must not be replaced by simulated values.
    const r=await this.store.query<Row>(scope,`SELECT b.id,b.production_id,b.account_code,b.asset,b.planned_units::text,b.committed_units::text,COALESCE(SUM(-e.units),0)::text AS actual_units FROM studio_budget_lines b LEFT JOIN ledger_books lb ON lb.workspace_id=b.workspace_id AND lb.subject_id=b.production_id AND lb.owner_module='studio' LEFT JOIN ledger_accounts la ON la.book_id=lb.id AND la.code=b.account_code LEFT JOIN ledger_entries e ON e.account_id=la.id AND e.environment=$3 AND e.asset=b.asset WHERE b.tenant_id=$1 AND b.workspace_id=$2 AND b.production_id=$4 GROUP BY b.id ORDER BY b.account_code`,[scope.tenantId,scope.workspaceId,environment,productionId]);
    return r.rows.map((row)=>{ const {variance,estimate}=exactVariance(String(row.planned_units),String(row.actual_units),String(row.committed_units)); return {...row,variance_units:variance,estimated_final_units:estimate}; });
  }
  async rights(scope: Scope, productionId?: string, now=new Date()) {
    const r=await this.store.query<Row>(scope,`SELECT id,subject,territory,starts_on::text,expires_on::text,status FROM studio_rights WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::uuid IS NULL OR production_id=$3) ORDER BY expires_on`,[scope.tenantId,scope.workspaceId,productionId??null]);
    return r.rows.map((row)=>{const expires=Date.parse(`${String(row.expires_on)}T00:00:00Z`); const days=Math.ceil((expires-Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()))/86400000); return {...row,expires_in_days:days,alert_due:row.status==='cleared'&&days>=0&&days<=30};});
  }
  async clearDeliverable(scope: Scope, actorId: string, deliverableId: string, approved: boolean, policyRequest: Omit<PolicyRequest,'manifest'|'permission'|'workspaceId'|'kind'|'risk'|'approvalPolicy'>) {
    const decision=decidePolicy({...policyRequest,manifest,workspaceId:scope.workspaceId,permission:'studio:deliverable:write',kind:'write',risk:'high',approvalPolicy:'studio.deliverable.approve'});
    if(decision.status!=='allow') return {decision,result:null};
    const status=approved?'approved':'blocked';
    const r=await this.store.query<Row>(scope,`UPDATE studio_deliverables d SET status=$1 FROM studio_assets a JOIN studio_rights r ON r.tenant_id=a.tenant_id AND r.workspace_id=a.workspace_id AND r.id=a.rights_id WHERE d.tenant_id=$2 AND d.workspace_id=$3 AND d.id=$4 AND d.asset_id=a.id AND r.status='cleared' RETURNING d.id,d.status`,[status,scope.tenantId,scope.workspaceId,deliverableId]);
    if(r.rows[0]) return {decision,result:r.rows[0]};
    await this.store.query<Row>(scope,`UPDATE studio_deliverables SET status='blocked' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,[scope.tenantId,scope.workspaceId,deliverableId]);
    void actorId;
    return {decision,result:{id:deliverableId,status:'blocked'}};
  }
  async ledgerRelationContract() { return { tables:studioCapabilities.ledgerContract.output.parse({tables:['ledger_transactions','ledger_entries'],references:['ledger_books','ledger_accounts']}).tables }; }
}

/**
 * The current sidecar ModuleServer contract has no dependency injection hook for its DB/service.
 * Keep module discovery compatible without registering fake handlers. Wire this server once the
 * platform contract can pass the trusted LocalScopedStore into module registration.
 */
const server = {
  id: 'studio',
  capabilities: Object.values(studioCapabilities),
  register(_bus: unknown, _moduleManifest: ModuleManifest): void {
    // Deliberately no registrations until the sidecar supplies the trusted scoped store.
  },
};

export default server;
