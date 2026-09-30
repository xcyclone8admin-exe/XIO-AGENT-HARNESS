import type { AgentProfile, RuntimeConfiguration, RuntimeConfigurationOverride } from './contracts';

/** Run > ticket/Epic > project > workspace > role default > system fallback, field by field. */
export function resolveRuntimeConfiguration(input: {
  readonly system: RuntimeConfiguration;
  readonly role: AgentProfile;
  readonly workspace?: RuntimeConfigurationOverride;
  readonly project?: RuntimeConfigurationOverride;
  readonly ticket?: RuntimeConfigurationOverride;
  readonly run?: RuntimeConfigurationOverride;
}): RuntimeConfiguration {
  const role: RuntimeConfigurationOverride = {
    provider: input.role.defaultProvider,
    model: input.role.defaultModel,
    fallbacks: input.role.fallbacks,
    instructions: input.role.charter,
  };
  return mergeConfiguration(input.system, role, input.workspace, input.project, input.ticket, input.run);
}

function mergeConfiguration(base: RuntimeConfiguration, ...overrides: Array<RuntimeConfigurationOverride | undefined>): RuntimeConfiguration {
  return overrides.reduce<RuntimeConfiguration>(
    (current, override) => ({
      provider: override?.provider ?? current.provider,
      model: override?.model ?? current.model,
      fallbacks: override?.fallbacks ?? current.fallbacks,
      instructions: override?.instructions ?? current.instructions,
    }),
    base,
  );
}
