import type { LightAspect, LightMode } from '@kolo/contracts';
import type { SignalPlan } from '../city/types.js';

export const AMBER = 3;
export const ALL_RED = 1;
export const RED_AMBER = 2;
/** Seconds each phase change adds to the cycle. */
export const TRANSITION = AMBER + ALL_RED + RED_AMBER;

export interface SignalRuntime {
  plan: SignalPlan;
  mode: LightMode;
  /** Phase kept green in HOLD mode. */
  holdPhase: number;
}

export interface SignalState {
  /** Aspect of every phase, indexed like plan.phases. */
  aspects: LightAspect[];
  /** Seconds until each phase's aspect changes (Infinity when held). */
  left: number[];
}

export const cycleOf = (plan: SignalPlan) => plan.phases.reduce((a, p) => a + p.green + TRANSITION, 0);

/**
 * Serbian signal sequence over phases served in turn:
 * GREEN → AMBER → (all red) → RED_AMBER on the next phase → its GREEN, and so on around the cycle.
 */
export function signalState(sig: SignalRuntime, t: number): SignalState {
  const n = sig.plan.phases.length;
  if (sig.mode === 'FLASHING') return { aspects: Array(n).fill('FLASHING'), left: Array(n).fill(Infinity) };
  if (sig.mode === 'HOLD') {
    return { aspects: sig.plan.phases.map((_, i) => (i === sig.holdPhase ? 'GREEN' : 'RED')), left: Array(n).fill(Infinity) };
  }
  const cycle = cycleOf(sig.plan);
  const tc = (((t + sig.plan.offset) % cycle) + cycle) % cycle;
  const aspects: LightAspect[] = [];
  const left: number[] = [];
  let greenStart = 0;
  for (const { green } of sig.plan.phases) {
    const rel = (((tc - greenStart) % cycle) + cycle) % cycle;
    if (rel < green) {
      aspects.push('GREEN');
      left.push(green - rel);
    } else if (rel < green + AMBER) {
      aspects.push('AMBER');
      left.push(green + AMBER - rel);
    } else if (rel >= cycle - RED_AMBER) {
      aspects.push('RED_AMBER');
      left.push(cycle - rel);
    } else {
      aspects.push('RED');
      left.push(cycle - RED_AMBER - rel);
    }
    greenStart += green + TRANSITION;
  }
  return { aspects, left };
}

export const isFlashing = (state: SignalState | null | undefined) => !state || state.aspects[0] === 'FLASHING';
