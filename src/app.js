import './index.css'
import {bookPortalComponent, anaglyphState} from './book-portal'
import {imageTargets} from './targets'

// Register before the scene initializes (bundle.js is loaded with defer in <head>).
AFRAME.registerComponent('book-portal', bookPortalComponent)

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
if (anaglyphButton) {
  showAnaglyphState()
  anaglyphButton.addEventListener('click', () => {
    anaglyphState.on = !anaglyphState.on
    try {
      localStorage.setItem(ANAGLYPH_KEY, anaglyphState.on ? '1' : '0')
    } catch (e) { /* not remembered */ }
    showAnaglyphState()
  })
}
