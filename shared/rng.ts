/**
 * Seeded pseudo-random numbers (mulberry32) whose state lives in the game
 * state, so a replay from the same state draws the same numbers.
 *
 * Only 32-bit integer operations (Math.imul, xor, shifts), which every
 * JavaScript engine computes identically. No Math.random anywhere in the
 * simulation.
 */
export function nextRandom(state: number): { value: number; state: number } {
    const s = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: s >>> 0 };
}

/** Normalises any number to a valid uint32 seed. */
export function seedFrom(seed: number): number {
    return (Math.trunc(seed) >>> 0) || 0x9e3779b9;
}
