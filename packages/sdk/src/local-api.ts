import { z } from 'zod';

export const LocalSession = z.object({
  user: z.object({ id: z.uuid(), displayName: z.string() }),
  workspaces: z.array(z.object({ id: z.uuid(), role: z.string(), kind: z.enum(['standard', 'sample']) })),
});
export type LocalSession = z.infer<typeof LocalSession>;

export interface ModuleApi {
  read<T>(workspaceId: string, capabilityId: string, input?: unknown): Promise<T>;
  write<T>(workspaceId: string, capabilityId: string, input: unknown, idempotencyKey?: string): Promise<T>;
}

/** The launch token stays in memory and is supplied by the native host. */
export class LocalApiClient implements ModuleApi {
  constructor(
    readonly port: number,
    private readonly token: string,
  ) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || token.length < 32)
      throw new Error('Invalid local service session');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...init.headers },
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { code?: string };
      throw new Error(detail.code ?? `Local service returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async session(): Promise<LocalSession> {
    return LocalSession.parse(await this.request('/api/v1/session'));
  }

  async read<T>(workspaceId: string, capabilityId: string, input: unknown = {}): Promise<T> {
    return this.call(workspaceId, capabilityId, input);
  }
  async write<T>(
    workspaceId: string,
    capabilityId: string,
    input: unknown,
    idempotencyKey = crypto.randomUUID(),
  ): Promise<T> {
    return this.call(workspaceId, capabilityId, input, idempotencyKey);
  }
  private async call<T>(
    workspaceId: string,
    capabilityId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const body = await this.request<{ data: T }>(`/api/v1/call/${encodeURIComponent(capabilityId)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify({ workspaceId, input }),
    });
    return body.data;
  }
}
