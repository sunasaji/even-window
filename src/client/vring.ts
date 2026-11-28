// pinhole-window — vRing: a full-screen touch surface on the phone that stands in for the ring.
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import {
  OVERLAY_DIM,
  OVERLAY_TOUCH_CSS,
  PAD_CHROME_CSS,
  padChromeTop,
  setLit,
  suppressNativeTouchGestures,
} from './chrome.ts'
import { log } from './debugLog.ts'
import {
  onDouble,
  onLong,
  onSwipe,
  onTap,
  ringFire,
  VRING_LONG_BAND,
  vRingTapKind,
} from './gestures.ts'
import { mirrorEl, vringBtn } from './phoneUi.ts'
import { sttReady } from './stream.ts'
import { closeVPad } from './vpad.ts'

// One large gesture surface producing the same four actions as the row-1 pills: a vertical swipe
// anywhere → onSwipe (finger up = ring up = -1), a left-half tap → onTap (Return), a right-half
// tap → onDouble (opens the menu; inside it, goes up a level). Horizontal movement is ignored and
// the corner ✕ is the only way out.
//
// When the server has a recogniser, a tap in the band along the bottom edge → onLong (opens the
// voice dialog). It is a tap on its own zone, not a timed hold, for the reason below.
//
// Timer-free: setTimeout is unreliable under the frame-transfer load, so taps are split by
// position and decided on touchend, never by time. That is why the two zones are drawn on screen.
//
// The duplicate-fire guard (`vRingFireT` / `vRingFireKind`) is module-scope so that one physical
// gesture yields one action even if a stray second overlay or listener exists. It runs before
// `ringFire`, which de-bursts what the firmware reports and is shared with the real ring.

export let vRingOpen = false
let vRingFireT = 0
let vRingFireKind = ''
let vringEl: HTMLElement | null = null

export function closeVRing(): void {
  if (!vRingOpen && !vringEl) return
  vRingOpen = false
  if (vringEl) {
    vringEl.remove()
    vringEl = null
  }
  setLit(vringBtn, false)
  log('vRing CLOSE')
}

