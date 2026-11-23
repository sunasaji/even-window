// Vitest setup — runs before every test file.
//
// It makes the env-file loader hermetic. `src/server/env.boot.ts` applies `~/.even-window/env`
// as an import side effect, so importing src/server/main.ts in a test would otherwise pick up
// the developer's own env file. `EW_ENV_FILE=''` means "use no file and do not search".
//
// Tests about the loader call `applyEnvFile(env)` with their own env object and temp file.
process.env.EW_ENV_FILE = ''
