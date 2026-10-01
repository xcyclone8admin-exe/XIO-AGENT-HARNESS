-- Additive: missing append-only trigger on command_doctor_checks (omitted from 0001).
-- Checkpoint 0001 is already integrated; this migration is additive.
CREATE TRIGGER command_doctor_checks_immutable BEFORE UPDATE OR DELETE ON command_doctor_checks
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
