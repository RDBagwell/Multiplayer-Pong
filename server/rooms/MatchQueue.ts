import type { Member } from "./Room.ts";

export interface QueueEntry {
    member: Member;
    /** False once the socket has gone away; dead entries are dropped, never paired. */
    isAlive(): boolean;
}

/**
 * Quick-match queue: first come, first served.
 *
 * Entries are keyed by member id, so a member can be in the queue at most
 * once and can never be paired with itself. Disconnects remove the entry
 * (see SocketController), and every pairing re-checks `isAlive()` as a
 * second line of defence, so nobody is ever matched with a dead socket.
 */
export class MatchQueue<E extends QueueEntry = QueueEntry> {
    private readonly entries = new Map<string, E>();

    /** Returns false if the member is already queued. */
    enqueue(entry: E): boolean {
        if (this.entries.has(entry.member.id)) return false;
        this.entries.set(entry.member.id, entry);
        return true;
    }

    remove(memberId: string): boolean {
        return this.entries.delete(memberId);
    }

    has(memberId: string): boolean {
        return this.entries.has(memberId);
    }

    get size(): number {
        return this.entries.size;
    }

    /** Takes the two longest-waiting live entries, or null if there aren't two. */
    takePair(): [E, E] | null {
        const live: E[] = [];
        for (const [id, entry] of this.entries) {
            if (!entry.isAlive()) {
                this.entries.delete(id);
                continue;
            }
            live.push(entry);
            if (live.length === 2) break;
        }
        if (live.length < 2) return null;
        this.entries.delete(live[0].member.id);
        this.entries.delete(live[1].member.id);
        return [live[0], live[1]];
    }

    /** Puts entries back at the front (used when a room couldn't be created). */
    requeueFront(entries: E[]): void {
        const rest = [...this.entries.values()];
        this.entries.clear();
        for (const e of [...entries, ...rest]) if (e.isAlive()) this.entries.set(e.member.id, e);
    }
}