export function openVRing(): void {
  // A stale flag with no overlay must fall through and rebuild, or the toggle wedges "open" with
  // nothing on screen and no way back.
  if (vRingOpen && document.getElementById('vring')) return
  document.querySelectorAll('#vring').forEach(n => {
    n.remove()
  })
  closeVPad() // two full-screen pads at the same z-index: only one can own the touch layer
  vRingOpen = true
  setLit(vringBtn, true)
  log(
    'vRing OPEN — swipe up/down = Up/Down key · left tap = tap (Return) · right tap = ' +
      'double-tap, which opens the menu (and inside it goes up one level)' +
      (sttReady ? ' · bottom tap = long press (voice)' : ''),
  )

  // Read once: the band that is drawn and the band that is hit-tested must be the same one.
  // A recogniser that turns up while the pad is open takes effect the next time it opens.
  const voice = sttReady
  const band = `${String(VRING_LONG_BAND * 100)}%`

  const ov = document.createElement('div')
  ov.id = 'vring'
  // Transparent full-screen touch layer (captures every gesture, including over the mirror).
  // The dimming is a separate "hole" element below, so the glasses mirror stays fully visible
  // and bright while still acting as part of the R1 pad.
  ov.style.cssText =
    'position:fixed;inset:0;z-index:9999;' +
    'display:flex;align-items:flex-end;justify-content:center;text-align:center;' +
    'color:#9ecbff;font:14px/1.7 system-ui;' +
    OVERLAY_TOUCH_CSS
  ov.innerHTML =
    // With the band drawn, the hint stands above it.
    `<div style="pointer-events:none;padding:24px;${voice ? `margin-bottom:${String(VRING_LONG_BAND * 100)}vh;` : ''}">` +
    '<div style="font-size:18px;color:#E5E5E5;margin-bottom:12px;">vRing — Virtual R1</div>' +
    '▲▼ Swipe up/down = the Up / Down key<br>' +
    'Left tap = tap (Return) · Right tap = double-tap<br>' +
    (voice ? 'Bottom tap = long press (voice input)<br>' : '') +
    '<span style="color:#888;">Double-tap opens the menu; inside it, it goes up one ' +
    'level and closes at the top.</span><br>' +
    '<span style="color:#666;">Tap ✕ (top-right) to exit</span></div>'

  const close = document.createElement('button')
  close.textContent = '✕'
  // Same corner chrome as vPad's (PAD_CHROME_CSS / padChromeTop): both overlays frame the mirror
  // through the same hole.
  close.style.cssText =
    `position:absolute;top:max(${String(
      padChromeTop(mirrorEl ? mirrorEl.getBoundingClientRect().top : null),
    )}px,env(safe-area-inset-top));` +
    'right:max(8px,env(safe-area-inset-right));z-index:1;' +
    PAD_CHROME_CSS
  close.addEventListener('click', e => {
    e.stopPropagation()
    closeVRing()
  })
  ov.appendChild(close)
  document.body.appendChild(ov)

  // Dim everything except the glasses mirror: a transparent rect over the mirror's box with a
  // huge spread box-shadow paints the surrounding dark. `pointer-events:none` so gestures still
  // land on the touch layer; inserted first so it sits below the hint text and the ✕. Falls back
  // to a full dim if the mirror is missing. Square corners, like the panel the mirror stands for.
  if (mirrorEl) {
    const r = mirrorEl.getBoundingClientRect()
    const hole = document.createElement('div')
    hole.style.cssText =
      `position:fixed;left:${String(r.left)}px;top:${String(r.top)}px;` +
      `width:${String(r.width)}px;height:${String(r.height)}px;` +
      `box-shadow:0 0 0 9999px ${OVERLAY_DIM};pointer-events:none;`
    ov.insertBefore(hole, ov.firstChild)
  } else {
    ov.style.background = OVERLAY_DIM
  }

  // Static left/right zone guide (pointer-events none so it never blocks touch):
  // left half = tap → onTap (Return), right half = tap → onDouble.
  const zone = document.createElement('div')
  zone.style.cssText = 'position:fixed;inset:0;pointer-events:none;'
  zone.innerHTML =
    `<div style="position:absolute;left:50%;top:12%;bottom:${band};width:1px;background:rgba(255,255,255,0.18);"></div>` +
    // The zone labels name the gesture each half sends (matching the `● tap` / `●● dbl` pills in
    // row 1), not its outcome, which depends on whether the menu is open.
    '<div style="position:absolute;left:0;width:50%;top:44%;text-align:center;color:rgba(158,203,255,0.7);font:13px system-ui;">● Left: tap</div>' +
    '<div style="position:absolute;right:0;width:50%;top:44%;text-align:center;color:rgba(255,180,120,0.8);font:13px system-ui;">Right: double-tap ●●</div>' +
    // The long-press band: a rule across the divider's lower end, and its label centred below.
    (voice
      ? `<div style="position:absolute;left:0;right:0;bottom:${band};height:1px;background:rgba(255,255,255,0.18);"></div>` +
        `<div style="position:absolute;left:0;right:0;bottom:0;height:${band};display:flex;align-items:center;justify-content:center;color:rgba(170,230,170,0.8);font:13px system-ui;">▬ Bottom: long press</div>`
      : '')
  ov.appendChild(zone)

  // SWIPE_PX=40 cleanly splits taps (movement ~0) from swipes (|dy| >= 160 in practice);
  // TAP_MS caps a tap's contact time.
  const SWIPE_PX = 40,
    TAP_MS = 400
  let sx = 0,
    sy = 0,
    st = 0,
    active = false

  const fire = (name: string, fn: () => void): void => {
    const now = Date.now(),
      win = name.startsWith('swipe') ? 140 : 260
    if (name === vRingFireKind && now - vRingFireT < win) {
      // Logged rather than silent: a gesture that was de-duplicated and one that never arrived look
      // identical from outside and have opposite fixes.
      log(
        `vRing ${name} ignored — duplicate fire (+${String(now - vRingFireT)}ms, window ${String(win)}ms)`,
      )
      return
    }
    vRingFireT = now
    vRingFireKind = name
    ringFire(name, fn)
  }

  /** Resolve one completed contact into an action. Shared by the touch and the mouse path so
   *  there is exactly one copy of the mapping. */
  const resolve = (x: number, y: number, dt: number): void => {
    const dx = x - sx,
      dy = y - sy
    if (Math.abs(dy) >= SWIPE_PX && Math.abs(dy) >= Math.abs(dx)) {
      // vertical swipe (anywhere)
      const dir: -1 | 1 = dy < 0 ? -1 : 1
      fire(dir < 0 ? 'swipe -1' : 'swipe +1', () => {
        onSwipe(dir)
      })
      return
    }
    // moved too far / held too long → not a tap
    if (dt > TAP_MS || Math.abs(dx) >= SWIPE_PX || Math.abs(dy) >= SWIPE_PX) return
    const kind = vRingTapKind(x, y, window.innerWidth, window.innerHeight, voice)
    if (kind === 'long')
      fire('long', () => {
        onLong('vRing')
      }) // bottom band
    else if (kind === 'double')
      fire('double', () => {
        void onDouble()
      }) // right half
    else
      fire('single', () => {
        void onTap()
      }) // left half → Return
  }

  const inClose = (x: number, y: number): boolean => {
    const r = close.getBoundingClientRect()
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  }

  const onStart = (e: TouchEvent): void => {
    const t = e.touches[0]
    if (!t || close.contains(e.target as Node) || e.touches.length !== 1) return
    sx = t.clientX
    sy = t.clientY
    st = Date.now()
    active = true
    e.preventDefault()
  }
  const onEnd = (e: TouchEvent): void => {
    const t = e.changedTouches[0]
    if (!t || close.contains(e.target as Node) || !active) return
    active = false
    e.preventDefault()
    resolve(t.clientX, t.clientY, Date.now() - st)
  }
  ov.addEventListener('touchstart', onStart, { passive: false })
  ov.addEventListener('touchend', onEnd, { passive: false })
  ov.addEventListener(
    'touchcancel',
    () => {
      active = false
    },
    { passive: false },
  )
  // vRing's own handlers bail before `preventDefault()` on a second finger and there is no
  // `touchmove` listener, so a two-finger contact or a long drag still has a native default.
  // This cancels it.
  suppressNativeTouchGestures(ov, 'vRing', inClose)

  // Mouse path, for the simulator and desktop where there is no touch. Gated on
  // `pointerType === 'mouse'`: on a touch device `preventDefault()` above suppresses the
  // compatibility pointer events, and the module-scope guard is the backstop.
  ov.addEventListener(
    'pointerdown',
    e => {
      if (e.pointerType !== 'mouse' || inClose(e.clientX, e.clientY)) return
      e.preventDefault()
      sx = e.clientX
      sy = e.clientY
      st = Date.now()
      active = true
    },
    { passive: false },
  )
  ov.addEventListener(
    'pointerup',
    e => {
      if (e.pointerType !== 'mouse' || !active) return
      if (inClose(e.clientX, e.clientY)) {
        active = false
        return
      }
      active = false
      e.preventDefault()
      resolve(e.clientX, e.clientY, Date.now() - st)
    },
    { passive: false },
  )
  ov.addEventListener('contextmenu', e => {
    e.preventDefault()
  })

  vringEl = ov
}
