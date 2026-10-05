import type { NetworkConditions } from "./NetworkSimulator.ts";

/**
 * The lab's presets. These are the conditions the simulator applies, chosen
 * to be typical of each situation; they are settings, not measurements.
 */
export const PRESETS = {
    perfect: { label: "Perfect (LAN)", conditions: { latencyMs: 0, jitterMs: 0, loss: 0 } },
    sameCity: { label: "Same city", conditions: { latencyMs: 20, jitterMs: 4, loss: 0 } },
    acrossCountry: { label: "Across the country", conditions: { latencyMs: 80, jitterMs: 10, loss: 0.005 } },
    badWifi: { label: "Bad Wi-Fi", conditions: { latencyMs: 60, jitterMs: 60, loss: 0.08 } },
    satellite: { label: "Satellite", conditions: { latencyMs: 500, jitterMs: 40, loss: 0.02 } },
} as const satisfies Record<string, { label: string; conditions: NetworkConditions }>;

export type PresetName = keyof typeof PRESETS;
