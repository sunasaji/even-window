# Recogniser benchmarks

Snapshot — not maintained. Conditions: 2026-10, speech.cpp
on a Xeon W-2125 (4 physical cores, 8 threads) under WSL2, CPU only, 3.96 s of Japanese
speech synthesised with speech.cpp's own TTS.

## Models

| Model | Load | Inference | Output |
| --- | --- | --- | --- |
| reazonspeech-v2 (Apache-2.0, 660 MB, Japanese only) | 608 ms | 775 ms | kanji (直して / 追加) |
| parakeet-tdt_ctc-0.6b-ja | 644 ms | 585 ms | kana only (なおして / ついか) |
| qwen3-asr-0.6b (30 languages) | 1260 ms | 1272 ms | kanji |

parakeet is fastest but does not produce kanji, a practical defect for instructions to a
coding agent. The shipped default is the multilingual qwen3 model; reazonspeech-v2 is about
1.6 times faster for Japanese.

The transcription quality above was observed on synthetic speech and does not transfer to
real voices. Latency depends on audio length and does transfer.

## HTTP versus raw inference

Round trip of OpenAI-compatible `POST /v1/audio/transcriptions`, multipart upload included,
reazonspeech-v2:

| Configuration | 3.96 s utterance |
| --- | --- |
| Resident `speech serve` (default beam) | 765 ms |
| Resident, `decoding=greedy` | 660 ms |
| Spawn per utterance | 1383 ms |

The resident round trip (765 ms) equals raw inference (775 ms): the proxy costs nothing.
`speech asr MODEL - --vad silero-vad --rate 16000` reads raw s16le mono PCM from stdin with
no header, but with HTTP equally fast there is no speed reason to use it.

## Pitfalls

- Do not pass `--threads`. The default is the physical core count. Passing `nproc` (8) took
  22 s, twelve times slower, on this 4-core hyper-threaded host.
- Measure on a quiet machine. A first measurement contaminated by a leftover 8-thread server
  and a background workload burning 1.5 cores reported 1308 ms for the model that takes
  775 ms.
- CLI model names and HTTP model ids differ, per model, by no rule. Both read from a running
  `/v1/models`: `qwen3-asr-0.6b` → `Qwen3-ASR-0.6B`, `reazonspeech-v2` →
  `reazonspeech-nemo-v2`. Posting the CLI name returns a 404 that reads like a broken route.
- systemd refuses a variable as the first word of `ExecStart` ("Command ${STT_BIN} is not
  executable", found with `systemd-analyze verify`); the unit goes through `/usr/bin/env`.
- `speech serve` downloads a missing model on first start, which looks like minutes of
  silence with the unit reported active.

## Device selection and model storage

See [2026-11-speech-service-setup.md](2026-11-speech-service-setup.md): `--device auto`, why
the GPU is unreachable under WSL, where models live and how they are shared between two
operating systems.

There is little urgency about GPU use: at 775 ms inference for a 4 s utterance and 445 ms
microphone start-up, interaction is already bounded by the microphone.
