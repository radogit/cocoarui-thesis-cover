import './index.css'
import {bookPortalComponent} from './book-portal'
import {imageTargets} from './targets'

// Register before the scene initializes (bundle.js is loaded with defer in <head>).
AFRAME.registerComponent('book-portal', bookPortalComponent)

const onxrloaded = () => {
  XR8.XrController.configure({imageTargetData: imageTargets})
}
window.XR8 ? onxrloaded() : window.addEventListener('xrloaded', onxrloaded)
