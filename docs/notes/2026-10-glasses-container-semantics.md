# Glasses container semantics observed on hardware

Snapshot — not maintained. Conditions: Even G2, Even App v2.3.2, `@evenrealities/even_hub_sdk` 0.0.16, Even Hub simulator 0.9.5; observations from 2026-10-10 to 2026-10-16.

Reference: [glasses.md](../glasses.md#containers).

## Both eyes see the whole panel (2026-10-11)

The scaffold claimed "left eye = TL + BL, right eye = TR + BR". It was never measured. A
`?pngprobe` photo taken through each lens showed all four quadrants at 2:1 in both (one eye
showing TL+BL only would be 1:1), and the wearer confirmed by closing one eye at a time: all four
quadrants are visible to each eye, and the TL, TR, BL, BR rewrite order is visible to both.

Consequences:

- Pump starvation had been described as "one eye freezes". The correct description is "three
  quadrants freeze while the fourth keeps changing" (about 1.9 s per full cycle on hardware). The
  bug and its fix were unaffected; only the explanation had borrowed an unmeasured claim.
- The rewrite order is visible to the naked eye, so `pickTile`'s round robin can be checked
  without logs.
- `LEFT_EYE_TILES` / `RIGHT_EYE_TILES` were removed from `geom.ts`; anything diagnosing a blackout
  with them would have misdiagnosed.

## Composition order of image and text

Without `zOrderIndex`, an image container is always in front of a text container; push order is
irrelevant. The four tiles cover 576x288, so a text overlay is structurally invisible. Simulator
and hardware agree.

Isolation experiment (a stub API server that never pushes a tile, on a separate port and
simulator):

| Condition | `textContainerUpgrade` returned | Glasses surface |
| --- | --- | --- |
| No tiles pushed, text written to container 6 | `true` | Readable (alpha plane has 2 levels) |
| An all-black tile pushed to container 2 first, then the same text | `true` | Completely empty (alpha plane has 1 level) |

The second row is an accepted call that drew nothing.

### `zOrderIndex` A/B

Only `zOrderIndex` was varied (the `?zorder=` flag that existed then); the overlay was shown and
the simulator's glasses PNG compared by pixels.

| `zOrderIndex` | `create` | `rebuild` | Glasses PNG after showing the overlay |
| --- | --- | --- | --- |
| on every container | 0 | `true` | Changes; menu text readable over the mirrored terminal |
| omitted | 0 | `true` | Byte-identical (overlay invisible) |

Hardware (G2, Even App v2.3.2) gave the same answer: a double tap froze the mirror, the window
list appeared over the tiles, and switching worked. This is the procedure to repeat after
editing the z-order plan: judge by whether the glasses image changes, not by return values.

### SDK-side validation

`validateEvenHubPageContainerZOrder` runs before the native call:

- a page where every container omits `zOrderIndex` is valid;
- if any container sets it, every list, text and image container must (`MISSING_Z_ORDER_INDEX`);
- values must be unique on the page (`DUPLICATE_Z_ORDER_INDEX`); larger is nearer the front.

A violation makes `createStartUpPageContainer` return 1 (`invalid`) and `rebuildPageContainer`
return `false` without the firmware seeing the page. `StartUpPageCreateResult.fromInt` also maps
any out-of-range host answer to `invalid`, so `create => 1` alone is not evidence of a validation
failure. The plan in `geom.ts` (tiles 1-4, input layer 5, overlay 6) is checked for uniqueness
and ordering by `tests/client.overlay.test.ts`.

## `menuObject` and `zOrderIndex` cannot coexist (2026-10-12)

On hardware:

```
create => 1 (REFUSED/invalid) (6 items, zorder=on)
rebuild(establish) => false (REFUSED)
```

No page exists, every later push fails, the glasses stay black while the phone UI keeps working.

The refusal comes from the host, not the SDK: `MenuContainerProperty` has only `menuItems` (no
`zOrderIndex`), `EvenHubContainerKind` is `'listObject' | 'textObject' | 'imageObject'`, so the
SDK validator passes, and the simulator returns `create => 0` for the identical payload. The
host's internal reason was not observable.

The full 2x2 on hardware:

| | no `zOrderIndex` | `zOrderIndex` on all |
| --- | --- | --- |
| with `menuObject` | Works (the pre-hierarchy design) | Refused, `create => 1`, black glasses |
| without `menuObject` | Overlay invisible under the tiles | Works (current) |

The simulator does not reproduce the refusal. A change of this kind must be judged by the
hardware `create =>` line.

The `?zorder=1` opt-in became the default on 2026-10-12 and the flag was deleted the next day,
together with `?menu=native` (commits 9442923 / fad3049 hold the removed code). It had been
opt-in only because the rule is all-or-nothing: one violation takes the whole page down.

## Accepted is not drawn

The same mistake was made four times:

| Returned | What it means | How it misled |
| --- | --- | --- |
| `textContainerUpgrade => true` | The host accepted the payload | An invisible overlay returned `true` |
| `createStartUpPageContainer => 0` | The payload was accepted | The accepted page's menu was unreadable over lit tiles |
| `create => 1` / `rebuild => false` | Possibly rejected by the SDK's local validation, never reaching firmware | Misread as "firmware does not support z-order" |
| simulator `create => 0` | The simulator host does not model the hardware check | The `menuObject` + `zOrderIndex` page looked fine |

A fifth instance of the same shape: a runtime probe passed `{menuObject: []}` and checked whether
`toJson()` carried it. The SDK documents `toJson` as field pass-through, so any unknown key
passes, and the probe reported "supported" against an SDK that had no such API. Let the type
checker answer API-existence questions.

Later, `shutDownPageContainer(0) => true` did not close the app either (see
[link and establish note](2026-10-glasses-link-and-establish.md)).

## Only two surfaces can change after creation

`EvenAppMethod` has `UpdateImageRawData` for images and `TextContainerUpgrade` for text. Lists
and menus have no incremental update; they can only be replaced by `rebuildPageContainer`.
`listObject` was tried for the voice dialog and failed for exactly this reason: it rendered and
was accepted, but its items could only be changed by a rebuild. The first question about any new
container type is whether an incremental update API exists.

## Image container size limit (2026-10-16)

The 288x144 limit in `geom.ts` was adopted without a measurement, and was doubted
because text containers of 576x288 work. A page with one oversized image container was
submitted (`?probe=1`, since deleted); the Even Hub validator printed the rule:

```
CreateStartUpPageContainer validation failed:
  image container size 576x144 exceeds maximum 288x144
  image container size 144x288 exceeds maximum 288x144
create => 1 (REFUSED: invalid — SDK validation)
```

- The limit is per dimension (width <= 288 and height <= 144), not per area: 144x288 has the same
  41,472 pixels and is refused.
- There is also a floor of 20x20 (read by the g2-engine project from the SDK 0.0.16 type
  definitions).
- The simulator is the permissive oracle (it accepts 12 containers where hardware does not, as
  the Glyph project also records), so a simulator refusal is conclusive without hardware.
- 4 containers x 288 x 144 = 165,888 px = 576 x 288 exactly. The quadrant grid is forced.
- Text and image containers have different validation rules; a full-panel text container says
  nothing about image containers.
- The four-image-container cap was reached independently on hardware by this project and by
  Glyph.

To reproduce: put one `ImageContainerProperty` larger than 288x144 on a page and read the
`create` result.

## Blanking verified in the simulator

With a one-second clock on the mirrored desktop and `?debug=1`:

| | Without blanking (the regression shape) | Current |
| --- | --- | --- |
| Glasses while the menu is up | Three menu lines over frozen terminal text, hard to read (the symptom reported from hardware) | Menu only, on a fully black surface |
| Log on open | `overlay SHOW` then `overlay text => true` | additionally `blank TL/TR/BL/BR=success/565B/…` and `tiles blanked: 4 push(es)/2260B in 19ms` |
| Moving the selection | — | `tiles already blank — nothing to push` |
| On close | — | all four tiles re-sent |

The 19 ms is meaningless (no BLE in the simulator). Read the glasses screenshot's alpha plane, not
its RGB: the content is only in alpha.

## Simulator versus hardware

Meaningful in the simulator: byte sizes (relative), API responses, control flow (establish then
diff pushes, gesture routing, reconnect behaviour), logic regressions. Hardware only: BLE transfer
time, actual rendering, phone runtime load. The simulator implements `menuObject`,
`menuItemClickEvent` and `zOrderIndex`, and its `double_click` envelope is byte-identical to the
hardware one, but agreement so far is not a guarantee for the next question.
