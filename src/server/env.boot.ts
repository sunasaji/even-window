// env.boot.ts — imported for effect; it must stay the first import in src/server/main.ts.
//
// Several `EW_*` settings (docs/configuration.md) are read in `const` initialisers at module
// load, in main.ts and in the platform backend. ESM evaluates imports in source order before
// any statement of the importing module, so the env file has to be applied by a module that
// is imported first — above ./auth.ts and ./platform/index.ts. Add nothing else here.
//
// Tests stay hermetic because tests/setup.ts sets `EW_ENV_FILE=''` (use no file, do not search).

import { applyEnvFile, type EnvFileReport } from './envFile.ts'

/** What the env file did, for the start-up banner (`envFileBanner`). */
export const envFileReport: EnvFileReport = applyEnvFile()
