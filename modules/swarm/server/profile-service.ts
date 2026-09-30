import { AgentProfile, EvalMetrics, type EvalHistoryEntry } from '@xyra/agent-core';
import { uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope } from '@xyra/db';
import { AgentProfileDraft, GUARDED_PROFILE_FIELDS } from '../contracts';

interface ProfileRow extends Record<string, unknown> {
  id: string;
  role_id: string;
  charter: string;
  default_provider: string;
  default_model: string;
  fallbacks: unknown;
  capability_grants: unknown;
  secret_scopes: unknown;
  network_policy: unknown;
  filesystem_policy: unknown;
  budgets: unknown;
  approval_policy: string;
  memory_scope: unknown;
  output_schema: unknown;
  autonomy_level: number;
}

interface EvalRow extends Record<string, unknown> {
  eval_id: string;
  model_id: string;
  ran_at: Date | string;
  metrics: unknown;
}

const PROFILE_COLUMNS = `id,role_id,charter,default_provider,default_model,fallbacks,capability_grants,secret_scopes,
  network_policy,filesystem_policy,budgets,approval_policy,memory_scope,output_schema,autonomy_level`;

/**
 * The swarm.profiles.* write path. Guarded columns are rejected here (and again by the
 * swarm_agent_profiles_guard trigger); eval history is read-derived from swarm_model_evals.
 */
export class SwarmProfileService {
  constructor(private readonly store: LocalScopedStore) {}

  async list(scope: Scope): Promise<AgentProfile[]> {
    const result = await this.store.query<ProfileRow>(
      scope,
      `SELECT ${PROFILE_COLUMNS} FROM swarm_agent_profiles WHERE workspace_id=$1 ORDER BY created_at DESC`,
      [scope.workspaceId],
    );
    return Promise.all(result.rows.map((row) => this.toProfile(scope, row)));
  }

  async create(scope: Scope, actorId: string, input: unknown): Promise<AgentProfile> {
    const draft = parseDraft(input);
    const result = await this.store.query<ProfileRow>(
      scope,
      `INSERT INTO swarm_agent_profiles(id,tenant_id,workspace_id,role_id,charter,default_provider,default_model,
         fallbacks,budgets,memory_scope,output_schema,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${PROFILE_COLUMNS}`,
      [
        uuidv7(),
        scope.tenantId,
        scope.workspaceId,
        draft.roleId,
        draft.charter,
        draft.defaultProvider,
        draft.defaultModel,
        JSON.stringify(draft.fallbacks),
        JSON.stringify(draft.budgets),
        JSON.stringify(draft.memoryScope),
        JSON.stringify(draft.outputSchema),
        actorId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Profile insert failed');
    return this.toProfile(scope, row);
  }

  async update(scope: Scope, profileId: string, input: unknown): Promise<AgentProfile | null> {
    const draft = parseDraft(input);
    const result = await this.store.query<ProfileRow>(
      scope,
      `UPDATE swarm_agent_profiles SET role_id=$1,charter=$2,default_provider=$3,default_model=$4,fallbacks=$5,
         budgets=$6,memory_scope=$7,output_schema=$8,updated_at=now()
       WHERE id=$9 AND workspace_id=$10 RETURNING ${PROFILE_COLUMNS}`,
      [
        draft.roleId,
        draft.charter,
        draft.defaultProvider,
        draft.defaultModel,
        JSON.stringify(draft.fallbacks),
        JSON.stringify(draft.budgets),
        JSON.stringify(draft.memoryScope),
        JSON.stringify(draft.outputSchema),
        profileId,
        scope.workspaceId,
      ],
    );
    const row = result.rows[0];
    return row ? this.toProfile(scope, row) : null;
  }

  /** Server-derived: every eval recorded for the profile's default provider/model, newest first. */
  private async evalHistory(scope: Scope, provider: string, modelId: string): Promise<EvalHistoryEntry[]> {
    const result = await this.store.query<EvalRow>(
      scope,
      `SELECT eval_id,model_id,ran_at,metrics FROM swarm_model_evals
       WHERE workspace_id=$1 AND provider=$2 AND model_id=$3 ORDER BY ran_at DESC`,
      [scope.workspaceId, provider, modelId],
    );
    return result.rows.map((row) => {
      const metrics = EvalMetrics.parse(row.metrics);
      return {
        evalId: row.eval_id,
        modelId: row.model_id,
        completedAt: new Date(row.ran_at).toISOString(),
        score: metrics.taskCompletion,
        fallbackRate: metrics.fallbackRate,
      };
    });
  }

  private async toProfile(scope: Scope, row: ProfileRow): Promise<AgentProfile> {
    return AgentProfile.parse({
      id: row.id,
      roleId: row.role_id,
      charter: row.charter,
      defaultProvider: row.default_provider,
      defaultModel: row.default_model,
      fallbacks: row.fallbacks,
      capabilityGrants: row.capability_grants,
      secretScopes: row.secret_scopes,
      networkPolicy: row.network_policy,
      filesystemPolicy: row.filesystem_policy,
      budgets: row.budgets,
      approvalPolicy: row.approval_policy,
      memoryScope: row.memory_scope,
      outputSchema: row.output_schema,
      autonomyLevel: row.autonomy_level,
      evalHistory: await this.evalHistory(scope, row.default_provider, row.default_model),
    });
  }
}

function parseDraft(input: unknown): AgentProfileDraft {
  if (input && typeof input === 'object') {
    const guarded = GUARDED_PROFILE_FIELDS.find((field) => field in input);
    if (guarded) throw new Error(`GUARDED_PROFILE_FIELD:${guarded}`);
  }
  const draft = AgentProfileDraft.parse(input);
  if (draft.outputSchema === undefined) throw new Error('OUTPUT_SCHEMA_REQUIRED');
  return draft;
}
