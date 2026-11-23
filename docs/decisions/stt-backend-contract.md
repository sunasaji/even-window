# The recogniser is a URL, and the server proxies to it

## Context

Voice input needs a speech recogniser. The glasses and phone produce raw 16 kHz PCM. The
default engine, speech.cpp, is one static binary that answers OpenAI's audio API and has no
authentication of its own.

## Decision

`src/server/stt.ts` speaks exactly one interface, OpenAI's
`POST /v1/audio/transcriptions`, at whatever `EW_STT_URL` names. The feature is off when the
setting is empty. The client sends raw PCM to the gated route `POST /api/stt`; the server
wraps it in a WAV header and forwards it. The recogniser runs as a separate resident process
with its own systemd unit.

## Alternatives considered

- **Bind to one engine's private interface** (speech.cpp reads raw PCM on stdin). Measured,
  a resident server's full HTTP round trip (765 ms for 3.96 s of speech) equals raw inference
  (775 ms), so the generic API costs nothing and makes the engine a one-line setting.
- **Have the phone call the recogniser directly.** One hop shorter, but the phone has an
  identity for this server only, the recogniser would have to leave loopback without
  authentication, and every client would need the audio conversion.
- **Spawn the recogniser per utterance.** Works (1383 ms for the same utterance) but pays
  the model load every time.
- **On by default.** This is the one route that hands what a microphone heard to another
  process, so it stays off until configured.
- **A faster model that leaves Japanese in kana** (parakeet). Rejected as a default: text
  without kanji is a defect for instructions typed into a terminal.

## Consequences

- `EW_STT_URL` may point at another host or a hosted service without the phone learning a
  second credential. The audio then leaves the machine; that is the operator's choice.
- The client learns whether voice is available from `GET /api/health` and offers the dialog
  only then.
- The model id is the recogniser's HTTP id, which differs from its CLI name; the server's
  default must match the shipped unit's default.
- Recogniser errors are returned as `error` for display and are never typed.

Background: [notes/2026-10-voice-recogniser-benchmarks.md](../notes/2026-10-voice-recogniser-benchmarks.md).
