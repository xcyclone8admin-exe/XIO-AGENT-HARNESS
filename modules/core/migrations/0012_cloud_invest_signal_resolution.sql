-- Narrow global webhook key resolution. Policy bounds and owning scope stay in the RLS-scoped
-- source table and are read only after the request signature passes verification.
CREATE TABLE cloud_invest_signal_resolution (
  source_id uuid NOT NULL,
  key_id uuid NOT NULL,
  signing_alg text NOT NULL CHECK (signing_alg IN ('ES256','EdDSA')),
  public_jwk jsonb NOT NULL CHECK (jsonb_typeof(public_jwk)='object' AND NOT (public_jwk ? 'd')),
  active boolean NOT NULL,
  PRIMARY KEY (source_id,key_id)
);

ALTER TABLE cloud_invest_signal_sources
  ADD CONSTRAINT cloud_invest_signal_sources_public_jwk_only
  CHECK (NOT (public_jwk ? 'd'));

INSERT INTO cloud_invest_signal_resolution(source_id,key_id,signing_alg,public_jwk,active)
SELECT source_id,key_id,signing_alg,public_jwk,active FROM cloud_invest_signal_sources;

CREATE FUNCTION sync_cloud_invest_signal_resolution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM public.cloud_invest_signal_resolution
      WHERE source_id=OLD.source_id AND key_id=OLD.key_id;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (OLD.source_id,OLD.key_id) IS DISTINCT FROM (NEW.source_id,NEW.key_id) THEN
    DELETE FROM public.cloud_invest_signal_resolution
      WHERE source_id=OLD.source_id AND key_id=OLD.key_id;
  END IF;
  INSERT INTO public.cloud_invest_signal_resolution(source_id,key_id,signing_alg,public_jwk,active)
  VALUES (NEW.source_id,NEW.key_id,NEW.signing_alg,NEW.public_jwk,NEW.active)
  ON CONFLICT (source_id,key_id) DO UPDATE
    SET signing_alg=EXCLUDED.signing_alg,public_jwk=EXCLUDED.public_jwk,active=EXCLUDED.active;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION sync_cloud_invest_signal_resolution() FROM PUBLIC;
CREATE TRIGGER cloud_invest_signal_resolution_sync
  AFTER INSERT OR UPDATE OR DELETE ON cloud_invest_signal_sources
  FOR EACH ROW EXECUTE FUNCTION sync_cloud_invest_signal_resolution();

-- Only the public verification tuple is globally resolvable. Policy rows are selected by a
-- source/key transaction context and then re-read under tenant/workspace scope before mutation.
REVOKE ALL ON cloud_invest_signal_resolution FROM PUBLIC;
GRANT SELECT ON cloud_invest_signal_resolution TO xyra_app_login,xyra_cloud_runtime_app;
ALTER TABLE cloud_invest_signal_resolution ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_invest_signal_resolution FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_invest_signal_resolution_worker_read ON cloud_invest_signal_resolution
  FOR SELECT TO xyra_app_login USING (true);
CREATE POLICY cloud_invest_signal_resolution_runtime_read ON cloud_invest_signal_resolution
  FOR SELECT TO xyra_cloud_runtime_app USING (true);

DROP POLICY cloud_invest_signal_sources_worker_read ON cloud_invest_signal_sources;
DROP POLICY cloud_invest_signal_sources_runtime_read ON cloud_invest_signal_sources;
CREATE POLICY cloud_invest_signal_sources_source_scoped_read ON cloud_invest_signal_sources
  FOR SELECT TO xyra_app_login,xyra_cloud_runtime_app
  USING (source_id::text=current_setting('app.invest_signal_source_id',true)
     AND key_id::text=current_setting('app.invest_signal_key_id',true)
     AND (current_setting('app.tenant_id',true) IS NULL OR current_setting('app.tenant_id',true)=''
          OR tenant_id::text=current_setting('app.tenant_id',true))
     AND (current_setting('app.workspace_id',true) IS NULL OR current_setting('app.workspace_id',true)=''
          OR workspace_id::text=current_setting('app.workspace_id',true)));
REVOKE SELECT ON cloud_invest_signal_sources FROM xyra_app_login,xyra_cloud_runtime_app;
GRANT SELECT ON cloud_invest_signal_sources TO xyra_app_login,xyra_cloud_runtime_app;

ALTER TABLE cloud_invest_signal_events
  ADD CONSTRAINT cloud_invest_signal_events_ack_decision_consistent
  CHECK ((status='acked') = (ack_decision_id IS NOT NULL));
