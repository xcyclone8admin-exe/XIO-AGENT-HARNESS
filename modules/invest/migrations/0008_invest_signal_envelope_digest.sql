ALTER TABLE invest_signal_decisions
  ADD COLUMN envelope_digest_version text,
  ADD COLUMN envelope_digest_algorithm text,
  ADD COLUMN envelope_digest text;

ALTER TABLE invest_signal_decisions
  ADD CONSTRAINT invest_signal_decisions_envelope_digest_check CHECK (
    (envelope_digest_version IS NULL AND envelope_digest_algorithm IS NULL AND envelope_digest IS NULL)
    OR
    (envelope_digest_version='xyra.invest.envelope.digest.v1' AND envelope_digest_algorithm='SHA-256'
      AND envelope_digest ~ '^[0-9a-f]{64}$')
  );
