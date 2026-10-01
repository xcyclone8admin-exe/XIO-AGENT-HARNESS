import { defineModule } from '@xyra/contracts';

const permissions = [
  'studio:production:read', 'studio:production:write', 'studio:budget:read', 'studio:budget:write',
  'studio:schedule:read', 'studio:schedule:write', 'studio:crew:read', 'studio:crew:write',
  'studio:rights:read', 'studio:rights:write', 'studio:asset:read', 'studio:asset:write',
  'studio:deliverable:read', 'studio:deliverable:write', 'studio:ledger:read',
];

export default defineModule({
  id: 'studio', version: '1.0.0', pillar: 'STUDIO', title: 'Studio',
  description: 'Production slates, schedules, crew, budgets, rights and delivery clearance',
  icon: 'clapperboard', order: 20,
  requirements: ['REQ-PROD-001','REQ-PROD-002','REQ-PROD-003','REQ-PROD-004','REQ-PROD-005','REQ-PROD-006','REQ-PROD-007'],
  permissions,
  roleGrants: {
    manager: permissions,
    member: ['studio:production:read','studio:production:write','studio:budget:read','studio:schedule:read','studio:schedule:write','studio:crew:read','studio:crew:write','studio:rights:read','studio:asset:read','studio:deliverable:read'],
    viewer: ['studio:production:read','studio:budget:read','studio:schedule:read','studio:crew:read','studio:rights:read','studio:asset:read','studio:deliverable:read','studio:ledger:read'],
    auditor: ['studio:production:read','studio:budget:read','studio:schedule:read','studio:crew:read','studio:rights:read','studio:asset:read','studio:deliverable:read','studio:ledger:read'],
  },
  nav: [
    { path: '', title: 'Slate', keywords: ['productions','pipeline'] },
    { path: 'schedule', title: 'Schedule', keywords: ['calendar','shoot days'] },
    { path: 'budgets', title: 'Budgets', keywords: ['ledger','variance'] },
    { path: 'clearances', title: 'Clearances', keywords: ['rights','assets','delivery'] },
  ],
  dependsOn: ['core'],
  tables: [
    { name:'studio_productions', class:'lww', authority:'synced', actorField:'created_by', receivedAtField:'created_at', writePermission:'studio:production:write', readPermission:'studio:production:read', allowedFields:['title','format','owner_id'], guardedColumns:['phase'], columns:{title:{type:'text',requiredOnInsert:true,minLength:1,maxLength:200},format:{type:'text',requiredOnInsert:true,enum:['film','video','content','campaign']},phase:{type:'text',enum:['development','pre-production','production','post','delivery','release']},owner_id:{type:'uuid',requiredOnInsert:true},created_by:{type:'uuid',requiredOnInsert:true},created_at:{type:'timestamptz'}}},
    { name:'studio_production_history', class:'append', authority:'append', actorField:'actor_id', receivedAtField:'occurred_at', writePermission:'studio:production:write', readPermission:'studio:production:read', allowedFields:['production_id','from_phase','to_phase'], columns:{production_id:{type:'uuid',requiredOnInsert:true,references:{table:'studio_productions'}},from_phase:{type:'text',nullable:true},to_phase:{type:'text',requiredOnInsert:true},actor_id:{type:'uuid',requiredOnInsert:true},occurred_at:{type:'timestamptz'}}},
    { name:'studio_budget_lines', class:'lww', authority:'synced', actorField:'created_by', receivedAtField:'created_at', writePermission:'studio:budget:write', readPermission:'studio:budget:read', allowedFields:['production_id','account_code','asset','planned_units','committed_units','overage_threshold_bps'], columns:{production_id:{type:'uuid',requiredOnInsert:true,references:{table:'studio_productions'}},account_code:{type:'text',requiredOnInsert:true,maxLength:64},asset:{type:'text',maxLength:32},planned_units:{type:'numeric',requiredOnInsert:true,min:'0',scale:0},committed_units:{type:'numeric',min:'0',scale:0},overage_threshold_bps:{type:'integer',min:'0',max:'100000'},created_by:{type:'uuid',requiredOnInsert:true},created_at:{type:'timestamptz'}}},
    { name:'studio_schedule_items', class:'lww', authority:'synced', actorField:'created_by', receivedAtField:'created_at', writePermission:'studio:schedule:write', readPermission:'studio:schedule:read', allowedFields:['production_id','title','kind','starts_at','ends_at'], columns:{production_id:{type:'uuid',requiredOnInsert:true,references:{table:'studio_productions'}},title:{type:'text',requiredOnInsert:true,maxLength:200},kind:{type:'text',requiredOnInsert:true,enum:['phase','shoot_day','milestone']},starts_at:{type:'timestamptz',requiredOnInsert:true},ends_at:{type:'timestamptz',requiredOnInsert:true},created_by:{type:'uuid',requiredOnInsert:true},created_at:{type:'timestamptz'}}},
    { name:'studio_schedule_dependencies', class:'lww', authority:'server', readPermission:'studio:schedule:read' },
    { name:'studio_crew_assignments', class:'lww', authority:'synced', actorField:'created_by', receivedAtField:'created_at', writePermission:'studio:crew:write', readPermission:'studio:crew:read', allowedFields:['production_id','person_ref','role','rate_units','asset','starts_at','ends_at','nda_status','release_status'], columns:{production_id:{type:'uuid',requiredOnInsert:true,references:{table:'studio_productions'}},person_ref:{type:'text',requiredOnInsert:true,maxLength:200},role:{type:'text',requiredOnInsert:true,maxLength:120},rate_units:{type:'numeric',requiredOnInsert:true,min:'0',scale:0},asset:{type:'text',maxLength:32},starts_at:{type:'timestamptz',requiredOnInsert:true},ends_at:{type:'timestamptz',requiredOnInsert:true},nda_status:{type:'text',enum:['unknown','pending','signed','declined']},release_status:{type:'text',enum:['unknown','pending','signed','declined']},created_by:{type:'uuid',requiredOnInsert:true},created_at:{type:'timestamptz'}}},
    { name:'studio_rights', class:'lww', authority:'synced', actorField:'created_by', receivedAtField:'created_at', writePermission:'studio:rights:write', readPermission:'studio:rights:read', allowedFields:['production_id','subject','territory','starts_on','expires_on'], guardedColumns:['status'], columns:{production_id:{type:'uuid',requiredOnInsert:true,references:{table:'studio_productions'}},subject:{type:'text',requiredOnInsert:true,maxLength:200},territory:{type:'text',requiredOnInsert:true,maxLength:120},starts_on:{type:'date',requiredOnInsert:true},expires_on:{type:'date',requiredOnInsert:true},status:{type:'text',enum:['pending','cleared','restricted','expired']},created_by:{type:'uuid',requiredOnInsert:true},created_at:{type:'timestamptz'}}},
    { name:'studio_assets', class:'lww', authority:'synced', actorField:'created_by', receivedAtField:'created_at', writePermission:'studio:asset:write', readPermission:'studio:asset:read', allowedFields:['production_id','r2_key','content_hash','version','rights_id'], columns:{production_id:{type:'uuid',requiredOnInsert:true,references:{table:'studio_productions'}},r2_key:{type:'text',requiredOnInsert:true,maxLength:1024},content_hash:{type:'text',requiredOnInsert:true,minLength:64,maxLength:64},version:{type:'integer',requiredOnInsert:true,min:'1'},rights_id:{type:'uuid',nullable:true,references:{table:'studio_rights'}},created_by:{type:'uuid',requiredOnInsert:true},created_at:{type:'timestamptz'}}},
    { name:'studio_deliverables', class:'lww', authority:'synced', actorField:'created_by', receivedAtField:'created_at', writePermission:'studio:deliverable:write', readPermission:'studio:deliverable:read', allowedFields:['production_id','asset_id','distributor','spec_checklist'], guardedColumns:['status'], columns:{production_id:{type:'uuid',requiredOnInsert:true,references:{table:'studio_productions'}},asset_id:{type:'uuid',nullable:true,references:{table:'studio_assets'}},distributor:{type:'text',requiredOnInsert:true,maxLength:200},spec_checklist:{type:'jsonb',maxBytes:65536},status:{type:'text',enum:['draft','pending-approval','approved','delivered','blocked']},created_by:{type:'uuid',requiredOnInsert:true},created_at:{type:'timestamptz'}}},
  ],
});

