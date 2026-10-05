# The original (v1, 2022)

The original code is tagged `v1-original`. It is a course project: an Express + Socket.io server (`server.js`, `api.js`, `sockets.js`, about 60 lines) and a canvas client (`public/javascripts/script.js`, about 220 lines). This page records what was wrong with it, so the rebuild has a baseline. Line references are to the tagged files.

## Who decides what happens

**The game was client-authoritative.** One browser, the "referee", ran the ball physics and scoring, then sent the result to the server, which relayed it as-is:

```js
// sockets.js
socket.on('paddleMove', (paddleData) => socket.to(room).emit('paddleMove', paddleData));
socket.on('ballMove',   (ballData)   => socket.to(room).emit('ballMove', ballData));
```

- The server never looks at the payloads. Any client, referee or not, can send `ballMove` with any `ballX`, `ballY` and `score`, or `paddleMove` with any `xPosition`. Both clients apply them directly (`({ ballX, ballY, score } = ballData)`).
- The referee is the player whose `ready` completed the pair, i.e. the **second** player to join (`startGame` is emitted with that socket's id). The first player only renders what the second sends.
- The referee's frame rate and connection are the game: the other player sees the ball one network trip late, and their own paddle hits are judged on the referee's machine against a paddle position that is also one trip old.

## Matchmaking

```js
let readyPlayerCount = 0;               // module-level: shared by every connection
room = 'room' + Math.floor(readyPlayerCount / 2);
readyPlayerCount++;
```

- The counter is global and never decremented. If a player disconnects while waiting, the next player is put in the room with the departed player, and the game "starts" with no opponent. Every later pairing is shifted by one: players are matched by arrival parity, not by who is actually present.
- A disconnect mid-game isn't reported to the opponent. Their game carries on with a frozen paddle (or, if the referee left, a frozen ball).
- There's no way to choose an opponent, invite a friend, play alone or watch.

## Physics

- **Frame-rate dependent.** The referee moves the ball by a fixed `speedY` per `requestAnimationFrame` (`ballY += speedY * ballDirection`). On a 144 Hz screen the ball moves 2.4 times faster than on a 60 Hz one, and a background tab (throttled rAF) slows the whole match down.
- **Discrete collision.** Paddle hits are checked only when the ball is already inside a 25 px band (`ballY > height - paddleDiff`). It works only because the speed is capped at 5 px per frame; any faster ball would skip the band.
- The horizontal speed is zero until the referee has moved the mouse (`if (playerMoved) ballX += speedX`), and speed-up on hit is also gated on `playerMoved`.
- After a miss, `ballReset()` broadcasts the old score and then `score[x]++` runs, so the other client's score lags by one message until the next `ballMove`.

## Networking and performance

- The referee emits `ballMove` every animation frame, so 60–144 messages per second each way, plus one `paddleMove` per mouse event. There's no tick rate or snapshot rate.
- There's no latency handling at all: no prediction, no interpolation, no clock. Remote objects jump to whatever position the last message carried.

## Security and robustness

- No input validation: payloads of any shape and size are relayed to the opponent.
- No rate limiting: a client can flood `ballMove` and the server relays every message.
- No origin check on the Socket.io server (any web page can open a socket to it), and the default `maxHttpBufferSize` (1 MB).
- No reconnection or session: a refresh is a new player, and the old seat is lost.
- `socket.id` is the only identity, and it's broadcast to the room as the referee id.
- The port is hardcoded (`const PORT = 3000`), so it can't run on a host that assigns one.
- `api.use('/', express.static('index.html'))` serves a directory called `index.html` that doesn't exist; the page actually comes from the `public` static handler.

## Client

- The canvas is a fixed 500×700 backing store. It isn't scaled for high-DPI screens (blurry on phones and Retina displays), and on narrow screens CSS stretches it to `width: 100%; height: 700px`, which distorts it.
- Mouse only: no keyboard or touch, so it can't be played on a phone.
- The Socket.io client comes from a CDN (with SRI, which is good), and the favicon from a third-party site.
- No tests, and `npm test` exits with an error.
