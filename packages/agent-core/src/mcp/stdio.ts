import type { McpToolDescriptor, McpTransport } from '../mcp';
import type { CredentialBroker } from '../providers/transport';

/** Minimal byte channel supplied by the trusted sidecar. This module never launches a process. */
export interface McpByteChannel {
  write(data: Uint8Array): Promise<void>;
  read(signal: AbortSignal): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export interface McpPolicy {
  readonly allowedCapabilities: readonly string[];
  readonly toolCapabilities: Readonly<Record<string, string>>;
  readonly budget: { readonly maxRequests: number; readonly maxResponseBytes: number; readonly timeoutMs: number };
}

export interface BrokeredMcpChannelOptions {
  readonly serverId: string;
  readonly credentialRef: string;
  readonly credentialScope: string;
  readonly broker: CredentialBroker;
  /** Host-owned opener uses the credential inside its native process/channel boundary. */
  readonly openSecureChannel: (credential: string) => Promise<McpByteChannel>;
  readonly policy: McpPolicy;
}

export async function createBrokeredStdioMcpTransport(options: BrokeredMcpChannelOptions): Promise<StdioMcpTransport> {
  if (!options.serverId || !options.credentialRef || !options.credentialScope) throw new Error('MCP_BROKER_REFERENCE_REQUIRED');
  const channel = await options.broker.withCredential(options.credentialRef, options.credentialScope, options.openSecureChannel);
  return new StdioMcpTransport(channel, options.policy);
}

type Json = Record<string, unknown>;
const asObject = (x: unknown): Json => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Json : {};

/** JSON-RPC 2.0 MCP client with capability, budget, response-size and cancellation checks. */
export class StdioMcpTransport implements McpTransport {
  private nextId = 1;
  private requests = 0;
  private pending?: Uint8Array;
  private initialized = false;
  private initPromise?: Promise<void>;
  private chain: Promise<void> = Promise.resolve();
  private readonly serverName: string;
  private readonly serverVersion: string;

  constructor(private readonly channel: McpByteChannel, private readonly policy: McpPolicy, identity = { name: 'xyra-agent-core', version: '0.1.0' }) {
    this.serverName = identity.name;
    this.serverVersion = identity.version;
    if (!Number.isInteger(policy.budget.maxRequests) || policy.budget.maxRequests < 1 || !Number.isInteger(policy.budget.maxResponseBytes) || policy.budget.maxResponseBytes < 1 || !Number.isInteger(policy.budget.timeoutMs) || policy.budget.timeoutMs < 1) throw new Error('MCP_BUDGET_INVALID');
    for (const capability of Object.values(policy.toolCapabilities)) {
      if (!policy.allowedCapabilities.includes(capability)) throw new Error('MCP_CAPABILITY_NOT_ALLOWED');
    }
  }

  async listTools(signal: AbortSignal): Promise<readonly McpToolDescriptor[]> {
    await this.initialize(signal);
    const result = await this.rpc('tools/list', {}, signal);
    const tools = asObject(result).tools;
    if (!Array.isArray(tools)) throw new Error('MCP_INVALID_RESPONSE');
    return tools.flatMap((item) => {
      const tool = asObject(item);
      if (typeof tool.name !== 'string' || typeof tool.description !== 'string' || !this.policy.allowedCapabilities.includes(this.policy.toolCapabilities[tool.name] ?? '')) return [];
      return [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? { type: 'object' } }];
    });
  }

  callTool(name: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const capability = this.policy.toolCapabilities[name];
    if (!capability || !this.policy.allowedCapabilities.includes(capability)) throw new Error('MCP_CAPABILITY_NOT_ALLOWED');
    return this.initialize(signal).then(() => this.rpc('tools/call', { name, arguments: input }, signal));
  }

  async close(): Promise<void> { await this.channel.close(); }

  private async initialize(signal: AbortSignal): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) this.initPromise = (async () => {
      await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: this.serverName, version: this.serverVersion } }, signal);
      await this.channel.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`));
      this.initialized = true;
    })();
    await this.initPromise;
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }

  private async rpc(method: string, params: Json, parent: AbortSignal): Promise<unknown> {
    return this.serial(() => this.rpcLocked(method, params, parent));
  }

  private async rpcLocked(method: string, params: Json, parent: AbortSignal): Promise<unknown> {
    if (parent.aborted) throw new Error('CANCELED');
    if (this.requests >= this.policy.budget.maxRequests) throw new Error('MCP_BUDGET_EXCEEDED');
    this.requests += 1;
    const id = this.nextId++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.policy.budget.timeoutMs);
    try {
      const message = new TextEncoder().encode(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      await this.channel.write(message);
      let response: Json;
      for (;;) {
        const bytes = await this.readLine(controller.signal);
        if (parent.aborted) throw new Error('CANCELED');
        response = asObject(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
        if (response.id === undefined && typeof response.method === 'string') continue;
        break;
      }
      if (response.jsonrpc !== '2.0' || response.id !== id) throw new Error('MCP_INVALID_RESPONSE');
      if (response.error) throw new Error('MCP_REMOTE_ERROR');
      return response.result;
    } catch (error) {
      if (parent.aborted) throw new Error('CANCELED');
      if (controller.signal.aborted) throw new Error('MCP_TIMEOUT');
      if (error instanceof SyntaxError) throw new Error('MCP_INVALID_RESPONSE');
      throw error;
    } finally {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    }
  }

  private async readLine(signal: AbortSignal): Promise<Uint8Array> {
    for (;;) {
      if (signal.aborted) throw new Error('MCP_TIMEOUT');
      if (this.pending) {
        const index = this.pending.indexOf(10);
        if (index >= 0) {
          const line = this.pending.slice(0, index);
          this.pending = this.pending.slice(index + 1);
          if (line.byteLength > this.policy.budget.maxResponseBytes) throw new Error('MCP_RESPONSE_TOO_LARGE');
          return line;
        }
        if (this.pending.byteLength > this.policy.budget.maxResponseBytes) throw new Error('MCP_RESPONSE_TOO_LARGE');
      }
      const chunk = await this.channel.read(signal);
      if (!chunk) throw new Error('MCP_CHANNEL_CLOSED');
      if (chunk.byteLength > this.policy.budget.maxResponseBytes) throw new Error('MCP_RESPONSE_TOO_LARGE');
      const previous = this.pending ?? new Uint8Array();
      const merged = new Uint8Array(previous.byteLength + chunk.byteLength);
      merged.set(previous); merged.set(chunk, previous.byteLength); this.pending = merged;
    }
  }
}
