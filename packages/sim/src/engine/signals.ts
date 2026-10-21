import type { LightAspect, LightMode } from '@kolo/contracts';
import type { Axis, SignalPlan } from '../city/types.js';

export const AMBER = 3;
export const ALL_RED = 1;
export const RED_AMBER = 2;
/** Seconds added to the two greens to get the full cycle. */
export const CYCLE_OVERHEAD = 2 * (AMBER + ALL_RED + RED_AMBER);

export interface SignalRuntime {
  plan: SignalPlan;
  mode: LightMode;
}

export interface SignalState {
  ns: LightAspect;
  ew: LightAspect;
  /** Seconds until the NS / EW aspect changes (Infinity when held). */
  nsLeft: number;
  ewLeft: number;
}

export const cycleOf = (plan: SignalPlan) => plan.greenNs + plan.greenEw + CYCLE_OVERHEAD;

/**
 * Serbian signal sequence for a two-phase junction:
 * GREEN → AMBER → (all red) → RED_AMBER on the crossing axis → its GREEN, and so on.
 */
export function signalState(sig: SignalRuntime, t: number): SignalState {
  if (sig.mode === 'FLASHING') return { ns: 'FLASHING', ew: 'FLASHING', nsLeft: Infinity, ewLeft: Infinity };
  if (sig.mode === 'HOLD_NS') return { ns: 'GREEN', ew: 'RED', nsLeft: Infinity, ewLeft: Infinity };
  if (sig.mode === 'HOLD_EW') return { ns: 'RED', ew: 'GREEN', nsLeft: Infinity, ewLeft: Infinity };
  const { greenNs: gn, greenEw: ge, offset } = sig.plan;
  const cycle = cycleOf(sig.plan);
  const tc = (((t + offset) % cycle) + cycle) % cycle;
  // Phase boundaries.
  const nsAmber = gn;
  const allRed1 = nsAmber + AMBER;
  const ewRedAmber = allRed1 + ALL_RED;
  const ewGreen = ewRedAmber + RED_AMBER;
  const ewAmber = ewGreen + ge;
  const allRed2 = ewAmber + AMBER;
  const nsRedAmber = allRed2 + ALL_RED;
  const nsGreenNext = cycle;

  let ns: LightAspect;
  let ew: LightAspect;
  let nsLeft: number;
  let ewLeft: number;
  if (tc < nsAmber) {
    ns = 'GREEN';
    nsLeft = nsAmber - tc;
  } else if (tc < allRed1) {
    ns = 'AMBER';
    nsLeft = allRed1 - tc;
  } else if (tc < nsRedAmber) {
    ns = 'RED';
    nsLeft = nsRedAmber - tc;
  } else {
    ns = 'RED_AMBER';
    nsLeft = nsGreenNext - tc;
  }
  if (tc < ewRedAmber) {
    ew = 'RED';
    ewLeft = ewRedAmber - tc;
  } else if (tc < ewGreen) {
    ew = 'RED_AMBER';
    ewLeft = ewGreen - tc;
  } else if (tc < ewAmber) {
    ew = 'GREEN';
    ewLeft = ewAmber - tc;
  } else if (tc < allRed2) {
    ew = 'AMBER';
    ewLeft = allRed2 - tc;
  } else {
    ew = 'RED';
    ewLeft = cycle - tc + ewRedAmber;
  }
  return { ns, ew, nsLeft, ewLeft };
}

export const aspectFor = (state: SignalState, axis: Axis) => (axis === 'NS' ? state.ns : state.ew);
