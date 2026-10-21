import { describe, expect, it } from 'vitest';
import { cycleOf, signalState, type SignalRuntime } from './signals.js';

const sig: SignalRuntime = { plan: { phases: [{ green: 20 }, { green: 16 }], offset: 0 }, mode: 'AUTO', holdPhase: 0 };
const three: SignalRuntime = { plan: { phases: [{ green: 20 }, { green: 15 }, { green: 10 }], offset: 0 }, mode: 'AUTO', holdPhase: 0 };

describe('signalState', () => {
  it('never shows two greens at once and follows the Serbian sequence', () => {
    const cycle = cycleOf(sig.plan);
    let prev = signalState(sig, -0.1).aspects[0];
    const seen: string[] = [];
    for (let t = 0; t < cycle * 2; t += 0.1) {
      const st = signalState(sig, t);
      expect(st.aspects.filter((a) => a === 'GREEN').length).toBeLessThanOrEqual(1);
      if (st.aspects[0] !== prev) seen.push(`${prev}>${st.aspects[0]}`);
      prev = st.aspects[0];
    }
    expect(seen).toContain('RED_AMBER>GREEN');
    expect(seen).toContain('GREEN>AMBER');
    expect(seen).toContain('AMBER>RED');
    expect(seen).not.toContain('RED>GREEN');
  });

  it('cycles through three phases with amber, all-red and red-amber between them', () => {
    expect(cycleOf(three.plan)).toBe(63);
    expect(signalState(three, 0).aspects).toEqual(['GREEN', 'RED', 'RED']);
    expect(signalState(three, 21).aspects).toEqual(['AMBER', 'RED', 'RED']);
    expect(signalState(three, 24).aspects).toEqual(['RED', 'RED_AMBER', 'RED']);
    expect(signalState(three, 27).aspects).toEqual(['RED', 'GREEN', 'RED']);
    expect(signalState(three, 45).aspects).toEqual(['RED', 'RED', 'RED_AMBER']);
    expect(signalState(three, 61).aspects).toEqual(['RED_AMBER', 'RED', 'RED']);
    expect(signalState(three, 0).left[0]).toBeCloseTo(20);
    expect(signalState(three, 0).left[1]).toBeCloseTo(24);
  });

  it('honours manual modes', () => {
    expect(signalState({ ...sig, mode: 'FLASHING' }, 5).aspects[0]).toBe('FLASHING');
    const held = signalState({ ...three, mode: 'HOLD', holdPhase: 1 }, 5);
    expect(held.aspects).toEqual(['RED', 'GREEN', 'RED']);
    expect(held.left.every((l) => l === Infinity)).toBe(true);
  });
});
