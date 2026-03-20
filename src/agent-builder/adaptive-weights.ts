/**
 * Adaptive Weight System v2 — Dual-memory with anti-overfitting.
 *
 * Two memory windows:
 * - Short-term (last 20 trades): responsive to recent conditions
 * - Long-term (last 100+ trades): stable, prevents overfitting
 * - Final weight = blend of both (60% long-term, 40% short-term)
 *
 * This prevents the system from overreacting to a few lucky/unlucky trades.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WeightState {
  name: string;
  weight: number;
  baseWeight: number;
  /** Short-term accuracy (last ~20 trades) */
  shortTermAccuracy: number;
  /** Long-term accuracy (last ~100 trades) */
  longTermAccuracy: number;
  /** Blended accuracy */
  accuracy: number;
  shortTermPredictions: number;
  shortTermCorrect: number;
  longTermPredictions: number;
  longTermCorrect: number;
}

// ─── Adaptive Weights ────────────────────────────────────────────────────────

export class AdaptiveWeights {
  private weights: Map<string, WeightState> = new Map();
  private readonly shortDecay = 0.92;  // Fast decay — responsive
  private readonly longDecay = 0.98;   // Slow decay — stable
  private readonly shortBlend = 0.40;  // 40% short-term influence
  private readonly longBlend = 0.60;   // 60% long-term influence
  private readonly minWeight = 0.05;
  private readonly maxWeight = 0.45;

  constructor(initialWeights: Record<string, number>) {
    for (const [name, weight] of Object.entries(initialWeights)) {
      this.weights.set(name, {
        name, weight, baseWeight: weight,
        shortTermAccuracy: 0.5, longTermAccuracy: 0.5, accuracy: 0.5,
        shortTermPredictions: 0, shortTermCorrect: 0,
        longTermPredictions: 0, longTermCorrect: 0,
      });
    }
  }

  get(name: string): number {
    return this.weights.get(name)?.weight ?? 0;
  }

  getAll(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [name, state] of this.weights) {
      result[name] = state.weight;
    }
    return result;
  }

  /**
   * Record outcome — updates both short and long term memory.
   */
  recordOutcome(factorName: string, wasCorrect: boolean): void {
    const state = this.weights.get(factorName);
    if (!state) return;

    // Short-term memory (fast decay)
    state.shortTermCorrect = state.shortTermCorrect * this.shortDecay + (wasCorrect ? 1 : 0);
    state.shortTermPredictions = state.shortTermPredictions * this.shortDecay + 1;
    state.shortTermAccuracy = state.shortTermPredictions > 0
      ? state.shortTermCorrect / state.shortTermPredictions : 0.5;

    // Long-term memory (slow decay)
    state.longTermCorrect = state.longTermCorrect * this.longDecay + (wasCorrect ? 1 : 0);
    state.longTermPredictions = state.longTermPredictions * this.longDecay + 1;
    state.longTermAccuracy = state.longTermPredictions > 0
      ? state.longTermCorrect / state.longTermPredictions : 0.5;

    // Blend: 60% long-term + 40% short-term
    state.accuracy = state.longTermAccuracy * this.longBlend + state.shortTermAccuracy * this.shortBlend;

    // Weight adjustment: accuracy 0.5 = base, higher = more weight
    const multiplier = 0.4 + state.accuracy * 1.2; // 0.4 to 1.6
    state.weight = state.baseWeight * multiplier;
    state.weight = Math.max(this.minWeight, Math.min(this.maxWeight, state.weight));

    this.normalize();
  }

  private normalize(): void {
    let total = 0;
    for (const state of this.weights.values()) total += state.weight;
    if (total <= 0) return;
    for (const state of this.weights.values()) state.weight /= total;
  }

  getStates(): WeightState[] {
    return Array.from(this.weights.values());
  }

  // ─── Serialization ──────────────────────────────────────────────────

  serialize(): WeightState[] {
    return Array.from(this.weights.values()).map(s => ({ ...s }));
  }

  restore(data: WeightState[]): void {
    if (!Array.isArray(data)) return;
    for (const s of data) {
      const existing = this.weights.get(s.name);
      if (existing) {
        existing.weight = Number.isFinite(s.weight) ? s.weight : existing.baseWeight;
        existing.shortTermAccuracy = Number.isFinite(s.shortTermAccuracy) ? s.shortTermAccuracy : 0.5;
        existing.longTermAccuracy = Number.isFinite(s.longTermAccuracy) ? s.longTermAccuracy : 0.5;
        existing.accuracy = Number.isFinite(s.accuracy) ? s.accuracy : 0.5;
        existing.shortTermPredictions = Number.isFinite(s.shortTermPredictions) ? s.shortTermPredictions : 0;
        existing.shortTermCorrect = Number.isFinite(s.shortTermCorrect) ? s.shortTermCorrect : 0;
        existing.longTermPredictions = Number.isFinite(s.longTermPredictions) ? s.longTermPredictions : 0;
        existing.longTermCorrect = Number.isFinite(s.longTermCorrect) ? s.longTermCorrect : 0;
      }
    }
    this.normalize();
  }

  reset(): void {
    for (const state of this.weights.values()) {
      state.weight = state.baseWeight;
      state.shortTermAccuracy = 0.5;
      state.longTermAccuracy = 0.5;
      state.accuracy = 0.5;
      state.shortTermPredictions = 0;
      state.shortTermCorrect = 0;
      state.longTermPredictions = 0;
      state.longTermCorrect = 0;
    }
    this.normalize();
  }
}
