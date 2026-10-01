export const INVEST_SIGNAL_PROTOCOL = 'xyra.invest.signal.v1' as const;
export const INVEST_SIGNAL_CONSUME_PROTOCOL = 'xyra.invest.signal.consume.v1' as const;

/** Private Cloud claim envelope delivered only to the trusted sidecar host. */
export interface VerifiedInvestSignalV1 {
  readonly protocol: typeof INVEST_SIGNAL_PROTOCOL;
  readonly eventId: string;
  readonly sourceId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly receivedAt: string;
  readonly occurredAt: string;
  readonly expiresAt: string;
  readonly algorithmId: string;
  readonly signalId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: string;
  readonly payloadDigest: string;
  readonly verification: {
    readonly signature: 'verified';
    readonly keyId: string;
  };
}

export interface InvestSignalLease {
  readonly leaseId: string;
  readonly fence: number;
  readonly expiresAt: string;
}

export type VerifiedInvestSignalClaim = { readonly lease: InvestSignalLease };

export type InvestSignalClaimResult =
  | { readonly status: 'empty' }
  | { readonly status: 'claimed'; readonly lease: InvestSignalLease; readonly signal: VerifiedInvestSignalV1 };

export interface InvestSignalAckRequest {
  readonly protocol: typeof INVEST_SIGNAL_CONSUME_PROTOCOL;
  readonly eventId: string;
  readonly payloadDigest: string;
  readonly leaseId: string;
  readonly decisionId: string;
  readonly idempotencyKey: string;
}

export type VerifiedInvestSignalEnvelope = VerifiedInvestSignalV1;
