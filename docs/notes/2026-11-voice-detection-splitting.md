# Splitting an utterance by voice detection

Snapshot — not maintained. Conditions: 2026-11-26, a Xeon W-2125 with a Quadro P5000 under
WSL2; speech.cpp 0.8.8 (CPU) with `silero-vad`, and the faster-whisper library with
`large-v3`. Audio: two recordings from the glasses of about 29 s each, short Japanese
sentences with pauses between them, kept with `PINHOLE_STT_DUMP_DIR`.

This is a record of a setting that was tried and withdrawn. `PINHOLE_STT_OPTIONS` defaulted to
`chunking_strategy=auto` for one day and defaults to nothing now.

## What it is

The recogniser cuts the audio where a voice detector hears speech and recognises each region
alone. OpenAI's API calls the field `chunking_strategy`; faster-whisper calls it
`vad_filter`. speech.cpp takes `chunking_strategy` when `speech serve` is given a detection
model (`silero-vad`) and answers 400 to it otherwise.

## Why it was tried

A 30 s utterance came back as a fraction of what was said. The cause looked like one long
window going into a model trained on short clips, and splitting looked like the cure. Two
seconds of silence sent whole to `reazonspeech-nemo-v2` also came back as a word ("うん。"),
and split came back empty.

The first check was wrong: the server process had not been restarted, so the option was
never sent, and the one long transcript that came back whole was chance.

## What was measured

The same two recordings, whole and split, by reading the output against what was said:

| Model | Whole | Split |
| --- | --- | --- |
| `Qwen3-ASR-0.6B` (speech.cpp, `silero-vad`) | No errors in either recording | Errors in one recording (本日は晴天なり → 本日は正テスト) |
| `reazonspeech-nemo-v2` (speech.cpp, `silero-vad`) | A few wrong words (音声 → 音性) | More wrong words (音声テスト → 音性鉄道) |
| `large-v3` (faster-whisper, `vad_filter`) | No wrong words; one phrase added at the end that was not said | One recording collapsed into one phrase repeated to the length limit |

Synthesised speech (AivisSpeech) with pauses of 0.8 to 2 s came back whole either way. With
the level lowered to 35 %, pink noise added and 3 s pauses, the split run lost the first
words of two sentences and the whole run lost none.

## Reading

- Splitting made every model worse on real speech. A short region gives the model less
  context, and the detector cuts into the start of a quiet phrase.
- The fraction-of-a-long-utterance problem was the model: `Qwen3-ASR-0.6B` returns 30 s
  whole. The shipped default was already that model.
- The one thing splitting did better is silence coming back empty. The voice dialog already
  shows an empty or wrong transcript for the wearer to reject, so that is not worth the
  errors.
- Two recordings from one speaker are a small sample.
