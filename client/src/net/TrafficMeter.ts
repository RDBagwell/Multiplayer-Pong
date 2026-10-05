/**
 * Counts bytes each way over a sliding one-second window.
 *
 * A message's size is what Socket.io puts in the WebSocket frame for it:
 * the packet type digits ("42") followed by the JSON of [event, payload].
 * WebSocket framing (2–14 bytes per frame) and TCP/IP headers are not
 * included.
 */
export function socketIoFrameBytes(event: string, payload: unknown): number {
    return 2 + JSON.stringify([event, payload]).length;
}

class Window {
    private readonly samples: { at: number; bytes: number }[] = [];
    total = 0;
    messages = 0;

    add(at: number, bytes: number): void {
        this.samples.push({ at, bytes });
        this.total += bytes;
        this.messages++;
    }

    perSecond(now: number, windowMs = 1000): number {
        while (this.samples.length && this.samples[0].at < now - windowMs) this.samples.shift();
        let sum = 0;
        for (const s of this.samples) sum += s.bytes;
        return (sum * 1000) / windowMs;
    }
}

export class TrafficMeter {
    private readonly up = new Window();
    private readonly down = new Window();

    countUp(event: string, payload: unknown, now: number): void {
        this.up.add(now, socketIoFrameBytes(event, payload));
    }

    countDown(event: string, payload: unknown, now: number): void {
        this.down.add(now, socketIoFrameBytes(event, payload));
    }

    upPerSecond(now: number): number {
        return this.up.perSecond(now);
    }

    downPerSecond(now: number): number {
        return this.down.perSecond(now);
    }

    get totals(): { up: number; down: number; upMessages: number; downMessages: number } {
        return { up: this.up.total, down: this.down.total, upMessages: this.up.messages, downMessages: this.down.messages };
    }
}
