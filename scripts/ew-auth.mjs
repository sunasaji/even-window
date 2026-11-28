#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
// ew-auth.mjs — operator CLI for the client auth registry (~/.pinhole-window/clients.json).
//
// Runs without the TypeScript toolchain: node builtins only, plus one optional dynamic
// import (the QR encoder, for `pair`) that falls back to `qrencode`, then to the URL alone.
//
//   node scripts/ew-auth.mjs list
//   node scripts/ew-auth.mjs pair [appUrl]        # interactive: open a window, wait for a
//                                                 #   device, show its art, [y/N] approve
//   node scripts/ew-auth.mjs open [appUrl]        # non-interactive: open the window and
//                                                 #   print CODE=… / URL=… (for scripts)
//   node scripts/ew-auth.mjs pending              # staged devices + their randomart
//   node scripts/ew-auth.mjs approve <idPrefix>   # enroll a pending device (>=4-char id)
//   node scripts/ew-auth.mjs reject  <idPrefix>
//   node scripts/ew-auth.mjs add '<publicKeyJwkJson>' [name]
//   node scripts/ew-auth.mjs add-test [name]      # gen keypair, enroll pub, save priv
//   node scripts/ew-auth.mjs sign <nonce> [origin] # sign a challenge with the test key
//                                                 #   (origin = what the device claims to be
//                                                 #    talking to; must equal the server's
//                                                 #    EW_ORIGIN when it is set)
//   node scripts/ew-auth.mjs revoke <idPrefix>
//   node scripts/ew-auth.mjs rotate               # new token-signing secret: ends every
//                                                 #   session now (enrollments stay)
//
// The fingerprint formula and the session-binding material under `sign` must match
// src/server/auth.ts, src/client/authClient.ts and src/shared/sessionBinding.ts byte for
// byte (docs/security.md). Accepts Ed25519 (OKP, only `x`) and ECDSA P-256 (EC, `x`+`y`).
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Canonical origin, matching src/shared/sessionBinding.ts (`URL.origin`, '' when unusable).
 *  A copy that must not drift: a .mjs cannot import the .ts. */
function normaliseOrigin(raw) {
  const s = (raw ?? '').trim()
  if (!s) return ''
  try {
    const o = new URL(s).origin
    return o && o !== 'null' ? o : ''
  } catch {
    return ''
  }
}

// Terminal QR for the pairing URL. Two spaces per module with explicit ANSI backgrounds
// give square modules that read the same on light and dark terminals. Error correction L
// keeps a ~53-character URL at 29 modules = 66 columns, inside an 80-column terminal; M
// would be 74 columns, and a wrapped QR does not scan.
// Falls back to `qrencode` when node_modules is absent, then to null (the URL alone).
async function renderQr(url) {
  // Not when stdout is redirected: colour blocks in a log file or a pipe are noise.
  if (!process.stdout.isTTY) return null
  try {
    const { default: qrcode } = await import('qrcode-generator')
    const qr = qrcode(0, 'L')
    qr.addData(url)
    qr.make()
    const n = qr.getModuleCount(),
      quiet = 2
    const light = '\x1b[47m  \x1b[0m',
      dark = '\x1b[40m  \x1b[0m'
    const row = cell => {
      let out = ''
      for (let x = -quiet; x < n + quiet; x++) out += cell(x)
      return out
    }
    const rows = []
    for (let i = 0; i < quiet; i++) rows.push(row(() => light))
    for (let y = 0; y < n; y++)
      rows.push(row(x => (x < 0 || x >= n ? light : qr.isDark(y, x) ? dark : light)))
    for (let i = 0; i < quiet; i++) rows.push(row(() => light))
    return rows.join('\n') + '\n'
  } catch {
    /* no node_modules: try the system tool */
  }
  try {
    return execFileSync('qrencode', ['-t', 'UTF8', url], { encoding: 'utf8' })
  } catch {
    return null
  }
}

