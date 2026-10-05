import { describe, expect, it } from "vitest";
import { INPUT_LEVELS } from "../../shared/constants.ts";
import {
    MAX_COMMANDS_PER_PACKET,
    decodeSnapshot,
    encodeSnapshot,
    normalizeRoomCode,
    parseSnapshot,
    validateClientEvent,
} from "../../shared/protocol.ts";
import { createInitialState } from "../../shared/state.ts";
import { step } from "../../shared/step.ts";

describe("snapshots", () => {
    it("round-trip through JSON with every value bit-identical", () => {
        let s = createInitialState(77);
        for (let i = 0; i < 200; i++) s = step(s, [INPUT_LEVELS, -3]);
        const wire = JSON.parse(JSON.stringify(encodeSnapshot(s, [12, -1])));
        const snap = parseSnapshot(wire)!;
        expect(snap).not.toBeNull();
        expect(snap.tick).toBe(s.tick);
        expect(snap.ball).toEqual(s.ball);
        expect(snap.paddles).toEqual(s.paddles);
        expect(snap.score).toEqual(s.score);
        expect(snap.phase).toBe(s.phase);
        expect(snap.acks).toEqual([12, -1]);
        expect(decodeSnapshot(encodeSnapshot(s, [0, 0])).rally).toBe(s.rally);
    });

    it("rejects malformed snapshots", () => {
        const good = encodeSnapshot(createInitialState(1), [0, 0]);
        expect(parseSnapshot(good)).not.toBeNull();
        expect(parseSnapshot({ ...good, t: -1 })).toBeNull();
        expect(parseSnapshot({ ...good, b: [1, 2, 3] })).toBeNull();
        expect(parseSnapshot({ ...good, b: [1, 2, 3, Number.NaN] })).toBeNull();
        expect(parseSnapshot({ ...good, extra: 1 })).toBeNull();
        expect(parseSnapshot("nope")).toBeNull();
    });
});

describe("client events", () => {
    it("accept well-formed input packets", () => {
        expect(validateClientEvent("input", { c: [[0, 10, INPUT_LEVELS]], l: 6 }).ok).toBe(true);
    });

    it.each([
        ["unknown event", "teleport", { y: 1 }],
        ["prototype key", "__proto__", {}],
        ["extra field (a position)", "input", { c: [[0, 10, 1]], l: 0, y: 100 }],
        ["direction out of range", "input", { c: [[0, 10, INPUT_LEVELS + 1]], l: 0 }],
        ["fractional direction", "input", { c: [[0, 10, 0.5]], l: 0 }],
        ["negative sequence", "input", { c: [[-1, 10, 1]], l: 0 }],
        ["empty command list", "input", { c: [], l: 0 }],
        ["too many commands", "input", { c: Array.from({ length: MAX_COMMANDS_PER_PACKET + 1 }, (_, i) => [i, i, 0]), l: 0 }],
        ["string payload", "input", "[[0,1,1]]"],
        ["lag claim too large", "input", { c: [[0, 10, 1]], l: 10_000 }],
        ["non-finite sync time", "sync", { t: Infinity }],
        ["bad difficulty", "playBot", { difficulty: "godlike" }],
        ["short token", "resume", { code: "ABCDEF", token: "x" }],
        ["extra field on createRoom", "createRoom", { isAdmin: true }],
    ])("reject %s", (_label, event, payload) => {
        expect(validateClientEvent(event, payload).ok).toBe(false);
    });

    it("normalise room codes and refuse anything else", () => {
        expect(normalizeRoomCode(" abc-def ")).toBe("ABCDEF");
        expect(normalizeRoomCode("ab3-k7m")).toBe("AB3K7M");
        expect(normalizeRoomCode("AB0K7M")).toBeNull(); // 0 is not in the alphabet
        expect(normalizeRoomCode("ABCDEFG")).toBeNull();
        expect(normalizeRoomCode(42)).toBeNull();
    });
});
