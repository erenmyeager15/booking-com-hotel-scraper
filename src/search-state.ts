import type { SearchState } from './types.js';

/** Crawlee serializes userData. Rejoin those copies to one live state per search. */
export class SearchStateRegistry {
  private readonly states = new Map<string, SearchState>();

  restore(candidate: SearchState): SearchState {
    const key = candidate.requestNamespace ?? candidate.destination;
    const existing = this.states.get(key);
    if (existing) return existing;
    this.states.set(key, candidate);
    return candidate;
  }
}

const registry = new SearchStateRegistry();
export const restoreSearchState = (state: SearchState): SearchState => registry.restore(state);
