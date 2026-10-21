import { describe, expect, it } from 'vitest';
import { cycleOf, signalState, type SignalRuntime } from './signals.js';

const sig: SignalRuntime = { plan: { greenNs: 20, greenEw: 16, offset: 0 }, mode: 'AUTO' };

describe('signalState', () => {
  it('never shows green on both axes and follows the Serbian sequence', () => {
    const cycle = cycleOf(sig.plan);
    let prevNs = signalState(sig, -0.1).ns;
    const seen: string[] = [];
    for (let t = 0; t < cycle * 2; t += 0.1) {
      const st = signalState(sig, t);
      expect(st.ns === 'GREEN' && st.ew === 'GREEN').toBe(false);
      if (st.ns !== prevNs) seen.push(`${prevNs}>${st.ns}`);
      prevNs = st.ns;
    }
    expect(seen).toContain('RED_AMBER>GREEN');
    expect(seen).toContain('GREEN>AMBER');
    expect(seen).toContain('AMBER>RED');
    expect(seen).not.toContain('RED>GREEN');
  });

  it('honours manual modes', () => {
    expect(signalState({ ...sig, mode: 'FLASHING' }, 5).ns).toBe('FLASHING');
    expect(signalState({ ...sig, mode: 'HOLD_EW' }, 5)).toMatchObject({ ns: 'RED', ew: 'GREEN' });
  });
});
