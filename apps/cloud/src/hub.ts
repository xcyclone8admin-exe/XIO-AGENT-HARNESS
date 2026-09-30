import { DurableObject } from 'cloudflare:workers';
import type { KillSwitchState } from '@xyra/contracts';
import { emptyLeaseBook, acquireLease, renewLease, type LeaseBook } from './leases';
import type { CandidateClaims, CurrentMembership } from './model';
import { emptySyncSnapshot, parseSyncPush, SyncAuthorityEngine, type SyncSnapshot } from './sync';
import { hasPermission } from './tables';
import type { Env } from './index';

interface HubState {
  readonly memberships: Readonly<Record<string, CurrentMembership>>;
  readonly sync: SyncSnapshot;
  readonly leases: LeaseBook;
  readonly killSwitch: KillSwitchState;
}

const EMPTY_KILL_SWITCH: KillSwitchState = {
  engaged: false,
  scope: 'workspace',
  reason: null,
  changedBy: null,
  changedAt: null,
};

function emptyHubState(): HubState {
  return {
    memberships: {},
    sync: emptySyncSnapshot(),
    leases: emptyLeaseBook(),
    killSwitch: EMPTY_KILL_SWITCH,
  };
}

function isCandidateClaims(value: unknown): value is CandidateClaims {
  if (!value || typeof value !== 'object') return false;
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.principalId === 'string' &&
    typeof claims.tenantId === 'string' &&
    typeof claims.activeWorkspaceId === 'string' &&
    (claims.kind === 'user' || claims.kind === 'agent') &&
    Array.isArray(claims.workspaceIds) &&
    claims.workspaceIds.every((id) => typeof id === 'string') &&
    [0, 1, 2, 3, 4].includes(claims.autonomy as number) &&
    typeof claims.expiresAtMs === 'number'
  );
}

