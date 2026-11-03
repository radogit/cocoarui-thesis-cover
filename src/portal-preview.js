// Desktop preview: show a book portal without AR, full page, as if seen from the reading distance the
// layers are designed for (viewingDistanceCm), fitted to the window. Moving the pointer shifts the
// viewpoint a little, to show the depth.
//
// Desktop browsers get this mode automatically; phones and tablets get AR. Override with the URL:
//   ?mode=preview  or  ?mode=ar        and choose the cover with  ?cover=book-cover-back

const isPhoneOrTablet = () =>
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))  // iPadOS reports as a Mac

export const wantsPreview = () => {
  const mode = new URLSearchParams(window.location.search).get('mode')
  if (mode === 'preview') return true
  if (mode === 'ar') return false
  return !isPhoneOrTablet()
}

// Rewrite the page for preview mode. Must run before A-Frame builds the scene (it waits for the page
// to finish loading; bundle.js is deferred, so it runs before that).
export const setupPreview = () => {
  const scene = document.querySelector('a-scene')
  // No AR session, no "open on your phone" page, no camera loading screen.
  for (const attr of ['landing-page', 'xrweb', 'xrextras-loading', 'xrextras-runtime-error']) {
    scene.removeAttribute(attr)
  }

  // Take the chosen cover's portal off its image target and put it on a plain entity at the origin.
  const targets = [...document.querySelectorAll('xrextras-named-image-target')]
  const wanted = new URLSearchParams(window.location.search).get('cover')
  const chosen = targets.find(t => t.getAttribute('name') === wanted) || targets[0]
  const portalAttr = chosen.getAttribute('book-portal') || ''
  for (const t of targets) t.removeAttribute('book-portal')
  const portal = document.createElement('a-entity')
  portal.setAttribute('name', chosen.getAttribute('name'))
  portal.setAttribute('book-portal', `${portalAttr}; preview: true`)
  scene.appendChild(portal)

  const camera = document.getElementById('camera')
  camera.setAttribute('look-controls', 'enabled: false')
  camera.setAttribute('wasd-controls', 'enabled: false')
  camera.setAttribute('portal-preview', '')

  const prompt = document.getElementById('promptText')
  if (prompt) prompt.style.display = 'none'
}

// On the camera: keeps it at the reading distance in front of the portal, sets the field of view so the
// cover fits the window ("contain") or fills it ("cover"), and follows the pointer a little.
export const portalPreviewComponent = {
  init() {
    this.pointer = {x: 0, y: 0}
    this.smooth = {x: 0, y: 0}
    this.onPointer = (e) => {
      this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1
      this.pointer.y = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener('pointermove', this.onPointer)
  },

  remove() {
    window.removeEventListener('pointermove', this.onPointer)
  },

  tick(time, deltaMs) {
    const portalEl = this.el.sceneEl.querySelector('[book-portal]')
    const portal = portalEl && portalEl.components['book-portal']
    if (!portal || !portal.portalReady) return
    const THREE = AFRAME.THREE
    const cfg = portal.cfg || {}
    const preview = cfg.preview || {}
    const cmLocal = portal.localPerMeter() / 100
    const dist = Number.isFinite(portal.viewDist) ? portal.viewDist
      : (cfg.viewingDistanceCm != null ? cfg.viewingDistanceCm : 35) * cmLocal

    if (!this.backgroundSet) {
      this.el.sceneEl.object3D.background = new THREE.Color(preview.background || '#000000')
      this.backgroundSet = true
    }

    // Pointer parallax, smoothed.
    const k = 1 - Math.exp(-(deltaMs || 16) / 120)
    this.smooth.x += (this.pointer.x - this.smooth.x) * k
    this.smooth.y += (this.pointer.y - this.smooth.y) * k
    const amp = (preview.parallaxCm != null ? preview.parallaxCm : 6) * cmLocal
    const obj = this.el.object3D
    portalEl.object3D.getWorldPosition(this.center || (this.center = new THREE.Vector3()))
    obj.position.set(this.center.x + this.smooth.x * amp, this.center.y - this.smooth.y * amp, this.center.z + dist)
    // obj is the camera entity's group: lookAt() aims a group's +z at the target, but the camera inside
    // looks along -z, so aim +z directly away from the portal.
    this.away = (this.away || new THREE.Vector3()).copy(obj.position).multiplyScalar(2).sub(this.center)
    obj.lookAt(this.away)

    // Field of view: fit the cover to the window.
    const cam = this.el.getObject3D('camera')
    if (!cam) return
    const aspect = cam.aspect || window.innerWidth / window.innerHeight
    const byHeight = (portal.coverH / 2) / dist
    const byWidth = (portal.coverW / 2) / (dist * aspect)
    const tanHalf = (preview.fit === 'cover' ? Math.min(byHeight, byWidth) : Math.max(byHeight, byWidth)) *
      (preview.marginPercent != null ? 1 + preview.marginPercent / 100 : 1)
    const fov = 2 * Math.atan(tanHalf) * 180 / Math.PI
    if (Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov
      cam.updateProjectionMatrix()
    }
  },
}
