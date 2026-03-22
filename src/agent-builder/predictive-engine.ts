/**
 * Micro-Prediction Engine
 *
 * Predicts the probability of significant price moves in the next 5-10 seconds
 * by combining price velocity/acceleration, OI momentum, and volume surge signals.
 *
 * Zero external dependencies. Uses Float64Array circular buffers for hot-path performance.
 */

import type { MarketSnapshot } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_MARKETS = 50;
const BUFFER_SIZE = 20;
const VELOCITY_WINDOW = 5;
const ACCURACY_HISTORY = 100;

/** Weights for the composite score */
const W_VELOCITY = 1.2;
const W_ACCELERATION = 0.8;
const W_OI_MOMENTUM = 0.6;
const W_VOLUME_SURGE = 0.4;

// ─── Types ──────────────────────────────────────────────────────────────────

export type PredictionDirection = 'up' | 'down' | 'neutral';

export interface Prediction {
  /** Probability of a significant move (0-1) */
  probability: number;
  /** Predicted direction */
  direction: PredictionDirection;
  /** Confidence in the prediction (0-1) */
  confidence: number;
  /** Price velocity (rate of change) */
  velocity: number;
  /** Price acceleration (velocity delta) */
  acceleration: number;
}

export type PrePositionUrgency = 'immediate' | 'soon' | 'none';

export interface PrePositionSignal {
  /** Whether to pre-position */
  prePosition: boolean;
  /** Predicted direction */
  direction: PredictionDirection;
  /** Confidence in the signal (0-1) */
  confidence: number;
  /** Urgency level */
  urgency: PrePositionUrgency;
}

export interface PredictionMetrics {
  /** Total predictions made */
  totalPredictions: number;
  /** Predictions that were validated */
  validatedPredictions: number;
  /** Correct predictions (direction matched) */
  correctPredictions: number;
  /** Accuracy as a ratio (0-1) */
  accuracy: number;
  /** Average confidence of correct predictions */
  avgCorrectConfidence: number;
  /** Average confidence of incorrect predictions */
  avgIncorrectConfidence: number;
  /** Per-market accuracy breakdown */
  marketAccuracy: Map<string, { correct: number; total: number; accuracy: number }>;
}

// ─── Circular Buffer ────────────────────────────────────────────────────────

