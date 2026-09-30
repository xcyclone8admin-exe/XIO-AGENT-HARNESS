import type { AnyCapability, ModuleManifest, Principal } from '@xyra/contracts';
import { HybridClock } from '@xyra/core';
import type { LedgerApi, LedgerScope } from '@xyra/ledger/contracts';
import { ledgerCapabilities as capabilities } from '@xyra/ledger/contracts';
import manifest from '../manifest';

interface CapabilityCall {
  readonly principal: Principal;
  readonly workspaceId: string;
}

type CapabilityHandler = (input: unknown, call: CapabilityCall) => Promise<unknown>;

/** Small structural seam keeps the module independent of the sidecar's transport implementation. */
export interface CapabilityRegistrar {
  register(manifest: ModuleManifest, descriptor: AnyCapability, handler: CapabilityHandler): void;
}

/** Server-side capability adapter. Tenant, workspace, actor and HLC always come from trusted context. */
export class MoneyService {
  private readonly clock: HybridClock;

  constructor(private readonly ledger: LedgerApi, clock = new HybridClock('money')) {
    this.clock = clock;
  }

  register(bus: CapabilityRegistrar, moduleManifest: ModuleManifest = manifest): void {
    const scope = (call: CapabilityCall, stamp = false): LedgerScope => ({
      tenantId: call.principal.tenantId,
      workspaceId: call.workspaceId,
      ...(stamp ? { hlc: this.clock.now() } : {}),
    });
    // Ledger audit columns point to users; a delegated agent action records its delegating user.
    const actor = (call: CapabilityCall) => call.principal.delegatedBy ?? call.principal.id;
    const reg = (descriptor: AnyCapability, handler: CapabilityHandler) => bus.register(moduleManifest, descriptor, handler);

    reg(capabilities.assets, (_input, call) => this.ledger.assets(scope(call)));
    reg(capabilities.books, (raw, call) => {
      const input = capabilities.books.input.parse(raw);
      const filter = {
        ...(input.environment ? { environment: input.environment } : {}),
        ...(input.ownerModule ? { ownerModule: input.ownerModule } : {}),
      };
      return this.ledger.books(scope(call), filter);
    });
    reg(capabilities.createBook, (raw, call) =>
      this.ledger.createBook(scope(call, true), actor(call), capabilities.createBook.input.parse(raw)));
    reg(capabilities.accounts, (raw, call) => {
      const { bookId } = capabilities.accounts.input.parse(raw);
      return this.ledger.accounts(scope(call), bookId);
    });
    reg(capabilities.createAccount, (raw, call) =>
      this.ledger.createAccount(scope(call, true), actor(call), capabilities.createAccount.input.parse(raw)));
    reg(capabilities.post, (raw, call) =>
      this.ledger.post(scope(call, true), actor(call), capabilities.post.input.parse(raw)));
    reg(capabilities.reverse, (raw, call) =>
      this.ledger.reverse(scope(call, true), actor(call), capabilities.reverse.input.parse(raw)));
    reg(capabilities.transactions, (raw, call) =>
      this.ledger.transactions(scope(call), capabilities.transactions.input.parse(raw)));
    reg(capabilities.balances, (raw, call) =>
      this.ledger.balances(scope(call), capabilities.balances.input.parse(raw)));
    reg(capabilities.trialBalance, (raw, call) =>
      this.ledger.trialBalance(scope(call), capabilities.trialBalance.input.parse(raw)));
    reg(capabilities.totals, (raw, call) =>
      this.ledger.totals(scope(call), capabilities.totals.input.parse(raw)));
    reg(capabilities.reconcile, (raw, call) =>
      this.ledger.reconcile(scope(call, true), actor(call), capabilities.reconcile.input.parse(raw)));
    reg(capabilities.discrepancies, (raw, call) =>
      this.ledger.discrepancies(scope(call), capabilities.discrepancies.input.parse(raw)));
    reg(capabilities.assignDiscrepancy, (raw, call) =>
      this.ledger.assignDiscrepancy(scope(call, true), actor(call), capabilities.assignDiscrepancy.input.parse(raw)));
    reg(capabilities.resolveDiscrepancy, (raw, call) =>
      this.ledger.resolveDiscrepancy(scope(call, true), actor(call), capabilities.resolveDiscrepancy.input.parse(raw)));
  }
}
