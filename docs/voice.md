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
| Phone microphone | `AudioInputSource.Phone` | The glasses link is down | 3200 bytes (100 ms) | `phone-microphone` in the `permissions` of `app.json`, and the OS microphone permission for the Even App, asked on first use |

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
| Unanswered confirm, empty or failed dialog | closes itself after 60 s without a swipe or a tap |

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
| `EW_STT_OPTIONS` | empty | Extra form fields, as `name=value` pairs joined by `&`. Empty sends none. See [Recogniser options](#recogniser-options) |
| `EW_STT_API_KEY` | empty | Sent as `Authorization: Bearer` when set. For a hosted recogniser; see [A hosted recogniser](#a-hosted-recogniser) |
| `EW_STT_DUMP_DIR` | empty | Keeps a copy of each utterance in this directory. For diagnosis; see [Keeping the audio for diagnosis](#keeping-the-audio-for-diagnosis) |

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

Nothing extra is sent by default, and the shipped setup needs nothing here. Use it when
your recogniser documents a field you want:

```
EW_STT_OPTIONS=name=value
EW_STT_OPTIONS=name=value&other=value
```

When the recogniser answers 400 to a request that carried options, the server logs it and
sends the utterance once more without them, so recognition still works with a recogniser
that does not know a field.

Background: a field that was tried as the default and withdrawn is in
[notes/2026-11-voice-detection-splitting.md](notes/2026-11-voice-detection-splitting.md).

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

### Keeping the audio for diagnosis

When a transcript comes back short or wrong, the question is whether the audio or the
recogniser is at fault. `EW_STT_DUMP_DIR` names a directory; with it set, the server writes
two files per utterance:

- `utt-<date>-<time>-<ms>.wav`: the exact file sent to the recogniser, written before the
  request, so it is kept when the recogniser fails too.
- The same name with `.txt`: the text the recogniser answered.

Play the WAV to hear what the glasses captured, and send it again by hand to compare
models or settings:

```sh
curl http://127.0.0.1:8757/v1/audio/transcriptions -F file=@utt-….wav -F model=Qwen3-ASR-0.6B
```

The files are recordings of the wearer's voice. The directory is created with mode 700 and
the files with 600, only the newest 20 utterances are kept, and the setting is off by
default. Unset it when the diagnosis is done and delete the directory. A directory that
cannot be written costs the copy, not the utterance: the reason is logged and recognition
goes on.

### speech.cpp

The repository ships `systemd/speech-cpp.service`, a user unit that runs
[speech.cpp](https://github.com/nyosegawa/speech.cpp) on `127.0.0.1:8757`. Nothing in it is
specific to pinhole-window, and it is separate from the server's unit so that either can restart
without the other.

- speech.cpp has no authentication and no TLS. Keep it on loopback. This is about where
  speech.cpp listens, not about `EW_STT_URL`, which may name a hosted service instead.
- The unit's model name and `EW_STT_MODEL` are different strings for the same model and must
  agree. A mismatch produces a 404 that looks like a wrong route. List the ids with
  `curl -s http://127.0.0.1:8757/v1/models`.

  | Unit (`STT_MODEL`) | `EW_STT_MODEL` | Languages |
  | --- | --- | --- |
  | `qwen3-asr-0.6b` (default) | `Qwen3-ASR-0.6B` (default) | 30, including English and Japanese |

- Fetch the model before enabling the unit (`speech pull qwen3-asr-0.6b`). The
  unit runs with `ProtectSystem=strict` and cannot download into a model directory outside
  the home directory.
- Do not pass `--threads`. The default, the physical core count, is correct.
- The unit passes `--device auto`; the start-up log line names the device in use.
- `reazonspeech-v2` (HTTP id `reazonspeech-nemo-v2`) is a Japanese-only alternative, about
  1.6 times faster on a CPU. It made more errors on real recordings
  ([notes](notes/2026-11-voice-detection-splitting.md)) and is not part of the default
  setup. To use it, set `STT_MODEL` and `EW_STT_MODEL` and leave `EW_STT_LANG` unset.

#### GPU, and WSL

speech.cpp uses a GPU through Vulkan (Metal on macOS) and has no CUDA build. Its Linux
installer picks the CPU-only build when the Vulkan loader (`libvulkan1` on Debian and Ubuntu)
is missing, so install the loader and the GPU's Vulkan driver first; `speech devices` lists
what it found.

Under WSL2 that does not help with an NVIDIA GPU: WSL passes it through CUDA and Direct3D 12,
not Vulkan, and `speech` inside WSL runs on the CPU. To use the GPU, run the Windows build of
speech.cpp on the Windows host and point `EW_STT_URL` at it. The Windows host's models
directory can be the same one WSL uses (`SPEECH_MODEL_DIR`).

Measured on one machine (Quadro P5000, 4-core Xeon), `Qwen3-ASR-0.6B`, 30 s of audio: about
11 s on the CPU inside WSL, about 1 s on the GPU from the Windows build.

speech.exe listens on Windows' `127.0.0.1`, which WSL's default (NAT) networking cannot
reach. Which way round that to take depends on the machine:

| Way | Notes |
| --- | --- |
| WSL mirrored networking (`networkingMode=mirrored` in `.wslconfig`) | Windows' `127.0.0.1` becomes reachable as `127.0.0.1`. Not tested here. It changes networking for the whole distribution |
| Listen on the host's WSL-facing address and allow the port in Windows Firewall | Needs an administrator. The address changes between restarts; `<windows-hostname>.mshome.net` resolves to it from WSL. Tested as far as the firewall refusing the connection without a rule |
| An SSH port forward to the Windows host (`ssh -L`) | Tested. Needs an SSH server on Windows. Nothing is opened to the network. The WSL port and the Windows port must be different numbers: WSL's `localhostForwarding` mirrors WSL listeners onto Windows' `127.0.0.1`, and the same number on both sides forwards into itself |

Whichever is used, speech.cpp has no authentication: do not let it listen on an address
other machines can reach.
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
| `confirm`, `empty`, `failed` | Choose the selected row; while a page of a long transcript is selected, move on | Move the selection (wraps); in `confirm` with several pages, turn the page first | Cancel |

A transcript of several pages is read with the same swipe. Only the last page has the rows,
so `Send` cannot be picked before the whole text has been shown. The stops form one ring:
each page in turn, the last page included, then `Send`, `Again` and `Cancel` on it, then the
first page again. A swipe up goes the other way. The last page is a stop of its own: arriving
there puts the cursor on no row, and one more tap or swipe down puts it on `Send`. A run of
taps through the pages therefore ends on the last page and does not send. Moving also
restarts the 60 s limit, so reading does not time the dialog out.

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
[glasses.md](glasses.md#row-width) (63 units per line). The header and the rows leave 6 lines in
`confirm`. A longer transcript is cut into pages: 9 lines on each page before the last, which
has no rows, and up to 6 on the last. Lines are folded at 60 units to leave a margin for the
estimate and broken after a space where there is one; the header then reads `Voice 2/3`. Nothing is dropped: the pages put end to end are the transcript, and `Send`
sends the phone's box, which holds all of it. An error message in `failed` is elided with
`…` instead. Glyphs the lens font lacks (half-width
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