class CircularFloat64Buffer {
  private readonly data: Float64Array;
  private head: number = 0;
  private count: number = 0;
  public readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.data = new Float64Array(capacity);
  }

  push(value: number): void {
    if (!Number.isFinite(value)) return;
    this.data[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Get value at logical index (0 = oldest, count-1 = newest) */
  get(index: number): number {
    if (index < 0 || index >= this.count) return 0;
    const realIdx = (this.head - this.count + index + this.capacity) % this.capacity;
    return this.data[realIdx];
  }

  /** Get the most recent value */
  latest(): number {
    if (this.count === 0) return 0;
    return this.data[(this.head - 1 + this.capacity) % this.capacity];
  }

  /** Get the Nth most recent value (0 = latest) */
  recent(n: number): number {
    if (n < 0 || n >= this.count) return 0;
    return this.data[(this.head - 1 - n + this.capacity * 2) % this.capacity];
  }

  size(): number {
    return this.count;
  }

  clear(): void {
    this.data.fill(0);
    this.head = 0;
    this.count = 0;
  }
}

// ─── Market Data Store ──────────────────────────────────────────────────────

interface MarketBuffers {
  prices: CircularFloat64Buffer;
  oiRatios: CircularFloat64Buffer;
  volumes: CircularFloat64Buffer;
  timestamps: CircularFloat64Buffer;
}

interface PendingPrediction {
  timestamp: number;
  direction: PredictionDirection;
  confidence: number;
  priceAtPrediction: number;
}

interface AccuracyRecord {
  correct: boolean;
  confidence: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function safeNum(v: number, fallback: number = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

// ─── Predictive Engine ──────────────────────────────────────────────────────

export class PredictiveEngine {
  private readonly buffers = new Map<string, MarketBuffers>();
  private readonly pending = new Map<string, PendingPrediction>();
  private readonly accuracyHistory = new Map<string, AccuracyRecord[]>();
  private totalPredictions = 0;
  private validatedPredictions = 0;
  private correctPredictions = 0;
  private correctConfidenceSum = 0;
  private incorrectConfidenceSum = 0;

  // ── Data Recording ──────────────────────────────────────────────────────

  /**
   * Record a new tick of market data.
   * Creates buffers for the market if it doesn't exist (up to MAX_MARKETS).
   */
  record(market: string, price: number, oiRatio: number, volume: number): void {
    if (!Number.isFinite(price) || !Number.isFinite(oiRatio) || !Number.isFinite(volume)) {
      return;
    }

    let mb = this.buffers.get(market);
    if (!mb) {
      if (this.buffers.size >= MAX_MARKETS) return;
      mb = {
        prices: new CircularFloat64Buffer(BUFFER_SIZE),
        oiRatios: new CircularFloat64Buffer(BUFFER_SIZE),
        volumes: new CircularFloat64Buffer(BUFFER_SIZE),
        timestamps: new CircularFloat64Buffer(BUFFER_SIZE),
      };
      this.buffers.set(market, mb);
    }

    mb.prices.push(price);
    mb.oiRatios.push(oiRatio);
    mb.volumes.push(volume);
    mb.timestamps.push(Date.now());
  }

  /**
   * Convenience method to record from a MarketSnapshot.
   */
  recordSnapshot(snapshot: MarketSnapshot): void {
    this.record(snapshot.market, snapshot.price, snapshot.oiRatio, snapshot.volume24h);
  }

  // ── Prediction ──────────────────────────────────────────────────────────

  /**
   * Predict the probability and direction of a significant price move.
   * Requires at least 3 ticks of data to produce a meaningful prediction.
   */
  predict(market: string): Prediction {
    const neutral: Prediction = {
      probability: 0,
      direction: 'neutral',
      confidence: 0,
      velocity: 0,
      acceleration: 0,
    };

    const mb = this.buffers.get(market);
    if (!mb || mb.prices.size() < 3) return neutral;

    const velocity = this.computeVelocity(mb.prices);
    const acceleration = this.computeAcceleration(mb.prices);
    const oiMomentum = this.computeOiMomentum(mb.oiRatios);
    const volumeSurge = this.computeVolumeSurge(mb.volumes);

    const compositeScore =
      W_VELOCITY * velocity +
      W_ACCELERATION * acceleration +
      W_OI_MOMENTUM * oiMomentum +
      W_VOLUME_SURGE * volumeSurge;

    const _rawProb = safeNum(sigmoid(compositeScore * 10) * 2 - 1, 0);
    // Map composite score to [0, 1] probability via sigmoid
    const clampedProbability = Math.max(0, Math.min(1, sigmoid(Math.abs(compositeScore) * 5)));

    let direction: PredictionDirection;
    if (compositeScore > 0.001) {
      direction = 'up';
    } else if (compositeScore < -0.001) {
      direction = 'down';
    } else {
      direction = 'neutral';
    }

    // Confidence is based on signal agreement and magnitude
    const signalAgreement = this.computeSignalAgreement(velocity, acceleration, oiMomentum, volumeSurge);
    const magnitude = Math.min(1, Math.abs(compositeScore) * 3);
    const confidence = safeNum(Math.max(0, Math.min(1, signalAgreement * 0.6 + magnitude * 0.4)), 0);

    // Store as pending prediction for later validation
    const latestPrice = mb.prices.latest();
    if (direction !== 'neutral' && Number.isFinite(latestPrice) && latestPrice > 0) {
      this.pending.set(market, {
        timestamp: Date.now(),
        direction,
        confidence,
        priceAtPrediction: latestPrice,
      });
      this.totalPredictions++;
    }

    return {
      probability: safeNum(clampedProbability, 0),
      direction,
      confidence,
      velocity: safeNum(velocity, 0),
      acceleration: safeNum(acceleration, 0),
    };
  }

  // ── Pre-Positioning ─────────────────────────────────────────────────────

  /**
   * Determine whether to pre-position for an anticipated move.
   */
  shouldPrePosition(market: string, threshold: number = 0.65): PrePositionSignal {
    const noSignal: PrePositionSignal = {
      prePosition: false,
      direction: 'neutral',
      confidence: 0,
      urgency: 'none',
    };

    const prediction = this.predict(market);

    if (prediction.direction === 'neutral' || prediction.probability < threshold) {
      return noSignal;
    }

    let urgency: PrePositionUrgency;
    if (prediction.probability > 0.8) {
      urgency = 'immediate';
    } else if (prediction.probability > threshold) {
      urgency = 'soon';
    } else {
      urgency = 'none';
    }

    return {
      prePosition: true,
      direction: prediction.direction,
      confidence: prediction.confidence,
      urgency,
    };
  }

  // ── Validation & Accuracy ───────────────────────────────────────────────

  /**
   * Validate a previous prediction against the actual price.
   * Call this after the prediction window (5-10 seconds) has elapsed.
   * Returns true if the prediction was correct.
   */
  validatePrediction(market: string, actualPrice: number): boolean | null {
    if (!Number.isFinite(actualPrice) || actualPrice <= 0) return null;

    const pred = this.pending.get(market);
    if (!pred) return null;

    this.pending.delete(market);

    const priceChange = (actualPrice - pred.priceAtPrediction) / pred.priceAtPrediction;
    const MOVE_THRESHOLD = 0.0001; // 0.01% minimum move to count

    let correct: boolean;
    if (Math.abs(priceChange) < MOVE_THRESHOLD) {
      // Price didn't move enough to validate — count as incorrect if we predicted a move
      correct = false;
    } else if (pred.direction === 'up') {
      correct = priceChange > 0;
    } else if (pred.direction === 'down') {
      correct = priceChange < 0;
    } else {
      return null;
    }

    this.validatedPredictions++;
    if (correct) {
      this.correctPredictions++;
      this.correctConfidenceSum += pred.confidence;
    } else {
      this.incorrectConfidenceSum += pred.confidence;
    }

    // Per-market accuracy
    if (!this.accuracyHistory.has(market)) {
      this.accuracyHistory.set(market, []);
    }
    const history = this.accuracyHistory.get(market)!;
    history.push({ correct, confidence: pred.confidence });
    if (history.length > ACCURACY_HISTORY) {
      history.shift();
    }

    return correct;
  }

  // ── Metrics ─────────────────────────────────────────────────────────────

  /**
   * Get prediction accuracy metrics.
   */
  getMetrics(): PredictionMetrics {
    const incorrectCount = this.validatedPredictions - this.correctPredictions;
    const marketAccuracy = new Map<string, { correct: number; total: number; accuracy: number }>();

    for (const [market, records] of this.accuracyHistory) {
      const total = records.length;
      const correct = records.filter(r => r.correct).length;
      marketAccuracy.set(market, {
        correct,
        total,
        accuracy: total > 0 ? safeNum(correct / total, 0) : 0,
      });
    }

    return {
      totalPredictions: this.totalPredictions,
      validatedPredictions: this.validatedPredictions,
      correctPredictions: this.correctPredictions,
      accuracy: this.validatedPredictions > 0
        ? safeNum(this.correctPredictions / this.validatedPredictions, 0)
        : 0,
      avgCorrectConfidence: this.correctPredictions > 0
        ? safeNum(this.correctConfidenceSum / this.correctPredictions, 0)
        : 0,
      avgIncorrectConfidence: incorrectCount > 0
        ? safeNum(this.incorrectConfidenceSum / incorrectCount, 0)
        : 0,
      marketAccuracy,
    };
  }

  // ── Reset ───────────────────────────────────────────────────────────────

  /**
   * Reset all state — buffers, pending predictions, and accuracy history.
   */
  reset(): void {
    for (const mb of this.buffers.values()) {
      mb.prices.clear();
      mb.oiRatios.clear();
      mb.volumes.clear();
      mb.timestamps.clear();
    }
    this.buffers.clear();
    this.pending.clear();
    this.accuracyHistory.clear();
    this.totalPredictions = 0;
    this.validatedPredictions = 0;
    this.correctPredictions = 0;
    this.correctConfidenceSum = 0;
    this.incorrectConfidenceSum = 0;
  }

  // ── Internal Computations ───────────────────────────────────────────────

  /**
   * Weighted average of last N price deltas (recent deltas weighted 2x).
   * Returns normalized velocity as fraction of current price.
   */
  private computeVelocity(prices: CircularFloat64Buffer): number {
    const n = Math.min(VELOCITY_WINDOW, prices.size() - 1);
    if (n < 1) return 0;

    const currentPrice = prices.latest();
    if (!Number.isFinite(currentPrice) || currentPrice === 0) return 0;

    let weightedSum = 0;
    let weightTotal = 0;

    for (let i = 0; i < n; i++) {
      const newer = prices.recent(i);
      const older = prices.recent(i + 1);
      if (!Number.isFinite(newer) || !Number.isFinite(older) || older === 0) continue;

      const delta = (newer - older) / older;
      // Recent deltas get 2x weight (linear decay from 2.0 to 1.0)
      const weight = 2.0 - (i / Math.max(1, n - 1));
      weightedSum += delta * weight;
      weightTotal += weight;
    }

    if (weightTotal === 0) return 0;
    return safeNum(weightedSum / weightTotal, 0);
  }

  /**
   * Acceleration = change in velocity.
   * Computes velocity of the first half vs second half of recent prices.
   */
  private computeAcceleration(prices: CircularFloat64Buffer): number {
    const size = prices.size();
    if (size < 5) return 0;

    // Recent velocity: last 3 ticks
    const v1Newer = prices.recent(0);
    const v1Older = prices.recent(2);
    if (!Number.isFinite(v1Newer) || !Number.isFinite(v1Older) || v1Older === 0) return 0;
    const recentVelocity = (v1Newer - v1Older) / v1Older;

    // Earlier velocity: ticks 3-5
    const offset = Math.min(3, size - 3);
    const v2Newer = prices.recent(offset);
    const v2Older = prices.recent(offset + 2 < size ? offset + 2 : size - 1);
    if (!Number.isFinite(v2Newer) || !Number.isFinite(v2Older) || v2Older === 0) return 0;
    const earlierVelocity = (v2Newer - v2Older) / v2Older;

    return safeNum(recentVelocity - earlierVelocity, 0);
  }

  /**
   * OI ratio momentum: rate of change in long/short OI ratio.
   * Positive = increasing long pressure, negative = increasing short pressure.
   */
  private computeOiMomentum(oiRatios: CircularFloat64Buffer): number {
    const n = Math.min(VELOCITY_WINDOW, oiRatios.size() - 1);
    if (n < 1) return 0;

    let totalDelta = 0;
    let count = 0;

    for (let i = 0; i < n; i++) {
      const newer = oiRatios.recent(i);
      const older = oiRatios.recent(i + 1);
      if (!Number.isFinite(newer) || !Number.isFinite(older)) continue;
      totalDelta += newer - older;
      count++;
    }

    if (count === 0) return 0;
    return safeNum(totalDelta / count, 0);
  }

  /**
   * Volume surge: ratio of most recent volume to the rolling average.
   * Returns 0 if no surge, positive values indicate surge magnitude.
   */
  private computeVolumeSurge(volumes: CircularFloat64Buffer): number {
    const size = volumes.size();
    if (size < 3) return 0;

    const latest = volumes.latest();
    if (!Number.isFinite(latest) || latest <= 0) return 0;

    // Compute rolling average excluding the latest value
    let sum = 0;
    let count = 0;
    for (let i = 1; i < size; i++) {
      const v = volumes.recent(i);
      if (Number.isFinite(v) && v > 0) {
        sum += v;
        count++;
      }
    }

    if (count === 0 || sum === 0) return 0;
    const avg = sum / count;
    // Surge ratio: how much above average (0 = at average, 1 = 2x average)
    const surge = (latest - avg) / avg;
    return safeNum(surge, 0);
  }

  /**
   * Compute how much signals agree in direction.
   * Returns 0-1 where 1 = all signals agree strongly.
   */
  private computeSignalAgreement(
    velocity: number,
    acceleration: number,
    oiMomentum: number,
    volumeSurge: number,
  ): number {
    const signals = [velocity, acceleration, oiMomentum];
    const signs = signals.map(s => Math.sign(s));

    // Count how many agree with the majority direction
    const positives = signs.filter(s => s > 0).length;
    const negatives = signs.filter(s => s < 0).length;
    const majorityCount = Math.max(positives, negatives);
    const directionAgreement = majorityCount / signals.length;

    // Volume surge boosts confidence regardless of direction
    const volumeBoost = Math.min(0.2, Math.max(0, volumeSurge) * 0.1);

    return safeNum(Math.min(1, directionAgreement + volumeBoost), 0);
  }
}
