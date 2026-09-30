import { AdapterConfig } from '../contracts';

/** Optional external factory adapter registry. C1 forces every adapter to remain disabled. */
export class FactoryAdapters {
  private readonly adapters = new Map<string, ReturnType<typeof AdapterConfig.parse>>();

  register(input: unknown) {
    const adapter = AdapterConfig.parse(input);
    if (adapter.enabled) throw new Error('EXTERNAL_ADAPTERS_DISABLED_BY_C1');
    this.adapters.set(adapter.id, adapter);
    return adapter;
  }

  list() { return [...this.adapters.values()].sort((a, b) => a.id.localeCompare(b.id)); }
}
