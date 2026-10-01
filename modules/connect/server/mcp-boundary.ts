import { McpClientBoundary, type McpServerRegistration } from '@xyra/agent-core';
import type { McpServerDescriptor } from '../contracts';

/**
 * CONNECT's wrapper over agent-core's McpClientBoundary. CONNECT ships no transport of its own:
 * registering a descriptor here without a real transport leaves the server unreachable, and
 * `externalCallsEnabled` stays false until the owning integration supplies both. This is what
 * keeps the MCP catalog honest instead of simulated (ADR-0011; XIO-REQ-CON-001).
 */
export class ConnectMcpBoundary {
  private readonly boundary = new McpClientBoundary();

  /** Registers a server descriptor with no transport; every call against it fails closed. */
  registerUnavailable(descriptor: McpServerDescriptor): void {
    const registration: McpServerRegistration = {
      id: descriptor.id,
      allowedTools: descriptor.allowedTools,
      credential: {
        id: `${descriptor.id}:unavailable`,
        scope: descriptor.connectorId,
        revokedAt: null,
        expiresAt: new Date(0).toISOString(),
      },
      transport: {
        listTools: async () => {
          throw new Error('MCP_TRANSPORT_NOT_CONFIGURED');
        },
        callTool: async () => {
          throw new Error('MCP_TRANSPORT_NOT_CONFIGURED');
        },
      },
      externalCallsEnabled: false,
    };
    this.boundary.register(registration);
  }

  get client(): McpClientBoundary {
    return this.boundary;
  }
}
