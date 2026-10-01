import { defineModule } from '@xyra/contracts';

const permissions = [
 'corporate:entity:read','corporate:entity:write','corporate:ownership:write','corporate:governance:read','corporate:governance:write',
 'corporate:policy:read','corporate:policy:write','corporate:okr:read','corporate:okr:write','corporate:compliance:read','corporate:compliance:write',
 'corporate:org:read','corporate:org:write','corporate:equity:read','corporate:equity:write','corporate:approval:read','corporate:approval:write',
 'corporate:ledger:read','corporate:audit:read'
];
const tableNames = ['corporate_entities','corporate_ownership','corporate_officers','corporate_board_meetings','corporate_resolutions','corporate_minutes','corporate_policies','corporate_attestations','corporate_policy_exceptions','corporate_okrs','corporate_key_results','corporate_compliance_items','corporate_controls','corporate_people','corporate_reporting_lines','corporate_share_classes','corporate_equity_grants','corporate_approval_policies','corporate_intercompany_links'];

export default defineModule({
 id:'corporate',version:'1.0.0',pillar:'PLATFORM',title:'Corporate',description:'Entity structure, governance, policy, OKRs, compliance and equity administration',icon:'landmark',order:30,
 requirements:['REQ-CORP-001','REQ-CORP-002','REQ-CORP-003','REQ-CORP-004','REQ-CORP-005','REQ-CORP-006','REQ-CORP-007','REQ-CORP-008','REQ-CORP-009','REQ-CORP-010','REQ-CORP-011'],permissions,
 roleGrants:{
  manager:permissions.filter((p)=>!p.endsWith(':audit:read')),
  member:['corporate:entity:read','corporate:governance:read','corporate:policy:read','corporate:okr:read','corporate:compliance:read','corporate:org:read','corporate:equity:read','corporate:ledger:read'],
  viewer:['corporate:entity:read','corporate:governance:read','corporate:policy:read','corporate:okr:read','corporate:compliance:read','corporate:org:read','corporate:equity:read','corporate:ledger:read'],
  auditor:['corporate:entity:read','corporate:governance:read','corporate:policy:read','corporate:okr:read','corporate:compliance:read','corporate:org:read','corporate:equity:read','corporate:ledger:read','corporate:audit:read']
 },
 nav:[{path:'',title:'Entities',keywords:['organization','subsidiaries']},{path:'governance',title:'Governance',keywords:['board','resolutions']},{path:'policies',title:'Policies',keywords:['attestations','exceptions']},{path:'okrs',title:'OKRs',keywords:['key results','scorecards']},{path:'compliance',title:'Compliance',keywords:['controls','filings']},{path:'equity',title:'Equity',keywords:['cap table','dilution']},{path:'audit',title:'Audit explorer',keywords:['history','export'],permission:'corporate:audit:read'}],
 dependsOn:['core'],dataClassification:'confidential-financial',tables:tableNames.map((name)=>({name,class:'lww' as const,authority:'server' as const,readPermission:'corporate:entity:read'}))
});
