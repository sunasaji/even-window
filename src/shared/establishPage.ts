// Pure predicates for establishing the glasses start-up page.
//
// `createStartUpPageContainer` may be called only once per glasses-UI lifetime, and tile
// pushes repaint only containers that a `rebuildPageContainer` has made live. On a page
// reload the host answers `create` with success without making the new containers live, so
// boot always issues one rebuild right after create and treats the page as established when
// either call reports OK. That pair is the only rebuild issued (docs/glasses.md,
// docs/decisions/establish-once.md).
//
// `StartUpPageCreateResult` (host → Web): 0 = success, 1 = invalid, 2 = oversize, 3 = outOfMemory.

/** create succeeded → the start-up page exists (containers created). */
export function createOk(createResult: unknown): boolean {
  return createResult === 0
}

/** rebuild succeeded → the containers are now the live page (tile pushes will repaint). */
export function rebuildOk(rebuildResult: unknown): boolean {
  return rebuildResult === true
}

/** The page is established when either the one-time create succeeded or the follow-up
 *  rebuild made the containers live. A non-established page still proceeds to stream. */
export function pageEstablished(createResult: unknown, rebuildResult: unknown): boolean {
  return createOk(createResult) || rebuildOk(rebuildResult)
}
