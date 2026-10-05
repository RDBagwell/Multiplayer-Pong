import crypto from "node:crypto";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "../../shared/protocol.ts";

/** Unguessable, human-friendly room code (crypto.randomInt is uniform, no modulo bias). */
export function generateRoomCode(length = ROOM_CODE_LENGTH): string {
    let code = "";
    for (let i = 0; i < length; i++) code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
    return code;
}

/** 256-bit secret session token, base64url. */
export function generateToken(): string {
    return crypto.randomBytes(32).toString("base64url");
}

/** Only the hash of a token is stored, so a memory dump doesn't hand out seats. */
export function hashToken(token: string): string {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/** Constant-time comparison of two token hashes. */
export function hashesEqual(a: string, b: string): boolean {
    const x = Buffer.from(a, "hex");
    const y = Buffer.from(b, "hex");
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** A uint32 seed for a new match. */
export function randomSeed(): number {
    return crypto.randomInt(1, 2 ** 32 - 1);
}
