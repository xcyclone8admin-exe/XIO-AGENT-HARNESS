import { ProviderError, type AiProvider, type ModelDescriptor, type ProviderRequest, type ProviderResponse, type RouteRequest } from './contracts';
import { retryOperation } from './providers';
import type { ProviderRegistry } from './providers';

const QUALITY_RANK = { basic: 0, standard: 1, high: 2 } as const;
const PRIVACY_RANK = { local: 0, contractual: 1, external: 2 } as const;

export interface RoutedProvider {
  readonly provider: AiProvider;
  readonly model: ModelDescriptor;
}

export class ModelRouter {
  constructor(private readonly registry: ProviderRegistry) {}

  candidates(request: RouteRequest): RoutedProvider[] {
    const candidates = [request.preferred, ...request.fallbacks];
    const seen = new Set<string>();
    const routed: RoutedProvider[] = [];
    for (const candidate of candidates) {
      const key = `${candidate.provider}\u0000${candidate.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const model = this.registry.getModel(candidate.provider, candidate.model);
      const provider = this.registry.getProvider(candidate.provider);
      if (!model || !provider || model.status !== 'available') continue;
      if (QUALITY_RANK[model.qualityTier] < QUALITY_RANK[request.qualityFloor]) continue;
      if (PRIVACY_RANK[model.privacyTier] > PRIVACY_RANK[request.privacyCeiling]) continue;
      if (!request.requiredCapabilities.every((capability) => model.capabilities.includes(capability))) continue;
      routed.push({ provider, model });
    }
    return routed;
  }

  async complete(
    request: RouteRequest,
    buildRequest: (model: ModelDescriptor) => ProviderRequest,
    hooks?: { readonly onRetry?: (provider: string, retry: number) => void; readonly onFallback?: (provider: string) => void },
  ): Promise<{ readonly response: ProviderResponse; readonly routed: RoutedProvider }> {
    const candidates = this.candidates(request);
    if (candidates.length === 0) throw new ProviderError('UNAVAILABLE', 'No compatible provider route is available', false);
    let lastError: unknown;
    for (let index = 0; index < candidates.length; index += 1) {
      const routed = candidates[index];
      if (!routed) continue;
      let signal: AbortSignal | undefined;
      try {
        const response = await retryOperation(
          () => {
            const providerRequest = buildRequest(routed.model);
            signal = providerRequest.signal;
            if (signal.aborted) throw new ProviderError('CANCELED', 'Provider call canceled', false);
            return routed.provider.complete(providerRequest);
          },
          {
            shouldRetry: (error) => !signal?.aborted && error instanceof ProviderError && error.retryable,
            onRetry: (retry) => hooks?.onRetry?.(routed.provider.id, retry),
          },
        );
        return { response, routed };
      } catch (error) {
        // Cancellation, kill switch, and deadline exhaustion are terminal: never fall back.
        if (signal?.aborted) throw new ProviderError('CANCELED', 'Provider call canceled', false);
        lastError = error;
        if (index < candidates.length - 1) hooks?.onFallback?.(routed.provider.id);
      }
    }
    throw lastError instanceof Error ? lastError : new ProviderError('UNAVAILABLE', 'All provider routes failed', false);
  }
}
