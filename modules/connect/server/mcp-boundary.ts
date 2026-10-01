import { McpClientBoundary, type McpServerRegistration } from '@xyra/agent-core';
import type { McpServerDescriptor } from '../contracts';
import type { ConnectorCredential } from './repository';

/**
 * CONNECT's wrapper over agent-core's McpClientBoundary. CONNECT ships no transport of its own:
 * registering a descriptor here without a real transport leaves the server unreachable, and
 * `externalCallsEnabled` stays false until the owning integration supplies both. This is what
 * keeps the MCP catalog honest instead of simulated (ADR-0011; XIO-REQ-CON-001).
 *
 * Registration is a snapshot: agent-core's boundary has no live credential refresh, so a
 * connector's registration must be re-created (a fresh ConnectMcpBoundary) after its grant ledger
 * changes to pick up a revocation. This mirrors how the boundary itself works — authorization is
 * checked against whatever credential was registered, not re-derived per call.
 */
export class ConnectMcpBoundary {
  private readonly boundary = new McpClientBoundary();

  /**
   * Registers a server bound to a connector's CURRENT derived credential (ConnectRepository.
   * currentCredential). With no credential (never granted) or a revoked/expired one, every call
   * fails on authorization before CONNECT's absent transport is even reached.
   */
  register(descriptor: McpServerDescriptor, credential: ConnectorCredential | null): void {
    const registration: McpServerRegistration = {
      id: descriptor.id,
      allowedTools: descriptor.allowedTools,
      credential: credential
        ? { id: `${descriptor.id}:${descriptor.connectorId}`, scope: credential.scope, expiresAt: credential.expiresAt, revokedAt: credential.revokedAt }
        : { id: `${descriptor.id}:ungranted`, scope: descriptor.connectorId, expiresAt: new Date(0).toISOString(), revokedAt: null },
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
