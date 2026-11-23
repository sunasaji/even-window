# Contributing

## Setup

```bash
npm ci
npm run check     # lint + typecheck + tests; run before every commit
npm run format    # apply Biome formatting and safe lint fixes
```

Node.js 22.18 or newer. The server runs TypeScript directly (`node src/server/main.ts`);
the client is built with Vite. See [docs/development.md](docs/development.md) for the
development loop and the simulator harness.

## Where things go

The guiding rule: **each kind of information has exactly one home**, and the source and
the reference docs describe only the present.

| Information | Home |
| --- | --- |
| What the code does and the constraint that makes it so | A comment next to the code |
| Behaviour other modules or people rely on | `docs/*.md` (reference docs) |
| Why a design was chosen over the alternatives | `docs/decisions/` (one short record each) |
| Measurements, experiments, device investigations | `docs/notes/` (dated, not maintained) |
| How a change came about | The commit message |

### Comments

- Say what must stay true and why: invariants, hazards, units, non-obvious constraints.
- Describe the present. No history ("used to", "the first version", dates, incident
  stories), no references to code that no longer exists, no provenance line numbers.
  That belongs in the commit message.
- A number chosen by measurement keeps a one-line statement of the fact that justifies it;
  the full measurement goes in `docs/notes/` and may be linked.
- Keep them short: a file header of a few lines, one to three lines on an exported symbol.
  If a comment needs paragraphs, the content belongs in `docs/`.
- English, sentence case. Refer to docs by path (`docs/protocol.md`), not section number.

### Log lines and messages

- Sentence case, like any other prose. Do not capitalise a word for emphasis in the middle
  of a sentence.
- Capitals are reserved for the word or short phrase that names a state or an alert a reader
  scans the log for: `WARNING`, `REFUSING TO START`, `ENFORCED`, `FAILED`, `link DOWN`,
  `palette OPEN`. One such marker per line. If it changes, update
  `docs/troubleshooting.md`, which indexes symptoms by these strings.

### Reference docs (`docs/*.md`)

- The minimum a reader needs, stated once, in the present tense.
- English is the source of truth. User-facing documents also have a Japanese translation
  next to them as `<name>.ja.md`; every such pair links to each other in its first lines.
  Change the English file first and update the translation in the same commit.
- Link to a note or a decision record for background instead of inlining it.

### Decision records (`docs/decisions/`)

One file per decision, named by topic. Four short sections: context, decision,
alternatives considered, consequences. Add one when a choice would otherwise look
arbitrary or tempting to undo. Supersede a record with a new one rather than rewriting it.

### Notes (`docs/notes/`)

Raw material: measurement tables, experiment logs, device behaviour observed on a given
date and firmware. Named `YYYY-MM-topic.md`. Notes are a snapshot and are not kept in sync
with the code; reference docs must stand on their own without them.

## Commits

History is the record of how the code got here, so `git blame` on any line should lead to
an explanation.

- [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`
  with `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `chore`.
  Scopes follow the layout: `client`, `server`, `platform`, `shared`, `docs`, `scripts`.
- Summary in the imperative, 72 characters or fewer, describing the change in behaviour.
- The body explains **why**: the problem, what was observed or measured, alternatives that
  were rejected, and anything a future reader of `git blame` would ask. This is where the
  narrative that is kept out of comments goes.
- One logical change per commit. Keep pure moves and reformatting separate from behaviour
  changes; list formatting-only commits in `.git-blame-ignore-revs`.
- A change to behaviour that the reference docs describe updates those docs in the same
  commit.

## Code layout

```
src/shared/            code used by both client and server (no Node or DOM dependencies
                       beyond what both have)
src/client/            the WebView page: phone UI and the glasses side
src/server/            the OS-neutral server: HTTP, auth, stream, tiles, bindings
src/server/platform/   the operating-system seam; one directory per backend
tests/                 vitest suites, named <area>.<subject>.test.ts
```

Nothing outside `src/server/platform/<os>/` may import from it; the server reaches a
backend only through the `Platform` interface (`src/server/platform/types.ts`).
See [docs/platform.md](docs/platform.md).

## Tests

- Prefer tests of behaviour through exported functions.
- Some client tests are *source audits* that assert on source text because the behaviour
  cannot be exercised without the glasses. Write them with `tests/helpers/source.ts`, which
  is insensitive to formatting, and audit code, never comments.