// ── the env file, before anything reads a setting ────────────────────────────────────────
// The CLI shares EW_STATE_DIR (which registry) and EW_MAX_CLIENTS (the cap) with the
// server, so it reads the same env file; otherwise `approve` could enforce a different cap
// or edit a different registry than the one being served.
// A copy of src/server/envFile.ts that must not drift (a .mjs cannot import the .ts): the
// same strict subset of systemd's EnvironmentFile format.
const loadEnvFile = () => {
  const explicit = process.env.EW_ENV_FILE
  if (explicit === '') return
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const candidates = explicit
    ? [explicit]
    : [join(homedir(), '.pinhole-window', 'env'), join(xdg, 'pinhole-window', 'env')]
  for (const file of candidates) {
    let text
    try {
      const st = statSync(file)
      if ((st.mode & 0o022) !== 0) {
        console.error(
          `ew-auth: ignoring ${file} — mode 0${(st.mode & 0o777).toString(8)} is writable by others (chmod 600 it)`,
        )
        continue
      }
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
      if (/^export\s/.test(line) || line.endsWith('\\')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq)
      if (!/^EW_[A-Z0-9_]+$/.test(key)) continue
      let value = line.slice(eq + 1).trim()
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1)
      }
      // The environment always wins, and an earlier file wins over a later one.
      if (process.env[key] === undefined) process.env[key] = value
    }
  }
}
loadEnvFile()

const DIR = process.env.EW_STATE_DIR || join(homedir(), '.pinhole-window')
const CLIENTS = join(DIR, 'clients.json')
const PENDING = join(DIR, 'pending.json')
const PAIRING = join(DIR, 'pairing.json')
const TESTKEY = join(DIR, 'test-client.json')
const SECRET = join(DIR, 'server-secret')
const b64u = b => Buffer.from(b).toString('base64url')
const fingerprint = pub =>
  createHash('sha256')
    .update(pub.kty === 'OKP' ? `${pub.crv}:${pub.x}` : `${pub.crv}:${pub.x}:${pub.y}`)
    .digest('hex')
const validPub = p =>
  !!p &&
  ((p.kty === 'OKP' && p.crv === 'Ed25519' && typeof p.x === 'string') ||
    (p.kty === 'EC' && p.crv === 'P-256' && typeof p.x === 'string' && typeof p.y === 'string'))

