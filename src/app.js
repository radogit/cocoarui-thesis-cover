import './index.css'
import {bookPortalComponent, anaglyphState} from './book-portal'
import {imageTargets} from './targets'
import {wantsPreview, setupPreview, portalPreviewComponent} from './portal-preview'

// Register before the scene initializes (bundle.js is loaded with defer in <head>).
AFRAME.registerComponent('book-portal', bookPortalComponent)
AFRAME.registerComponent('portal-preview', portalPreviewComponent)

// Desktop: show the portal on its own instead of the "open on your phone" page (see portal-preview.js).
if (wantsPreview()) setupPreview()

const onxrloaded = () => {
  XR8.XrController.configure({imageTargetData: imageTargets})
}
window.XR8 ? onxrloaded() : window.addEventListener('xrloaded', onxrloaded)

// Stereoscopic (anaglyph) button: switches red/cyan rendering on and off for every cover that supports it.
// The choice is remembered on this device.
const ANAGLYPH_KEY = 'book-portal-anaglyph'
const anaglyphButton = document.getElementById('anaglyphToggle')
try {
  anaglyphState.on = localStorage.getItem(ANAGLYPH_KEY) === '1'
} catch (e) { /* storage unavailable: start off */ }
const showAnaglyphState = () => {
  anaglyphButton.querySelector('.scopic').textContent = anaglyphState.on ? 'scopic on' : 'scopic off'
  anaglyphButton.setAttribute('aria-pressed', String(anaglyphState.on))
}
const toggleAnaglyph = () => {
  anaglyphState.on = !anaglyphState.on
  try {
    localStorage.setItem(ANAGLYPH_KEY, anaglyphState.on ? '1' : '0')
  } catch (e) { /* not remembered */ }
  if (anaglyphButton) showAnaglyphState()
}
if (anaglyphButton) {
  showAnaglyphState()
  anaglyphButton.addEventListener('click', toggleAnaglyph)
}

// Fullscreen on/off for the whole page.
const toggleFullscreen = () => {
  const doc = document
  const el = doc.documentElement
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc)
  } else {
    const request = el.requestFullscreen || el.webkitRequestFullscreen
    if (request) Promise.resolve(request.call(el)).catch(() => {})
  }
}

// Mouse cursor hidden/shown (see .hide-cursor in index.css).
const toggleCursor = () => document.documentElement.classList.toggle('hide-cursor')

// Stereoscopic button hidden/shown (see .hide-hud in index.css).
const toggleHud = () => document.documentElement.classList.toggle('hide-hud')

// Keyboard shortcuts: A = stereoscopic (anaglyph) on/off, F = fullscreen on/off, C = cursor hide/show,
// B = stereoscopic button hide/show,
// R = restart the spheres (clear them all and start spawning afresh; see book-portal.js).
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return  // leave browser shortcuts alone
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return
  if (e.code === 'KeyA') toggleAnaglyph()
  else if (e.code === 'KeyF') toggleFullscreen()
  else if (e.code === 'KeyC') toggleCursor()
  else if (e.code === 'KeyB') toggleHud()
  else if (e.code === 'KeyR') window.dispatchEvent(new Event('book-portal-reset'))
})
