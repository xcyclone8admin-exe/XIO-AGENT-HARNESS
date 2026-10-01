import type { CapabilityBusLike, CapabilityCallContext, ModuleServer, ModuleManifest } from '@xyra/contracts';
import type { LocalScopedStore } from '@xyra/db';
import { growthCapabilities } from '../contracts';
import { GrowthService } from './service';

function scope(call: CapabilityCallContext) {
  return { tenantId: call.principal.tenantId, workspaceId: call.workspaceId };
}

export function makeGrowthServer(store: LocalScopedStore): ModuleServer {
  const svc = new GrowthService(store);
  return {
    id: 'growth',
    capabilities: Object.values(growthCapabilities),
    register(bus: CapabilityBusLike, manifest: ModuleManifest): void {
      const c = growthCapabilities;

      bus.register(manifest, c.contacts, (i, call) => {
        const { segment, q } = c.contacts.input.parse(i);
        return svc.contacts(scope(call), segment, q);
      });
      bus.register(manifest, c.createContact, (i, call) => {
        const parsed = c.createContact.input.parse(i);
        return svc.createContact(scope(call), call.principal.id, parsed.name, {
          ...(parsed.email !== undefined ? { email: parsed.email } : {}),
          ...(parsed.phone !== undefined ? { phone: parsed.phone } : {}),
          ...(parsed.company_id !== undefined ? { company_id: parsed.company_id } : {}),
          ...(parsed.segment !== undefined ? { segment: parsed.segment } : {}),
        });
      });
      bus.register(manifest, c.companies, (_i, call) => svc.companies(scope(call)));
      bus.register(manifest, c.deals, (i, call) => {
        const { pipeline, status } = c.deals.input.parse(i);
        return svc.deals(scope(call), pipeline, status);
      });
      bus.register(manifest, c.createDeal, (i, call) => {
        const pd = c.createDeal.input.parse(i);
        return svc.createDeal(scope(call), call.principal.id, pd.title, pd.pipeline, pd.stage, {
          ...(pd.contact_id !== undefined ? { contact_id: pd.contact_id } : {}),
          ...(pd.company_id !== undefined ? { company_id: pd.company_id } : {}),
          ...(pd.value_cents !== undefined ? { value_cents: pd.value_cents } : {}),
          ...(pd.currency !== undefined ? { currency: pd.currency } : {}),
        });
      });
      bus.register(manifest, c.sequences, (i, call) => {
        const { status } = c.sequences.input.parse(i);
        return svc.sequences(scope(call), status);
      });
      // enroll is consequential; approval verification handled by bus before this runs.
      bus.register(manifest, c.enroll, async (i, call) => {
        const { sequenceId, contactId } = c.enroll.input.parse(i);
        await svc.enrollContact(scope(call), call.principal.id, sequenceId, contactId);
        return { queued: true, approvalId: null };
      });
      bus.register(manifest, c.funnels, (_i, call) => svc.funnels(scope(call)));
      bus.register(manifest, c.contentPosts, (i, call) => {
        const { status } = c.contentPosts.input.parse(i);
        return svc.contentPosts(scope(call), status);
      });
      // publishPost is consequential; returns queued:true after approval.
      bus.register(manifest, c.publishPost, async () => ({ queued: true, approvalId: null }));
      bus.register(manifest, c.adCampaigns, (i, call) => {
        const { status } = c.adCampaigns.input.parse(i);
        return svc.adCampaigns(scope(call), status);
      });
      // spendAd is consequential; returns queued:true after approval.
      bus.register(manifest, c.spendAd, async () => ({ queued: true, approvalId: null }));
      bus.register(manifest, c.brandDeals, (i, call) => {
        const { status } = c.brandDeals.input.parse(i);
        return svc.brandDeals(scope(call), status);
      });
    },
  };
}
export default makeGrowthServer;