const readReg = () => {
  try {
    const r = JSON.parse(readFileSync(CLIENTS, 'utf8'))
    return Array.isArray(r?.clients) ? r : { clients: [] }
  } catch {
    return { clients: [] }
  }
}
const writeReg = r => {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CLIENTS, JSON.stringify(r, null, 2), { encoding: 'utf8', mode: 0o600 })
}
const readPending = () => {
  try {
    const r = JSON.parse(readFileSync(PENDING, 'utf8'))
    return Array.isArray(r?.pending) ? r.pending : []
  } catch {
    return []
  }
}
const writePending = list => {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeFileSync(PENDING, JSON.stringify({ pending: list }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

// Resolve an id prefix to exactly one pending device. At least 4 characters and never
// ambiguous, so an operator cannot approve or reject the wrong device. Exits with a
// message otherwise.
const findPending = prefix => {
  if (!prefix || prefix.length < 4) {
    console.error('id prefix must be at least 4 chars')
    process.exit(1)
  }
  const matches = readPending().filter(p => p.id === prefix || p.id.startsWith(prefix))
  if (!matches.length) {
    console.error(`no pending device matching "${prefix}"`)
    process.exit(1)
  }
  if (matches.length > 1) {
    console.error(
      `ambiguous prefix "${prefix}" matches ${matches.length} devices — use more characters`,
    )
    process.exit(1)
  }
  return matches[0]
}
// Carry the pending entry's source IP (captured by the server at pairing submit) onto the
// enrolled client as `addedIp`, so that `list` shows it.
const doApprove = p => {
  const reg = readReg()
  if (!reg.clients.find(c => c.id === p.id)) {
    reg.clients.push({
      id: p.id,
      name: p.name,
      pub: p.pub,
      addedAt: Date.now(),
      ...(p.ip ? { addedIp: p.ip } : {}),
    })
    writeReg(reg)
  }
  writePending(readPending().filter(x => x.id !== p.id))
}

/** EW_MAX_CLIENTS: the maximum number of enrolled keys. Must match `parseMaxClients` in
 *  src/server/auth.ts: unset ⇒ 1, `0`/`unlimited`/`off`/`none` ⇒ uncapped, plain digits ⇒ that
 *  many, anything else ⇒ 1. `Number()` is not used, or `1e3` would mean 1000. */
const maxClients = () => {
  const raw = (process.env.EW_MAX_CLIENTS ?? '').trim()
  if (raw === '') return 1
  if (/^(0|unlimited|off|none)$/i.test(raw)) return 0
  return /^\d+$/.test(raw) ? Number(raw) : 1
}

/** The remedy, printed wherever the cap bites: which keys hold the slots, the revoke
 *  command for each, and how to raise the cap. */
const printSlotRemedy = (clients, max) => {
  console.error('')
  console.error('Re-pairing does not replace a key, it adds one: a device generates a fresh')
  console.error('keypair, so the old entry would stay authorized with nobody holding it.')
  console.error('Either revoke the key this device replaces, then run this again:')
  console.error('')
  for (const c of clients)
    console.error(`  node scripts/ew-auth.mjs revoke ${c.id.slice(0, 12)}   # ${c.name}`)
  console.error('')
  console.error(`…or raise the cap on purpose, for the whole run: EW_MAX_CLIENTS=${max + 1}`)
  console.error('(put it in ~/.pinhole-window/env and restart the server; it says so at start-up).')
}

/** Enforce the cap before writing. `id` is the key about to be enrolled; an already
 *  enrolled fingerprint is never refused. Exits non-zero on refusal. */
const refuseIfFull = id => {
  const max = maxClients()
  if (max === 0) return
  const clients = readReg().clients
  if (clients.find(c => c.id === id)) return // re-enrolling the same key is not a new key
  if (clients.length < max) return
  console.error(
    `REFUSED: ${clients.length} of ${max} client key(s) already enrolled (EW_MAX_CLIENTS).`,
  )
  printSlotRemedy(clients, max)
  process.exit(1)
}

/** The same check before opening a pairing window, so that a full registry is reported
 *  now and not at `approve`. No fingerprint exists yet, so every pairing counts as a new
 *  key: a device that pairs again arrives with a fresh one. */
const refuseIfNoFreeSlot = () => {
  const max = maxClients()
  if (max === 0) return
  const clients = readReg().clients
  if (clients.length < max) return
  console.error(
    `NO FREE SLOT: ${clients.length} of ${max} client key(s) enrolled (EW_MAX_CLIENTS),`,
  )
  console.error('so a device paired now would be refused at `approve`. Not opening a window.')
  printSlotRemedy(clients, max)
  process.exit(1)
}

// A device that pairs again generates a fresh keypair, so it lands as an additional
// enrollment and its previous key stays authorized with nobody holding it. "The same
// device with a new key" and "a second device" are indistinguishable here, so the CLI
// lists the other enrollments when a new one is granted and leaves revoking to the
// operator.
const remindToRevokeOthers = id => {
  // Unreachable at the default cap of 1 (refuseIfFull exits first); this is for a
  // deliberately raised cap.
  const others = readReg().clients.filter(c => c.id !== id)
  if (!others.length) return
  console.log(`\n${others.length} other key${others.length > 1 ? 's are' : ' is'} still enrolled:`)
  for (const c of others)
    console.log(
      `  ${c.id.slice(0, 12)}…  ${c.name}  (added ${new Date(c.addedAt).toISOString()})${c.addedIp ? ` from ${c.addedIp}` : ''}`,
    )
  console.log('If this device is replacing one of them, revoke it now — a re-paired device leaves')
  console.log('its old key enrolled and nobody holding it:')
  console.log(`  node scripts/ew-auth.mjs revoke ${others[0].id.slice(0, 12)}`)
}
const doReject = p => {
  const list = readPending()
  const e = list.find(x => x.id === p.id)
  if (e) {
    e.status = 'rejected'
    writePending(list)
  }
}

// Open a pairing window. Only the code hash is stored; the plaintext code reaches the
// device in the URL the operator carries over. Single-use: the server closes the window
// on the first valid submit (src/server/auth.ts).
const openWindow = (ttlMs = 2 * 60 * 1000) => {
  const code = randomBytes(16).toString('base64url') // 128-bit one-time code
  const exp = Date.now() + ttlMs
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeFileSync(
    PAIRING,
    JSON.stringify({ codeHash: b64u(createHash('sha256').update(code).digest()), exp }),
    { encoding: 'utf8', mode: 0o600 },
  )
  return { code, exp }
}
// The app URL the device opens: the client reads `?pair=` (and `#pair=`) next to the
// `?server=` it already needs.
const pairUrl = (base, code) => {
  const b = (base || process.env.EW_APP_URL || '').replace(/\/+$/, '')
  if (!b) return `<app-url>/?pair=${code}`
  return b.includes('?') ? `${b}&pair=${code}` : `${b}/?pair=${code}`
}

const ask = q =>
  new Promise(res => {
    import('node:readline').then(({ createInterface }) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      rl.question(q, a => {
        rl.close()
        res(a)
      })
    })
  })
// Wait until `exp` for a new pending device, showing a countdown. Returns the new entry,
// or null if the window expired unused.
const waitForSubmission = (preIds, exp) =>
  new Promise(resolve => {
    const tick = () => {
      const now = Date.now()
      const fresh = readPending().find(p => !preIds.has(p.id))
      if (fresh) {
        process.stdout.write('\n')
        clearInterval(t)
        return resolve(fresh)
      }
      if (now >= exp) {
        process.stdout.write('\n')
        clearInterval(t)
        return resolve(null)
      }
      process.stdout.write(
        `\rWaiting for a device to pair… ${Math.ceil((exp - now) / 1000)}s left   `,
      )
    }
    const t = setInterval(tick, 700)
    tick()
  })

const [cmd, ...args] = process.argv.slice(2)
switch (cmd) {
  case 'list': {
    const { clients } = readReg()
    if (!clients.length) {
      console.log('(no enrolled clients)')
      break
    }
    for (const c of clients)
      console.log(
        `${c.id.slice(0, 12)}…  ${c.name}  (added ${new Date(c.addedAt).toISOString()})${c.addedIp ? ` from ${c.addedIp}` : ''}`,
      )
    break
  }
  case 'add': {
    let pub
    try {
      pub = JSON.parse(args[0])
    } catch {
      console.error("usage: add '<publicKeyJwkJson>' [name]")
      process.exit(1)
    }
    if (!validPub(pub)) {
      console.error('bad JWK: expected an Ed25519 (OKP) or P-256 (EC) public key')
      process.exit(1)
    }
    const id = fingerprint(pub)
    refuseIfFull(id)
    const reg = readReg()
    const existing = reg.clients.find(c => c.id === id)
    if (existing) {
      if (args[1]) existing.name = args[1]
      writeReg(reg)
      console.log(`already enrolled: ${id}`)
      break
    }
    reg.clients.push({ id, name: args[1] || `client-${id.slice(0, 8)}`, pub, addedAt: Date.now() })
    writeReg(reg)
    console.log(`enrolled ${id}`)
    break
  }
  case 'open': {
    // Non-interactive half of `pair`, for scripts: open the window, print the code, exit.
    // Approval stays a separate, human step (`pending` + `approve`).
    refuseIfNoFreeSlot()
    const ttl = Number(process.env.EW_PAIR_TTL_MS) || 5 * 60 * 1000
    const { code, exp } = openWindow(ttl)
    console.log(`CODE=${code}`)
    console.log(`URL=${pairUrl(args[0], code)}`)
    console.log(`EXP=${new Date(exp).toISOString()}`)
    break
  }
  case 'pair': {
    refuseIfNoFreeSlot()
    const { code, exp } = openWindow()
    const url = pairUrl(args[0], code)
    console.log('Pairing window open for 2 minutes. On the device, open (or scan):\n')
    console.log('  ' + url + '\n')
    const qr = await renderQr(url)
    if (qr) console.log(qr)
    else console.log('(no QR renderer found — install qrencode, or just open the URL above)\n')
    // A single-use window admits exactly one device. The operator compares its randomart
    // with the one on the device screen before approving: without that out-of-band check,
    // whoever holds the code is enrolled.
    const preIds = new Set(readPending().map(p => p.id))
    const entry = await waitForSubmission(preIds, exp)
    if (!entry) {
      rmSync(PAIRING, { force: true })
      console.log('No device paired within the window — closed.')
      break
    }
    console.log('\nA device is requesting to pair. Compare this pattern with the device screen:\n')
    console.log(entry.art + '\n')
    const ans = await ask('Do the patterns match on both screens? Approve this device? [y/N] ')
    if (/^y(es)?$/i.test(ans.trim())) {
      refuseIfFull(entry.id)
      doApprove(entry)
      console.log(`\napproved & enrolled ${entry.id}`)
      remindToRevokeOthers(entry.id)
    } else {
      doReject(entry)
      console.log(`\nrejected ${entry.id}`)
    }
    break
  }
  case 'pending': {
    const list = readPending()
    if (!list.length) {
      console.log('(no pending devices)')
      break
    }
    for (const p of list) {
      console.log(
        `\n${p.id.slice(0, 12)}…  ${p.name}  [${p.status}]  (${new Date(p.createdAt).toISOString()})${p.ip ? ` from ${p.ip}` : ''}`,
      )
      console.log(p.art)
    }
    console.log(
      '\nCompare the art above with the device, then: approve <idPrefix> | reject <idPrefix>',
    )
    break
  }
  case 'approve': {
    const p = findPending(args[0])
    refuseIfFull(p.id)
    doApprove(p)
    console.log(`approved & enrolled ${p.id}`)
    remindToRevokeOthers(p.id)
    break
  }
  case 'reject': {
    const p = findPending(args[0])
    doReject(p)
    console.log(`rejected ${p.id}`)
    break
  }
  case 'add-test': {
    // Prefer Ed25519 (matches the client's preference); fall back to P-256.
    let publicKey, privateKey
    try {
      ;({ publicKey, privateKey } = generateKeyPairSync('ed25519'))
    } catch {
      ;({ publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }))
    }
    const pub = publicKey.export({ format: 'jwk' })
    const priv = privateKey.export({ format: 'jwk' })
    const id = fingerprint(pub)
    refuseIfFull(id)
    const reg = readReg()
    if (!reg.clients.find(c => c.id === id)) {
      reg.clients.push({ id, name: args[0] || `test-${id.slice(0, 8)}`, pub, addedAt: Date.now() })
      writeReg(reg)
    }
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    writeFileSync(TESTKEY, JSON.stringify({ id, priv }), { encoding: 'utf8', mode: 0o600 })
    console.log(id) // clientId — pass to /api/auth/session
    break
  }
  case 'sign': {
    const nonce = args[0]
    if (!nonce) {
      console.error(
        'usage: sign <nonce> [origin]   # origin must match EW_ORIGIN when the server sets it',
      )
      process.exit(1)
    }
    const { id, priv } = JSON.parse(readFileSync(TESTKEY, 'utf8'))
    const key = createPrivateKey({ key: priv, format: 'jwk' })
    // The signature covers the version tag, the client id, the origin the caller claims
    // to be talking to, and the nonce. This copy of src/shared/sessionBinding.ts must stay
    // byte-identical to it (docs/security.md).
    const material = ['ew-session-v1', id, normaliseOrigin(args[1]), nonce].join('\n')
    // Ed25519 (OKP): null algorithm, pure EdDSA. P-256 (EC): SHA-256 + raw r||s.
    const buf = Buffer.from(material, 'utf8')
    console.log(
      b64u(
        priv.kty === 'OKP'
          ? sign(null, buf, key)
          : sign('sha256', buf, { key, dsaEncoding: 'ieee-p1363' }),
      ),
    )
    break
  }
  case 'revoke': {
    const prefix = args[0]
    if (!prefix || prefix.length < 4) {
      console.error('usage: revoke <idPrefix> (min 4 chars)')
      process.exit(1)
    }
    const reg = readReg()
    const matches = reg.clients.filter(c => c.id === prefix || c.id.startsWith(prefix))
    if (!matches.length) {
      console.error(`no client matching "${prefix}"`)
      process.exit(1)
    }
    if (matches.length > 1) {
      console.error(
        `ambiguous prefix "${prefix}" matches ${matches.length} clients — use more characters`,
      )
      process.exit(1)
    }
    reg.clients = reg.clients.filter(c => c.id !== matches[0].id)
    writeReg(reg)
    console.log(`revoked ${matches[0].id}`)
    break
  }
  case 'rotate': {
    // Rotate the token-signing secret: enrollments are untouched, but every live session
    // becomes invalid, and paired devices re-establish with their own key on the next 401.
    // The server needs no restart; it re-reads this file when it changes (src/server/auth.ts).
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    writeFileSync(SECRET, randomBytes(32).toString('base64url'), { encoding: 'utf8', mode: 0o600 })
    const n = readReg().clients.length
    console.log(`rotated ${SECRET}`)
    console.log('every live session is now invalid; devices re-establish on their next request.')
    console.log(`${n} enrolled key(s) untouched — use \`revoke\` for a device you want out.`)
    break
  }
  default:
    console.error(
      "usage: ew-auth.mjs {list|add '<jwk>' [name]|pair [appUrl]|open [appUrl]|pending|approve <id>|reject <id>|add-test [name]|sign <nonce> [origin]|revoke <idPrefix>|rotate}",
    )
    console.error(`state dir: ${DIR}  (EW_STATE_DIR)`)
    process.exit(1)
}
