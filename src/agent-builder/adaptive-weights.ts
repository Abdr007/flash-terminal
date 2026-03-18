/**
 * Adaptive Weight System — Weights that learn from outcomes.
 *
 * Each scoring factor tracks its predictive accuracy. Factors that
 * predicted correctly get more weight. Factors that failed get less.
 * Weights are normalized to sum to 1.0 after every adjustment.
 *
 * Uses exponential decay — recent trades weighted 2x vs older ones.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WeightState {
  name: string;
  /** Current adaptive weight */
  weight: number;
  /** Base weight (starting point) */
  baseWeight: number;
  /** Rolling accuracy (0-1) */
  accuracy: number;
  /** Total predictions tracked */
  predictions: number;
  /** Correct predictions */
  correct: number;
}

// ─── Adaptive Weights ────────────────────────────────────────────────────────

export class AdaptiveWeights {
  private weights: Map<string, WeightState> = new Map();
  private readonly decayFactor = 0.95; // Recent data weighted higher
  private readonly minWeight = 0.05;
  private readonly maxWeight = 0.45;

  constructor(initialWeights: Record<string, number>) {
    for (const [name, weight] of Object.entries(initialWeights)) {
      this.weights.set(name, {
        name,
        weight,
        baseWeight: weight,
        accuracy: 0.5, // Start neutral
        predictions: 0,
        correct: 0,
      });
    }
  }

  /**
   * Get current weight for a factor.
   */
  get(name: string): number {
    return this.weights.get(name)?.weight ?? 0;
  }

  /**
   * Get all weights as a record.
   */
  getAll(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [name, state] of this.weights) {
      result[name] = state.weight;
    }
    return result;
  }

  /**
   * Record whether a factor's prediction was correct after a trade.
   * Adjusts weight based on rolling accuracy.
   */
  recordOutcome(factorName: string, wasCorrect: boolean): void {
    const state = this.weights.get(factorName);
    if (!state) return;

    // Exponential decay: reduce old data influence
    state.correct = state.correct * this.decayFactor + (wasCorrect ? 1 : 0);
    state.predictions = state.predictions * this.decayFactor + 1;

    // Update accuracy
    state.accuracy = state.predictions > 0 ? state.correct / state.predictions : 0.5;

    // Adjust weight: accuracy 0.5 = base weight, 0.7 = 1.4x, 0.3 = 0.6x
    const accuracyMultiplier = 0.4 + state.accuracy * 1.2; // Range: 0.4 to 1.6
    state.weight = state.baseWeight * accuracyMultiplier;

    // Clamp
    state.weight = Math.max(this.minWeight, Math.min(this.maxWeight, state.weight));

    // Normalize all weights to sum to 1.0
    this.normalize();
  }

  /**
   * Normalize weights so they sum to 1.0.
   */
  private normalize(): void {
    let total = 0;
    for (const state of this.weights.values()) {
      total += state.weight;
    }
    if (total <= 0) return;
    for (const state of this.weights.values()) {
      state.weight = state.weight / total;
    }
  }

  /**
   * Get factor states for reporting.
   */
  getStates(): WeightState[] {
    return Array.from(this.weights.values());
  }

  reset(): void {
    for (const state of this.weights.values()) {
      state.weight = state.baseWeight;
      state.accuracy = 0.5;
      state.predictions = 0;
      state.correct = 0;
    }
    this.normalize();
  }
}
