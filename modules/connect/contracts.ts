import { defineCapability, ConnectorStatus } from '@xyra/contracts';
import { z } from 'zod';

export { ConnectorState, ConnectorStatus, CONNECTOR_STATES, CONNECTED_TTL_MS, isHonestStatus } from '@xyra/contracts';

export const UUID = z.uuid();

/** A connector entry as persisted in connect_connectors; mirrors ConnectorStatus plus row identity. */
export const ConnectorRecord = ConnectorStatus.extend({
  createdBy: UUID,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ConnectorRecord = z.infer<typeof ConnectorRecord>;

export const ConnectorCatalogRequest = z.object({});

export const GrantAction = z.enum(['grant', 'revoke']);
export const ConnectorGrantRequest = z.object({
  connectorId: z.string().min(1).max(200),
  action: GrantAction,
  allowedTools: z.array(z.string().min(1).max(200)).max(200).default([]),
  reason: z.string().max(2000).default(''),
});
export type ConnectorGrantRequest = z.infer<typeof ConnectorGrantRequest>;

export const ConnectorGrantRecord = z.object({
  id: UUID,
  connectorId: z.string(),
  action: GrantAction,
  allowedTools: z.array(z.string()),
  reason: z.string(),
  createdBy: UUID,
  createdAt: z.iso.datetime({ offset: true }),
});
export type ConnectorGrantRecord = z.infer<typeof ConnectorGrantRecord>;

/**
 * MCP server registration request. CONNECT never ships a transport: `available: false` is the
 * only honest value until an owning integration supplies one (agent-core McpClientBoundary
 * requires an explicit transport and keeps externalCallsEnabled false by default).
 */
export const McpServerDescriptor = z.object({
  id: z.string().min(1).max(200),
  connectorId: z.string().min(1).max(200),
  allowedTools: z.array(z.string().min(1).max(200)).max(200),
  available: z.literal(false),
});
export type McpServerDescriptor = z.infer<typeof McpServerDescriptor>;

export const connectCapabilities = {
  catalog: defineCapability({
    id: 'connect.catalog.list',
    title: 'List connector catalog',
    description: 'Return every registered connector with its current honest state.',
    kind: 'read',
    permission: 'connect:catalog:read',
    input: ConnectorCatalogRequest,
    output: z.array(ConnectorRecord),
  }),
  grant: defineCapability({
    id: 'connect.connector.grant',
    title: 'Grant or revoke a connector',
    description: 'Record a grant or revocation decision for a connector in the append-only grant ledger.',
    kind: 'consequential',
    permission: 'connect:connector:grant',
    input: ConnectorGrantRequest,
    output: ConnectorGrantRecord,
  }),
};
