# Voice input

Speak, have the speech recognised, confirm the text, and have it typed into the focused
window of the mirrored desktop. The target can be a terminal, a form in a browser or anything
else: the text goes wherever keyboard focus is.

Voice input is off unless the server is given a recogniser (`EW_STT_URL`).

## Pipeline

```
microphone ──PCM frames──▶ client (buffers) ──POST /api/stt──▶ server ──WAV──▶ recogniser
                                                                  │
phone text box ◀── transcript ────────────────────────────────────┘
      │
      └─ Send / Submit ──▶ POST /api/desktop/input {kind:'type'} ──▶ focused window
```

The server sits between the phone and the recogniser for three reasons: the phone holds an
identity for this server only, so the recogniser needs no credential of the phone's
([security.md](security.md)); a local recogniser with no authentication of its own can stay
on loopback behind that gate; and the audio conversion lives in one place. A hosted
recogniser is reached the same way, with its API key held by the server and never by the
phone ([A hosted recogniser](#a-hosted-recogniser)). Background: [decisions/stt-backend-contract.md](decisions/stt-backend-contract.md).

## Capability advertisement

`GET /api/health` reports `stt: true` when `EW_STT_URL` is set
([protocol.md](protocol.md#get-apihealth)). The client reads it at start-up. Only then does it bind the
long press and show the phone's voice button, so a dialog that could only end in
"not configured" is never offered.

## Capture

Audio comes from the Even Hub SDK: the client calls `audioControl(true, source)` and receives
PCM in `audioEvent` frames.

| Source | SDK constant | Used when | Frame | Requires |
| --- | --- | --- | --- | --- |
| Glasses microphone | `AudioInputSource.Glasses` | The glasses link is up | 1600 bytes (50 ms) | `g2-microphone` in the `permissions` of `app.json` |
| Phone microphone | `AudioInputSource.Phone` | The glasses link is down | 3200 bytes (100 ms) | The OS microphone permission for the Even App, asked on first use |

- Both deliver 16 kHz, signed 16-bit little-endian, mono.
- The microphone is chosen once, when a recording starts (`voiceMicFor`). A link that drops
  mid-recording does not switch microphones.
- The client does not assume a frame length, and accepts the PCM as a `Uint8Array`, a number
  array or a base64 string.
- A `true` result from `audioControl` means the host accepted the call, not that audio will
  arrive. With a missing permission the host accepts and delivers nothing. The dialog
  therefore stays in `opening` until the first frame, and fails with a message naming the
  likely permission if none arrives in 6 seconds.
- The first frame arrives about 0.4 s after the request.

| Client limit | Value |
| --- | --- |
| Longest recording | 30 s, then it stops and is sent for recognition |
| Wait for the first frame | 6 s |
| Unanswered confirm, empty or failed dialog | closes itself after 60 s |

Background: [capture measurements](notes/2026-10-voice-capture-measurements.md),
[phone-microphone fallback](notes/2026-11-voice-phone-mic-fallback.md).

## `POST /api/stt`

The client posts the whole recording as raw PCM, exactly as captured, with
`?rate=16000`. The route is gated like every other. Full wire contract:
[protocol.md](protocol.md#post-apistt).

| Aspect | Rule |
| --- | --- |
| Body | Raw s16le mono PCM, an even number of bytes |
| `rate` | Integer 8000–48000; default 16000 |
| Size cap | 60 seconds of audio at the stated rate |
| Success | `{ok: true, text}`; `text` may be empty, meaning nobody spoke |
| Failure | `{ok: false, error}`; `error` is for a human to read and is never typed |

## Recogniser backend

The contract is a URL, not an engine. `src/server/stt.ts` speaks one API: OpenAI's
`POST /v1/audio/transcriptions`. Any server that answers it can be used, on this host or
another.

| Setting | Default | Meaning |
| --- | --- | --- |
| `EW_STT_URL` | empty (feature off) | Full URL of the transcription endpoint, for example `http://127.0.0.1:8757/v1/audio/transcriptions` |
| `EW_STT_MODEL` | `Qwen3-ASR-0.6B` | Sent as `model` |
| `EW_STT_LANG` | empty | Sent as `language` when set |
| `EW_STT_PROMPT` | empty | Sent as `prompt` when set (vocabulary bias) |
| `EW_STT_OPTIONS` | `chunking_strategy=auto` | Extra form fields, as `name=value` pairs joined by `&`. Empty sends none. See [Recogniser options](#recogniser-options) |
| `EW_STT_API_KEY` | empty | Sent as `Authorization: Bearer` when set. For a hosted recogniser; see [A hosted recogniser](#a-hosted-recogniser) |

The settings are read per request. See [configuration.md](configuration.md).

What the server sends and expects:

- A `multipart/form-data` POST with `file` (the PCM wrapped in a 44-byte WAV header,
  `audio/wav`, named `utterance.wav`), `model`, optionally `language` and `prompt`, and the
  fields of `EW_STT_OPTIONS`. A 400 to a request that carried options is retried once
  without them.
- A 2xx JSON response with a string `text`. The text is trimmed.
- Anything else is a failure: a network error, a non-2xx status, a non-JSON body, or JSON
  without `text`. The request times out after 45 seconds.

An empty recording is answered `{ok: true, text: ''}` without calling the recogniser.

### Recogniser options

`EW_STT_OPTIONS` adds form fields to the request, so a recogniser's own switches can be set
without a setting for each. The syntax is a URL query string: `name=value` pairs joined by
`&`, percent-encoded where a value needs it. An option with the name of `model`, `language`
or `prompt` replaces that field; `file` cannot be set.

The default, `chunking_strategy=auto`, is a field of OpenAI's transcription API: the
recogniser splits the audio where its voice detector hears speech and recognises each region.
It matters for a long utterance. Sent as one window, `reazonspeech-nemo-v2` returned a
fraction of a 30 s recording, and two seconds of silence came back as a word. Other servers
have the same idea under another name.

| Recogniser | Setting | Status |
| --- | --- | --- |
| speech.cpp 0.8.8 started with a voice detector (`silero-vad`, as the shipped unit does), serving `Qwen3-ASR-0.6B` or `reazonspeech-nemo-v2` | `chunking_strategy=auto` (the default) | Tested: accepted |
| speech.cpp 0.8.8 started without a voice detector | `EW_STT_OPTIONS=` | Tested: `chunking_strategy` is refused with 400 |
| OpenAI's API with a model that supports chunking (`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`) | `chunking_strategy=auto` (the default) | Not tested; the field is OpenAI's own. See [A hosted recogniser](#a-hosted-recogniser) |
| faster-whisper servers (Speaches, formerly faster-whisper-server) | `EW_STT_OPTIONS=vad_filter=true` | Not tested; `vad_filter` is their name for the same thing |

More than one field: `EW_STT_OPTIONS=vad_filter=true&temperature=0`.

When the recogniser answers 400 to a request that carried options, the server logs it and
sends the utterance once more without them, so recognition still works with a recogniser
that does not know a field. Set `EW_STT_OPTIONS=` (empty) to skip that first attempt.

### A hosted recogniser

The contract is OpenAI's API, so OpenAI's own endpoint is a valid `EW_STT_URL`. Not tested
against the live service: the request shape is the documented one, and the bearer header is
covered by the tests against a local stand-in.

```
EW_STT_URL=https://api.openai.com/v1/audio/transcriptions
EW_STT_MODEL=gpt-4o-mini-transcribe
EW_STT_API_KEY=sk-...
```

- **The audio leaves the machine.** With a local recogniser, what the microphone heard stays
  on loopback. With a hosted one, every utterance is sent to that company, under its terms.
- The key is sent as `Authorization: Bearer` and nowhere else: it is not logged and is not
  part of any answer to the phone. Keep it in the env file, which must not be writable by
  others ([configuration.md](configuration.md)).
- With a key set, the server refuses a plain `http://` URL to another host, since the key
  would cross the network in the clear. `http://127.0.0.1`, `localhost` and `[::1]` are
  allowed.
- `whisper-1` does not take `chunking_strategy`. If the API answers 400, the server retries
  without the options (above); set `EW_STT_OPTIONS=` to skip that attempt.

### speech.cpp

The repository ships `systemd/speech-cpp.service`, a user unit that runs
[speech.cpp](https://github.com/nyosegawa/speech.cpp) on `127.0.0.1:8757`. Nothing in it is
specific to even-window, and it is separate from the server's unit so that either can restart
without the other.

- speech.cpp has no authentication and no TLS. Keep it on loopback. This is about where
  speech.cpp listens, not about `EW_STT_URL`, which may name a hosted service instead.
- The unit's model name and `EW_STT_MODEL` are different strings for the same model and must
  agree. A mismatch produces a 404 that looks like a wrong route. List the ids with
  `curl -s http://127.0.0.1:8757/v1/models`.

  | Unit (`STT_MODEL`) | `EW_STT_MODEL` | Languages |
  | --- | --- | --- |
  | `qwen3-asr-0.6b` (default) | `Qwen3-ASR-0.6B` (default) | 30, including English and Japanese |
  | `reazonspeech-v2` | `reazonspeech-nemo-v2` | Japanese only; about 1.6 times faster |

- Fetch the model before enabling the unit (`speech pull qwen3-asr-0.6b silero-vad`). The
  unit runs with `ProtectSystem=strict` and cannot download into a model directory outside
  the home directory.
- Do not pass `--threads`. The default, the physical core count, is correct.
- The unit passes `--device auto`; the start-up log line names the device in use.
- Override the unit's settings in `~/.config/speech.cpp/service.env`; move the models with
  `SPEECH_MODEL_DIR` there.

A resident recogniser answers a 4-second utterance in about 0.8 s on a 4-core CPU, and the
HTTP round trip costs nothing measurable over raw inference.
Background: [notes/2026-10-voice-recogniser-benchmarks.md](notes/2026-10-voice-recogniser-benchmarks.md).

## The voice dialog

The dialog is drawn in the glasses' text overlay and, as an approximation, in the phone
preview ([glasses.md](glasses.md), [phone-ui.md](phone-ui.md)). Its stages, rows, gesture
rule and layout are pure functions in `src/shared/voiceDialog.ts`; the microphone, the HTTP
call and the timers are in `src/client/`.

### Starting and stopping

| Action | Glasses | Phone |
| --- | --- | --- |
| Start | Long press | The `🎤 voice` button |
| Stop recording | Tap | The same button, which reads `■ stop` while recording |
| Cancel | Double tap, in any stage | The double-tap gesture pill |

Recording is tap-to-stop, not hold-to-talk. The long-press release is ignored, so a lost
release event cannot leave the microphone open. The phone button is disabled in every stage
other than idle and recording.

### Stages

| Stage | Meaning | Header | Rows |
| --- | --- | --- | --- |
| `opening` | The microphone was requested; no frame yet | `Voice  opening the mic...` | none |
| `listening` | Frames are arriving | `Voice  listening Ns  (tap=stop  dbl=cancel)` | none |
| `recognizing` | The server has the audio | `Voice  recognizing...` | none |
| `confirm` | There is a transcript | `Voice  (tap=pick  dbl=cancel)` | `Send`, `Again`, `Cancel` |
| `empty` | Nothing was recognised | `Voice  nothing was heard` | `Again`, `Cancel` |
| `failed` | An error, shown as the body | `Voice  FAILED` | `Again`, `Cancel` |

With the phone microphone the headers say so (`opening the phone mic...`, `Voice (phone)`).

```
            first frame          tap / stop / 30 s            transcript
 opening ───────────────▶ listening ───────────▶ recognizing ───────────▶ confirm
    │ 6 s, no audio                                   │ empty text ──▶ empty
    └──────────────▶ failed ◀──── error ──────────────┘
```

"Listening" is shown on the first frame, not on the press, so the display never claims to
hear before it does.

### Gestures in the dialog

| Stage | Tap | Swipe up / down | Double tap |
| --- | --- | --- | --- |
| `opening`, `listening` | Stop recording | Ignored | Cancel |
| `recognizing` | Ignored | Ignored | Cancel |
| `confirm`, `empty`, `failed` | Choose the selected row | Move the selection (wraps) | Cancel |

While the dialog is up, gestures are consumed by it and are not sent to the mirrored desktop.

### Resolving

The phone's text box is the source of truth. The transcript is written into it (without
focusing it), and the dialog is a view of that box plus the rows.

| Outcome | Effect |
| --- | --- |
| `Send` on the glasses, or `Submit` on the phone | The box content is sent through the phone's single submit path; the dialog closes |
| `Again` | The box is cleared and a new recording starts |
| `Cancel`, double tap, or the 60 s timeout | The box is cleared and the dialog closes |

Every outcome closes the microphone. A transcript that arrives after the dialog was cancelled
is dropped. Empty text and error messages are never typed (`injectable`).
Background: [decisions/voice-dialog-design.md](decisions/voice-dialog-design.md).

### Layout

The panel shows 10 lines and the firmware wraps long lines itself. The module only estimates
how many lines a string takes, by the width model in
[glasses.md](glasses.md#row-width) (63 units per line), and elides the transcript with `…` to the lines left after the header and the rows: 6 in
`confirm`. The full text stays in the phone's box. Glyphs the lens font lacks (half-width
kana, characters outside the Basic Multilingual Plane) are dropped silently by the firmware.
Background: [notes/2026-10-voice-text-typing-and-lens-text.md](notes/2026-10-voice-text-typing-and-lens-text.md).

When the glasses link is down, the client does not write the overlay to the glasses; it
resends the current overlay when the link returns.

## Typing the text

`Send` and `Submit` use the same path as text typed on the phone
([phone-ui.md](phone-ui.md)): each line goes to `POST /api/desktop/input` as `{kind: 'type'}`,
line breaks become the application's configured newline key, and the application's submit key
follows if one is configured. A recogniser's transcript contains no line breaks; they appear
only if the text was edited in the box.

On the X11 backend, text containing non-ASCII characters is typed with a 40 ms inter-key
delay (`TYPE_DELAY_NON_ASCII_MS`), because at the default delay characters that need a
temporary key mapping are dropped. ASCII text keeps the default speed. See
[platform.md](platform.md).

## Testing without a microphone

The simulator has no audio device. `?voicefeed=<url>` makes the client fetch raw
16 kHz s16le mono PCM from the URL and feed it through the normal frame path in 1600-byte
frames, then stop and recognise. It does nothing unless the server reports a recogniser. The
phone-microphone fallback can only be checked on hardware. See
[development.md](development.md).
