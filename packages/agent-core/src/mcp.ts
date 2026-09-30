import type { DelegatedCredential } from './contracts';
import { requireActiveCredential } from './credentials';

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/** A transport is supplied by CONNECT/sidecar code; agent-core does not open sockets or launch processes. */
export interface McpTransport {
  listTools(signal: AbortSignal): Promise<readonly McpToolDescriptor[]>;
  callTool(name: string, input: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface McpServerRegistration {
  readonly id: string;
  readonly allowedTools: readonly string[];
  readonly credential: DelegatedCredential;
  readonly transport: McpTransport;
  /** External calls remain disabled until the owning integration enables them. */
  readonly externalCallsEnabled: boolean;
}

/**
 * Registry and authorization boundary only. It deliberately has no discovery, process, or network
 * implementation; callers must explicitly register a transport built by the owning module.
 */
export class McpClientBoundary {
  private readonly servers = new Map<string, McpServerRegistration>();

  register(server: McpServerRegistration): void {
    if (this.servers.has(server.id)) throw new Error(`MCP server already registered: ${server.id}`);
    this.servers.set(server.id, server);
  }

  async listTools(serverId: string, signal: AbortSignal, now = new Date()): Promise<readonly McpToolDescriptor[]> {
    const server = this.authorize(serverId, now);
    return (await server.transport.listTools(signal)).filter((tool) => server.allowedTools.includes(tool.name));
  }

  async callTool(
    serverId: string,
    toolName: string,
    input: unknown,
    signal: AbortSignal,
    now = new Date(),
  ): Promise<unknown> {
    const server = this.authorize(serverId, now);
    if (!server.externalCallsEnabled) throw new Error('MCP_EXTERNAL_CALLS_DISABLED');
    if (!server.allowedTools.includes(toolName)) throw new Error('MCP_TOOL_NOT_GRANTED');
    return server.transport.callTool(toolName, input, signal);
  }

  private authorize(serverId: string, now: Date): McpServerRegistration {
    const server = this.servers.get(serverId);
    if (!server) throw new Error('MCP_SERVER_NOT_REGISTERED');
    requireActiveCredential(server.credential, now);
    return server;
  }
}
