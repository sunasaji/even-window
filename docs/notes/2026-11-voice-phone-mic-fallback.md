# Phone-microphone fallback: findings and hardware check

Snapshot — not maintained. Conditions: 2026-11-23, phone with the Even App and G2 glasses,
server reporting `stt: true`. Outcome of the hardware check below: passed.

## Findings

- Phone audio arrives with no glasses connected: the dialog reached
  `Voice (phone)  listening` and `■ stop` on the phone ended the recording.
- The phone microphone had been measured earlier (2026-10-16): 16 kHz s16le mono, 3200-byte
  (100 ms) frames, first frame after 422 ms, OS permission dialog on first use. The receiver
  never assumed a frame length, so no change was needed there.
- The microphone is chosen once per recording from the client's link verdict. A link that
  drops mid-recording does not switch microphones; that recording ends at the cap or on a
  tap. Before this change the client refused to start voice input with the link down.
- While the link is down the client does not write the text overlay or blank the tiles. A
  write nobody receives waits for an 8-second timeout, and during recording the header is
  redrawn every second. The current overlay, including an empty one, is resent when the link
  returns, so a dialog closed while disconnected does not reappear on the lens.
- Do not switch Bluetooth off while the app is running: the host app goes down with it.

## Hardware check

Not possible in the simulator: it sends no link drop and has no microphone.

1. Glasses connected: press `voice` on the phone. Heading `Voice  opening the mic...` (no
   `phone`), log `voice: glasses mic requested => true`. Cancel with a double tap.
2. Close the app, turn the phone's Bluetooth off, then start pinhole-window again from the Even
   App. Log: `deviceInfo: no device — treating the link as DOWN`, `glasses link DOWN`.
   Do not turn Bluetooth off while the app is running: the host app goes down with it
   (reproduced that day with the first version of this procedure).
3. Press `voice`. The first time, the OS asks for microphone permission. Preview shows
   `Voice  opening the phone mic...`; log `voice: phone mic requested => …` and
   `overlay text not pushed — the glasses link is down`.
4. Speak, then stop. `voice: first frame after …ms (3200B)`, then `Voice (phone)  listening`.
   If `no audio from the phone mic…` appears after 6 s, suspect the Even App's microphone
   permission.
5. The recognised text lands in the text field; `Submit` sends it to the focused window.
6. Restore the link: `glasses link UP` → `overlay HIDE`, and no dialog is left on the lens.

## Simulator side (no microphone)

The feed for `?voicefeed=` was generated with a TTS and converted:

```bash
speech tts irodori-tts:q4_k --voice none -o /tmp/ja-48k.wav '<a Japanese sentence>'
ffmpeg -y -i /tmp/ja-48k.wav -ar 16000 -ac 1 -f s16le ja.pcm
speech serve reazonspeech-v2 silero-vad --port 8757      # do not pass --threads
```

The confirm dialog closes itself after 60 s idle, so capture the glasses frame before that.
