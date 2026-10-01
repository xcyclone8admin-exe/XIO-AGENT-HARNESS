'use client';

import { Building2, FileCheck2, Landmark, ListChecks, Network, Scale, ScrollText } from 'lucide-react';
import type { ModuleUi } from '@xyra/sdk/module-ui';
import { EmptyState, PageHeader, Panel } from '@xyra/ui';

function EmptyPage({title,description,icon:Icon}:{title:string;description:string;icon:typeof Building2}) {
 return <><PageHeader eyebrow="Corporate" title={title} description={description}/><Panel><EmptyState icon={Icon} title={`${title} not connected`}>Connect the local Corporate service to load workspace records. No sample entities, approvals or financial figures are shown.</EmptyState></Panel></>;
}
function Entities(){return <EmptyPage title="Legal entities" description="View the workspace entity hierarchy, jurisdictions and ownership." icon={Building2}/>;}
function Governance(){return <EmptyPage title="Board governance" description="Record meetings, quorum, resolutions, votes and immutable minutes." icon={Landmark}/>;}
function Policies(){return <EmptyPage title="Policies and attestations" description="Manage policy versions, attestations and approved exceptions." icon={ScrollText}/>;}
function Okrs(){return <EmptyPage title="OKRs and scorecards" description="Review objective cascades and deterministic key result progress." icon={ListChecks}/>;}
function Compliance(){return <EmptyPage title="Compliance calendar" description="Track owned filing dates, controls, evidence and overdue items." icon={FileCheck2}/>;}
function Equity(){return <EmptyPage title="Cap table" description="Review share classes, grants, vesting and dilution scenarios." icon={Scale}/>;}
function Audit(){return <EmptyPage title="Audit explorer" description="Search the append-only workspace audit log." icon={Network}/>;}

const ui:ModuleUi={pages:{'':Entities,governance:Governance,policies:Policies,okrs:Okrs,compliance:Compliance,equity:Equity,audit:Audit}};
export default ui;
