# Speech service device and model placement

Snapshot — not maintained. Conditions: speech.cpp on WSL2 (Xeon W-2125, 4 physical cores, Quadro P5000, NVIDIA driver 581.15), with a native Linux install on the same machine; `systemd/speech-cpp.service` as shipped.

## What speech.cpp reads

speech.cpp has no configuration file: only command-line arguments and two
environment variables (`SPEECH_MODEL_DIR`, `SPEECH_NO_UPDATE_CHECK`), plus
`XDG_CACHE_HOME`.

| Item | Location | Size |
| --- | --- | --- |
| Models | `SPEECH_MODEL_DIR`, else `~/.cache/speech.cpp/models` | Gigabytes |
| Binary | `~/.local/share/speech.cpp/<version>/` and `~/.local/bin/speech` | 14 MB |
| Service overrides | `~/.config/speech.cpp/service.env` | — |

The unit does not set `SPEECH_MODEL_DIR`. With `ProtectSystem=strict`, a user unit
can still write inside `$HOME` but not to another mount, so a relocated model
directory is read-only to the service and it cannot download a missing model.
`speech pull` from a shell is unaffected. To let the service fetch for itself, add
`ReadWritePaths=-/path/to/models` with `systemctl --user edit speech-cpp.service`.

## Model timings (CPU, 3.96 s of speech)

| Model | Load | Inference | Languages |
| --- | --- | --- | --- |
| `reazonspeech-v2` | 608 ms | 775 ms | Japanese |
| `Qwen3-ASR-0.6B` | 1260 ms | 1272 ms | 30 |

The `language` hint steers and does not force: the same Japanese audio came back as
correct Japanese with both `language=en` and `language=ja`.

Do not pass `--threads`. The default is the physical core count; passing `nproc` on
a 4-core machine with hyper-threading took 22 s for an utterance that takes 1.8 s
at the default.

## Device selection

The unit passes `--device auto`, speech.cpp's own default (first GPU, else CPU). An
earlier revision pinned `cpu`, which would hold a machine with a working GPU on the
CPU.

`auto` degrades correctly and reports its choice. With the Vulkan build on a machine
with no reachable GPU:

```
$ speech asr reazonspeech-v2 --device auto …
load time 3.32 s: reazonspeech-nemo-v2 on CPU
… 3.96 s of audio in 0.910 s, RTFx 4.4          (CPU build: 0.941 s)
```

The service prints it differently:

```
$ journalctl --user -u speech-cpp | grep "speech serve:"
speech serve: reazonspeech-nemo-v2 (fastconformer) on CPU, 16000 Hz, for /v1/audio/transcriptions
```

Which devices exist is decided by the installed build, not by `--device`.
`install.sh` picks the Vulkan build when a Vulkan loader is present; `speech devices`
lists what the build can see.

### GPU is unreachable under WSL

| Path | State |
| --- | --- |
| CUDA | WSL injects `libcuda.so.1` and `libnvidia-ml.so.1`, but speech.cpp's Linux releases are `cpu` and `vulkan` only |
| Vulkan | WSL's NVIDIA injection has no Vulkan driver or ICD; Mesa has no `libvulkan_dzn.so`, leaving only `lvp` (software) |

`nvidia-smi` is at `/usr/lib/wsl/lib/nvidia-smi` (not on `PATH`) and reports the GPU,
but speech.cpp cannot reach it. Native Linux is untested; re-running `install.sh`
there should be enough, since the unit already uses `auto`.

There is little urgency: inference on CPU takes 775 ms for 4 s of speech and the
microphone start-up takes about 445 ms, so the interaction is already bounded by
the microphone.

## Sharing models between WSL and native Linux

The same unit runs on both. Models must sit at a path that is identical on both
sides, so that `SPEECH_MODEL_DIR` needs no per-OS branch.

| Location | Free | From WSL | From native | Verdict |
| --- | --- | --- | --- | --- |
| Native root (sde3) | 7.2 G | `/mnt/wsl/…` | `/` | Too small |
| `/mnt/d` (NTFS) | 165 G | 9p | ntfs-3g, same path | Chosen |
| WSL VHD | 875 G | `/` | Not visible | Not possible |

Loading from `/mnt/d` is slower (warm load of the same model: ext4 1.5 s, `/mnt/d`
6.2 s; writes 48 MB/s), but the model is loaded once at service start. The 14 MB
binary is installed separately on each OS.
