import { canonicalCloudIngestionJson } from '@xyra/contracts';
import { sha256Hex } from '@xyra/core';

export const INVEST_SIGNAL_PROTOCOL = 'xyra.invest.signal.v1' as const;
export const INVEST_SIGNAL_CONSUME_PROTOCOL = 'xyra.invest.signal.consume.v1' as const;
export const INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION = 'xyra.invest.envelope.digest.v1' as const;
export const INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM = 'SHA-256' as const;

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
  readonly envelopeDigestVersion: typeof INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION;
  readonly envelopeDigestAlgorithm: typeof INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM;
  readonly envelopeDigest: string;
  readonly verification: {
    readonly signature: 'verified';
    readonly keyId: string;
    readonly signingAlg: 'ES256' | 'EdDSA';
  };
}

export async function investSignalEnvelopeDigest(envelope: VerifiedInvestSignalV1): Promise<string> {
  const { envelopeDigestVersion: _version, envelopeDigestAlgorithm: _algorithm, envelopeDigest: _digest, ...normalizedFields } = envelope;
  return sha256Hex(canonicalCloudIngestionJson({
    digestAlgorithm: envelope.envelopeDigestAlgorithm,
    digestVersion: envelope.envelopeDigestVersion,
    envelope: normalizedFields,
  }));
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
  readonly envelopeDigestVersion: typeof INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION;
  readonly envelopeDigestAlgorithm: typeof INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM;
  readonly envelopeDigest: string;
  readonly leaseId: string;
  readonly decisionId: string;
  readonly idempotencyKey: string;
}

export type VerifiedInvestSignalEnvelope = VerifiedInvestSignalV1;