function currentMembership(
  state: HubState,
  claims: CandidateClaims,
  nowMs: number,
): CurrentMembership | null {
  const membership = state.memberships[claims.principalId];
  if (
    !membership ||
    membership.principalId !== claims.principalId ||
    membership.tenantId !== claims.tenantId ||
    membership.workspaceId !== claims.activeWorkspaceId ||
    claims.expiresAtMs <= nowMs ||
    (membership.revokedAtMs !== undefined && membership.revokedAtMs <= nowMs)
  ) {
    return null;
  }
  return membership;
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * One Durable Object per workspace: it is the strong-consistency boundary for
 * membership revocation, sync sequencing, leases, and kill-switch fan-out.
 */
export class WorkspaceHub extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/internal/')) return response({ code: 'HUB_NOT_PUBLIC' }, 404);
    const body = await readJson(request);
    if (!body) return response({ code: 'INVALID_REQUEST' }, 400);
    const state = (await this.ctx.storage.get<HubState>('state')) ?? emptyHubState();
    const nowMs = Date.now();

    if (url.pathname === '/internal/membership/upsert' || url.pathname === '/internal/kill-switch/set') {
      if (
        !this.env.HUB_INTERNAL_TOKEN ||
        request.headers.get('x-hub-internal-token') !== this.env.HUB_INTERNAL_TOKEN
      ) {
        return response({ code: 'INTERNAL_AUTH_REQUIRED' }, 403);
      }
      return this.handleServerAuthority(url.pathname, body, state);
    }

    const claims = body.claims;
    if (!isCandidateClaims(claims)) return response({ code: 'INVALID_CLAIMS' }, 400);
    const membership = currentMembership(state, claims, nowMs);
    if (!membership) return response({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    if (url.pathname === '/internal/authorize') return response({ membership });

    if (url.pathname === '/internal/sync/push') {
      const syncRequest = parseSyncPush(body.request);
      if (!syncRequest) return response({ code: 'INVALID_SYNC_REQUEST' }, 400);
      const engine = new SyncAuthorityEngine(state.sync);
      const result = engine.push({ ...claims, membership }, syncRequest, nowMs);
      await this.ctx.storage.put('state', { ...state, sync: engine.snapshot() });
      return response(result);
    }
    if (url.pathname === '/internal/sync/pull') {
      const engine = new SyncAuthorityEngine(state.sync);
      const cursor = typeof body.cursor === 'string' ? body.cursor : undefined;
      const result = engine.pull(cursor);
      return result ? response(result) : response({ code: 'INVALID_CURSOR' }, 400);
    }
    if (url.pathname === '/internal/lease/acquire' || url.pathname === '/internal/lease/renew') {
      if (state.killSwitch.engaged) return response({ code: 'KILL_SWITCH_ENGAGED' }, 423);
      if (!hasPermission(membership, 'core:workspace:write'))
        return response({ code: 'PERMISSION_DENIED' }, 403);
      const key = typeof body.key === 'string' ? body.key : '';
      const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : 0;
      const lease = url.pathname.endsWith('/acquire')
        ? acquireLease(state.leases, key, claims.principalId, ttlMs, nowMs)
        : renewLease(state.leases, key, claims.principalId, ttlMs, nowMs);
      if (!lease) return response({ code: 'LEASE_UNAVAILABLE' }, 409);
      await this.ctx.storage.put('state', {
        ...state,
        leases: { leases: { ...state.leases.leases, [lease.key]: lease } },
      });
      return response({ lease });
    }
    if (url.pathname === '/internal/kill-switch/get') return response({ killSwitch: state.killSwitch });
    return response({ code: 'HUB_ROUTE_NOT_FOUND' }, 404);
  }

  private async handleServerAuthority(
    path: string,
    body: Record<string, unknown>,
    state: HubState,
  ): Promise<Response> {
    if (path === '/internal/membership/upsert') {
      const membership = body.membership;
      if (!membership || typeof membership !== 'object') return response({ code: 'INVALID_MEMBERSHIP' }, 400);
      const value = membership as Record<string, unknown>;
      if (
        typeof value.principalId !== 'string' ||
        typeof value.tenantId !== 'string' ||
        typeof value.workspaceId !== 'string' ||
        !['owner', 'admin', 'manager', 'member', 'viewer', 'auditor'].includes(value.role as string) ||
        !Array.isArray(value.permissions) ||
        !value.permissions.every((permission) => typeof permission === 'string')
      ) {
        return response({ code: 'INVALID_MEMBERSHIP' }, 400);
      }
      const updated: CurrentMembership = {
        principalId: value.principalId,
        tenantId: value.tenantId,
        workspaceId: value.workspaceId,
        role: value.role as CurrentMembership['role'],
        permissions: value.permissions,
        ...(typeof value.revokedAtMs === 'number' ? { revokedAtMs: value.revokedAtMs } : {}),
      };
      await this.ctx.storage.put('state', {
        ...state,
        memberships: { ...state.memberships, [updated.principalId]: updated },
      });
      return response({ ok: true });
    }
    const killSwitch = body.killSwitch;
    if (!killSwitch || typeof killSwitch !== 'object') return response({ code: 'INVALID_KILL_SWITCH' }, 400);
    const value = killSwitch as Record<string, unknown>;
    if (
      typeof value.engaged !== 'boolean' ||
      value.scope !== 'workspace' ||
      typeof value.changedAt !== 'string'
    ) {
      return response({ code: 'INVALID_KILL_SWITCH' }, 400);
    }
    const next: KillSwitchState = {
      engaged: value.engaged,
      scope: 'workspace',
      reason: typeof value.reason === 'string' ? value.reason : null,
      changedBy: typeof value.changedBy === 'string' ? value.changedBy : null,
      changedAt: value.changedAt,
    };
    await this.ctx.storage.put('state', { ...state, killSwitch: next });
    return response({ ok: true, killSwitch: next });
  }
}
