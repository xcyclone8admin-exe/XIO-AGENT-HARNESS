'use client';

import { CalendarDays, Clapperboard, ShieldAlert, WalletCards } from 'lucide-react';
import type { ModuleUi } from '@xyra/sdk/module-ui';
import { EmptyState, PageHeader, Panel } from '@xyra/ui';

function EmptyPage({title,description,icon:Icon}:{title:string;description:string;icon:typeof Clapperboard}) {
  return <><PageHeader eyebrow="Studio" title={title} description={description}/><Panel><EmptyState icon={Icon} title={`${title} not connected`}>Connect the local Studio service to load workspace records. No sample productions or simulated ledger values are shown.</EmptyState></Panel></>;
}
function Slate(){return <EmptyPage title="Production slate" description="Track each production from development through release." icon={Clapperboard}/>;}
function Schedule(){return <EmptyPage title="Schedule" description="Review production phases, shoot days and milestone conflicts." icon={CalendarDays}/>;}
function Budgets(){return <EmptyPage title="Production budgets" description="Compare planned and committed costs with posted ledger actuals." icon={WalletCards}/>;}
function Clearances(){return <EmptyPage title="Rights and delivery" description="Track rights expiry and clear assets before delivery." icon={ShieldAlert}/>;}

const ui: ModuleUi = { pages: {'':Slate,schedule:Schedule,budgets:Budgets,clearances:Clearances} };
export default ui;
