-- Keep an object unavailable to new reference issuance while an authorized R2 delete is in flight.
ALTER TABLE cloud_erasure_objects
  DROP CONSTRAINT cloud_erasure_objects_storage_state_check,
  ADD CONSTRAINT cloud_erasure_objects_storage_state_check
    CHECK (storage_state IN ('unknown','available','deleting','deleted'));