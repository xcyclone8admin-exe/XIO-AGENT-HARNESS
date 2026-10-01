import {
  CloudInvestSignalEnvelopeDigestAlgorithm,
  CloudInvestSignalEnvelopeDigestVersion,
  cloudInvestSignalEnvelopeDigest,
  type CloudInvestSignalEnvelopeDigestInput,
} from '@xyra/contracts';

export const INVEST_SIGNAL_PROTOCOL = 'xyra.invest.signal.v1' as const;
export const INVEST_SIGNAL_CONSUME_PROTOCOL = 'xyra.invest.signal.consume.v1' as const;
export const INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION = CloudInvestSignalEnvelopeDigestVersion;
export const INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM = CloudInvestSignalEnvelopeDigestAlgorithm;

/** Private Cloud claim envelope delivered only to the trusted sidecar host. */
export interface VerifiedInvestSignalV1 extends CloudInvestSignalEnvelopeDigestInput {
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
  return cloudInvestSignalEnvelopeDigest(normalizedFields);
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
