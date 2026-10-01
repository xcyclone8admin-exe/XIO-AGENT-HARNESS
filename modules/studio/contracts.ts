import { defineCapability } from '@xyra/contracts';
import { LEDGER_TABLES, LEDGER_REFERENCE_KEYS } from '@xyra/ledger';
import { z } from 'zod';

const Uuid = z.uuid();
const Production = z.object({ id: Uuid, title: z.string(), format: z.enum(['film','video','content','campaign']), phase: z.enum(['development','pre-production','production','post','delivery','release']), owner_id: Uuid });
const ScheduleItem = z.object({ id: Uuid, production_id: Uuid, title: z.string(), kind: z.enum(['phase','shoot_day','milestone']), starts_at: z.union([z.date(),z.string()]), ends_at: z.union([z.date(),z.string()]) });
const BudgetLine = z.object({ id: Uuid, production_id: Uuid, account_code: z.string(), asset: z.string(), planned_units: z.string(), committed_units: z.string(), actual_units: z.string(), variance_units: z.string(), estimated_final_units: z.string() });
const Rights = z.object({ id: Uuid, subject: z.string(), territory: z.string(), starts_on: z.string(), expires_on: z.string(), status: z.enum(['pending','cleared','restricted','expired']) });

export const studioCapabilities = {
  slate: defineCapability({ id:'studio.production.list', title:'Production slate', description:'List productions in the active workspace', kind:'read', permission:'studio:production:read', input:z.object({}), output:z.array(Production) }),
  createProduction: defineCapability({ id:'studio.production.create', title:'Create production', description:'Create a production in development', kind:'write', permission:'studio:production:write', input:z.object({title:z.string().trim().min(1).max(200),format:z.enum(['film','video','content','campaign']),ownerId:Uuid}), output:Production }),
  advanceProduction: defineCapability({ id:'studio.production.advance', title:'Advance production', description:'Advance a production to its next phase and record history', kind:'write', permission:'studio:production:write', input:z.object({productionId:Uuid,phase:z.enum(['development','pre-production','production','post','delivery','release'])}), output:Production.nullable() }),
  schedule: defineCapability({ id:'studio.schedule.list', title:'Production schedule', description:'List schedule items and flag time overlaps', kind:'read', permission:'studio:schedule:read', input:z.object({productionId:Uuid.optional()}), output:z.array(ScheduleItem.extend({conflict:z.boolean()})) }),
  addScheduleItem: defineCapability({ id:'studio.schedule.create', title:'Schedule item', description:'Create a production phase, shoot day or milestone', kind:'write', permission:'studio:schedule:write', input:z.object({productionId:Uuid,title:z.string().trim().min(1).max(200),kind:z.enum(['phase','shoot_day','milestone']),startsAt:z.iso.datetime({offset:true}),endsAt:z.iso.datetime({offset:true})}), output:ScheduleItem }),
  budgetActuals: defineCapability({ id:'studio.budget.actuals', title:'Budget actuals', description:'Compare plans with exact ledger transaction entry units', kind:'read', permission:'studio:budget:read', input:z.object({productionId:Uuid,environment:z.enum(['actual','paper'])}), output:z.array(BudgetLine) }),
  rights: defineCapability({ id:'studio.rights.list', title:'Rights register', description:'List rights and flag expiry within 30 days', kind:'read', permission:'studio:rights:read', input:z.object({productionId:Uuid.optional()}), output:z.array(Rights.extend({expires_in_days:z.number(),alert_due:z.boolean()})) }),
  clearDeliverable: defineCapability({ id:'studio.deliverable.clear', title:'Clear deliverable', description:'Set an asset deliverable only when its linked rights are cleared', kind:'write', permission:'studio:deliverable:write', approvalPolicy:'studio.deliverable.approve', input:z.object({deliverableId:Uuid,approved:z.boolean()}), output:z.object({id:Uuid,status:z.enum(['draft','pending-approval','approved','delivered','blocked'])}).nullable() }),
  ledgerContract: defineCapability({ id:'studio.ledger.contract', title:'Ledger reference contract', description:'Expose allowed ledger relations and references for Studio integration', kind:'read', permission:'studio:ledger:read', input:z.object({}), output:z.object({tables:z.array(z.string()),references:z.array(z.string())}) }),
} as const;

export const studioLedgerRelations = {
  tables: LEDGER_TABLES.map((table) => table.name),
  references: Object.keys(LEDGER_REFERENCE_KEYS),
} as const;
