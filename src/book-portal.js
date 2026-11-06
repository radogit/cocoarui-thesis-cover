// book-portal: turns a tracked image target (a book cover) into a portal that spheres fly out of.
//
// Attach to an <xrextras-named-image-target>. Coordinates:
//   * Target-local space: the cover lies in the XY plane, +Z points out of the cover toward the viewer,
//     and 1 unit = the height of the tracked 3:4 crop.
//   * World space: 8th Wall world tracking makes +Y point up. Once a sphere has crossed the cover
//     plane it moves to the scene root, so it keeps flying even if the cover is lost from view.
//
// Spheres start at a vanishing point in the centre of the cover, deep inside the portal, and fly in a
// straight line perpendicular out of the cover (toward a viewer looking at it head-on), each deviating
// by a random angle of up to spreadDegX / spreadDegY. They don't follow the viewer's position. After lifetimeS seconds they have faded out and are removed.
// Optionally ("gravity": true) they instead fall, bounce on the ground and roll once outside.
//
// Everything about the inner world and the spheres is set in the JSON file given by the `layers`
// attribute (default /assets/layers/layers.json = src/assets/layers/layers.json). See README.md.
// Distances are in centimeters/meters and converted to scene units using the real cover height
// (coverHeightMeters), so the motion looks right at the book's scale.

import {imageTargets} from './targets'

const G = 9.81
const DEG = Math.PI / 180

// Defaults for the "spheres" section of layers.json.
const SPHERE_DEFAULTS = {
  spawnRate: 3,              // spheres per second while the cover is tracked
  firstSpawnDelay: 0,        // seconds before a stream's first sphere (at start and after R); staggers streams
  spawnRateVariability: 0,   // 0..1: each gap between spheres varies randomly by up to ± this share
                             // (0.3 = 70%..130% of the average gap); the average rate stays spawnRate
  maxSpheres: 40,
  radiusCm: 1.5,             // sphere radius; a number, or [min, max] for a random size per sphere
  speedCmPerS: 40,
  lifetimeS: 1.8,            // total life, from leaving the vanishing point
  fadeS: 0.7,                // fade-out at the end of the life
  opacityPercent: [30, 60],  // random opacity per sphere, between these two values
  originCmX: 0,              // centre of the start point: 'out' = behind the cover at spawnDepthCm,
  originCmY: 0,              //   'in' = in front of it at startDistanceCm (cm from the cover's centre)
  targetCmX: 0,              // 'in': centre of the entry area on the cover (cm from the cover's centre)
  targetCmY: 0,
  colors: null,              // list of hex colours, e.g. ["#8A5CFF", "#40C4FF"]; each sphere picks one at random
                             // (null = random violets, magentas and cyans)
  streams: null,             // optional list of streams; each one overrides any of these settings
                             // (e.g. its own origin, spread, spawnRate) and spawns at its own spawnRate
  spawnRangeCmX: 0,          // vanishing point spread left/right of the centre: a number n = random in [-n, n],
  spawnRangeCmY: 0,          // or [min, max] (negative = left/down). Same for up/down.
  aim: 'straight',           // 'straight' = perpendicular out of the cover (toward a viewer facing it head-on),
                             // 'camera' = toward the phone's current position
  aimDegX: 0,                // fixed tilt of the aim direction: + = right, - = left
  aimDegY: 0,                // fixed tilt of the aim direction: + = up, - = down
  spreadDegX: 3,             // max random deviation left/right from the aim direction
  spreadDegY: 3,             // max random deviation up/down
  spawnDepthCm: null,        // vanishing point depth behind the cover; null = 1 cm in front of the deepest layer
  gravity: false,            // true = fall, bounce and roll once out of the portal
  direction: 'out',          // 'out' = from the vanishing point out of the cover;
                             // 'in'  = from a point straight out in front of the cover, into the cover (aim,
                             //         spread and gravity are not used; spawnRangeCmX/Y = entry area on the cover)
  startDistanceCm: 50,       // 'in': distance of the start point in front of the cover, on its centre line
  startRangeCmX: 0,          // 'in': random offset of the start point left/right (n = within ±n cm, or [min, max])
  startRangeCmY: 0,          // 'in': same, up/down
  mask: null,                // name of a mask from "masks": behind the mask's plane spheres show only inside it;
                             // 'in': at the plane, spheres inside the mask fly on into the cover, the others
                             // stop there and fade out
  passPercent: 50,           // with mask: share of the sphere that must be inside the mask to fly on
  perishFadeS: 0.25,         // with mask: how fast spheres that don't pass fade out (they stay masked meanwhile)
                             // at the plane, spheres outside the mask perish and those inside fly on, unmasked
}

// Photoshop-style blend modes for layers. The shader mixes transparent pixels toward the mode's
// neutral color (white for multiply, black for screen), then the GPU blends with what's behind.
const BLEND_MODES = {
  multiply: {src: 'ZeroFactor', dst: 'SrcColorFactor', glsl: 'gl_FragColor.rgb = mix(vec3(1.0), gl_FragColor.rgb, gl_FragColor.a);'},
  screen: {src: 'OneFactor', dst: 'OneMinusSrcColorFactor', glsl: 'gl_FragColor.rgb *= gl_FragColor.a;'},
}

// Stencil bits are shared by all portals in the page (8 in total), so masks of two covers that are
// in view at the same time don't interfere.
let nextStencilBit = 0

// Anaglyph 3D (layers.json "anaglyph"). Split objects are drawn twice: a left-eye copy that writes only
// the red channel and a right-eye copy that writes only cyan (or blue). Each vertex is shifted sideways
// (view-space x) by the stereo disparity for its distance from the phone, relative to a baseline plane:
// for a point at distance d whose line of sight meets the baseline at distance c, the left-eye copy moves
// by +e/2 * (1 - d/c) and the right-eye copy by the opposite. On the baseline the copies coincide; in
// front of it they cross (seen floating out), behind it they part the other way (seen deeper).
const ANAGLYPH_UNIFORMS_GLSL = 'uniform vec3 uAnaN;\nuniform float uAnaD;\nuniform float uAnaHalf;\nuniform float uAnaSign;\n'
const ANAGLYPH_GLSL = `
{
  float anaDen = dot(uAnaN, mvPosition.xyz);  // baseline plane (view space): dot(uAnaN, x) = uAnaD
  if (abs(anaDen) > 1e-6) {
    float anaS = uAnaD / anaDen;  // the line of sight meets the baseline at anaS * this vertex (c/d)
    if (anaS > 0.0) mvPosition.x += uAnaSign * uAnaHalf * (1.0 - 1.0 / anaS);
  }
  gl_Position = projectionMatrix * mvPosition;
}`

// Anaglyph on/off for the whole page, switched live by the stereoscopic button (see app.js). Covers whose config
// has "anaglyph": {"enabled": true} are prepared for it; this decides whether it is shown.
export const anaglyphState = {on: false}

// Add the anaglyph shift to a material (keeping any shader changes it already has).
const addAnaglyphShader = (mat, sign, sharedUniforms) => {
  const prevCompile = mat.onBeforeCompile
  const prevKey = mat.customProgramCacheKey
  const signUniform = {value: sign}
  mat.onBeforeCompile = (shader, renderer) => {
    prevCompile.call(mat, shader, renderer)
    Object.assign(shader.uniforms, sharedUniforms, {uAnaSign: signUniform})
    shader.vertexShader = ANAGLYPH_UNIFORMS_GLSL +
      shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\n${ANAGLYPH_GLSL}`)
  }
  mat.customProgramCacheKey = () => `${prevKey.call(mat)}|anaglyph`
}

// Let a mesh write only some color channels. three.js only has an all-or-nothing colorWrite, so set the
// WebGL mask around the draw (after syncing three's cached state, so it doesn't override ours).
const setColorChannels = (mesh, [r, g, b]) => {
  mesh.onBeforeRender = (renderer) => {
    if (!anaglyphState.on) return  // normal full-color drawing
    renderer.state.buffers.color.setMask(true)
    renderer.getContext().colorMask(r, g, b, true)
  }
  mesh.onAfterRender = (renderer) => renderer.getContext().colorMask(true, true, true, true)
}

// A config value that is either a number or a [min, max] range: returns a random value in it.
const randomIn = (v, symmetric = false) => {
  if (Array.isArray(v)) return v[0] + Math.random() * (v[1] - v[0])
  const n = Number(v) || 0
  return symmetric ? (Math.random() * 2 - 1) * n : n
}

export const bookPortalComponent = {
  schema: {
    coverHeightMeters: {default: 0.24},  // real height of the printed cover; sets the physical scale
    layers: {default: 'assets/layers/layers.json'},  // inner-world + sphere config; '' = defaults only
    preview: {default: false},           // desktop preview (no AR): no border around the cover
    innerColor: {default: '#383DAA'},    // used only if layers.json has no innerColor
    tunnelDepth: {default: 1.2},         // portal depth in crop heights, used only when there are no layers
    // Only used with "gravity": true:
    restitution: {default: 0.45},        // ground bounce: 0 = dead stop, 1 = perfectly elastic
    sphereRestitution: {default: 0.6},   // sphere-sphere bounces
    bounceFriction: {default: 0.8},      // fraction of horizontal speed kept per bounce
    rollDamping: {default: 1.5},         // 1/s, how fast rolling spheres slow down
    restSpeed: {default: 0.12},          // m/s, impact speeds below this stop bouncing
  },

  init() {
    const THREE = AFRAME.THREE
    this.THREE = THREE
    this.spheres = []
    // R key (app.js): clear all spheres and start spawning from scratch.
    this.onReset = () => this.resetSpheres()
    window.addEventListener('book-portal-reset', this.onReset)
    this.groundY = null
    this.groundCenter = new THREE.Vector3()
    this.worldQuat = new THREE.Quaternion()
    this.worldScaleVec = new THREE.Vector3()
    this.tmp = new THREE.Vector3()
    this.tmp2 = new THREE.Vector3()
    this.axisX = new THREE.Vector3(1, 0, 0)
    this.axisY = new THREE.Vector3(0, 1, 0)
    this.layerZs = []  // layer depths, deepest first (for draw order)
    this.sp = {...SPHERE_DEFAULTS}

    // Cover size in target-local units. 8th Wall sets 1 unit = tracked crop height; make-target.py
    // stores the full cover size (it can be taller or wider than the crop) in metadata.
    // The target is the one named on this entity (<xrextras-named-image-target name="...">).
    const targetName = this.el.getAttribute('name')
    const target = imageTargets.find(t => t.name === targetName)
    if (!target) console.warn(`[book-portal] no image target named "${targetName}" in src/targets/index.js`)
    const meta = (target && target.metadata) || {}
    this.coverW = meta.coverWidth || 0.75
    this.coverH = meta.coverHeight || 1

    this.portalRoot = new THREE.Group()
    this.el.object3D.add(this.portalRoot)
    this.portalReady = false
    this.loadConfig()

    // Shared sphere geometry, unit radius (scaled per sphere).
    this.sphereGeometry = new THREE.SphereGeometry(1, 24, 16)

    // Shadow catcher at ground level (world space), used only in gravity mode.
    const shadowMat = new THREE.ShadowMaterial({opacity: 0.3})
    // Pull the shadow plane slightly toward the camera so it doesn't z-fight with the portal occluder
    // when the book lies flat (both planes are then at the same height).
    shadowMat.polygonOffset = true
    shadowMat.polygonOffsetFactor = -2
    shadowMat.polygonOffsetUnits = -4
    this.shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat)
    this.shadowPlane.rotation.x = -Math.PI / 2
    this.shadowPlane.receiveShadow = true
    this.shadowPlane.visible = false
    this.el.sceneEl.object3D.add(this.shadowPlane)

    this.el.addEventListener('xrextrasfound', () => {
      const prompt = document.getElementById('promptText')
      if (prompt) prompt.style.display = 'none'
    })
  },

  // Local units per meter, for the current cover.
  localPerMeter() {
    return this.coverH / this.data.coverHeightMeters
  },

  // Fetch layers.json, then build the portal.
  async loadConfig() {
    let cfg = {}
    const url = this.data.layers
    if (url) {
      try {
        const res = await fetch(url, {cache: 'no-cache'})
        if (res.ok) cfg = await res.json()
        else console.warn(`[book-portal] no config at ${url} (HTTP ${res.status}); using defaults`)
      } catch (e) {
        console.warn(`[book-portal] could not load config ${url}:`, e)
      }
    }
    const spheres = cfg.spheres || {}
    this.sp = {...SPHERE_DEFAULTS, ...spheres}
    // Older configs had spawnDepthCm at the top level.
    if (spheres.spawnDepthCm == null && cfg.spawnDepthCm != null) this.sp.spawnDepthCm = cfg.spawnDepthCm
    this.buildPortal(cfg, url)
    this.portalReady = true
  },

  // Scale factor for a plane at local depth z (negative = behind the cover) so that, seen straight
  // on from the viewing distance, it covers exactly the cover outline.
  depthScale(z) {
    if (!Number.isFinite(this.viewDist)) return 1
    return (this.viewDist - z) / this.viewDist
  },

  buildPortal(cfg, cfgUrl) {
    const THREE = this.THREE
    this.cfg = cfg
    const w = this.coverW
    const h = this.coverH
    const cm = v => (v / 100) * this.localPerMeter()  // centimeters -> local units

    const layers = (Array.isArray(cfg.layers) ? cfg.layers : [])
      .filter(l => l && l.file)
      .map(l => ({...l, z: -cm(l.depthCm || 0)}))
      .sort((a, b) => a.z - b.z)  // deepest first
    this.layerZs = layers.map(l => l.z)

    // Anaglyph settings ("anaglyph": {"enabled": true, ...}).
    const ana = cfg.anaglyph || {}
    this.ana = null
    if (ana.enabled) {
      let baseZ = 0
      if (typeof ana.baseline === 'number') {
        baseZ = -cm(ana.baseline)  // a depth in cm
      } else if (ana.baseline) {
        const baseLayer = layers.find(l => l.file === ana.baseline)
        if (baseLayer) baseZ = baseLayer.z
        else console.warn(`[book-portal] anaglyph baseline "${ana.baseline}" is not a layer; using the cover surface`)
      }
      this.ana = {
        baseZ,
        halfSepCm: (ana.eyeSeparationCm != null ? ana.eyeSeparationCm : 1) / 2,
        layers: new Set(ana.layers || []),
        spheres: ana.spheres !== false,
        rightChannels: ana.glasses === 'red-blue' ? [false, false, true] : [false, true, true],
      }
      for (const f of this.ana.layers) {
        if (!layers.some(l => l.file === f)) {
          console.warn(`[book-portal] anaglyph layer "${f}" is not in "layers"; it gets no 3D effect`)
        }
      }
      this.anaUniforms = {
        uAnaN: {value: new THREE.Vector3(0, 0, 1)}, uAnaD: {value: 0}, uAnaHalf: {value: 0},
      }
      this.anaRightMats = new Set()
      const button = document.getElementById('anaglyphToggle')
      if (button) button.hidden = false  // at least one cover can show 3D
    }

    if (layers.length) {
      this.viewDist = cm(cfg.viewingDistanceCm != null ? cfg.viewingDistanceCm : 35)
      const deepest = Math.max(0, -layers[0].z)
      this.tunnelDepth = Math.max(deepest, cm(2)) + cm(0.5)  // tunnel ends just behind the deepest layer
      this.spawnDepth = this.sp.spawnDepthCm != null
        ? cm(this.sp.spawnDepthCm)
        : Math.max(deepest - cm(1), cm(1))
    } else {
      this.viewDist = Infinity  // no perspective scaling: a straight tunnel
      this.tunnelDepth = this.data.tunnelDepth
      this.spawnDepth = this.sp.spawnDepthCm != null ? cm(this.sp.spawnDepthCm) : this.tunnelDepth * 0.9
    }
    // A vanishing point deeper than the tunnel would sit behind its back wall: extend the tunnel.
    // Streams: each is the shared sphere settings plus its own overrides.
    const {streams, ...shared} = this.sp
    this.streams = (Array.isArray(streams) && streams.length ? streams : [{}]).map(st => {
      const merged = {...shared, ...st}
      merged.spawnDepth = st.spawnDepthCm != null ? cm(st.spawnDepthCm) : this.spawnDepth
      merged.wait = this.firstWait(merged)  // seconds until this stream's next sphere
      return merged
    })
    const deepestSpawn = Math.max(...this.streams.map(st => st.spawnDepth))
    this.tunnelDepth = Math.max(this.tunnelDepth, deepestSpawn + cm(0.5))
    const d = this.tunnelDepth
    const backScale = this.depthScale(-d)

    // 1) Occluder: an invisible frame around the cover hole. It writes depth but no color, so the
    //    camera feed shows through, but anything behind the cover plane is hidden unless it is seen
    //    through the hole. Rendered first (renderOrder) so it masks the tunnel, layers and spheres.
    const occMat = new THREE.MeshBasicMaterial({colorWrite: false})
    // Wide enough to hide the tunnel's (and layers') far edges at oblique viewing angles.
    const R = d * 2.5 + (backScale - 1) * Math.max(w, h)
    const occParts = [
      [w + 2 * R, R, 0, h / 2 + R / 2],   // top
      [w + 2 * R, R, 0, -h / 2 - R / 2],  // bottom
      [R, h, -w / 2 - R / 2, 0],          // left
      [R, h, w / 2 + R / 2, 0],           // right
    ]
    occParts.forEach(([pw, ph, x, y]) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), occMat)
      m.position.set(x, y, 0)
      m.renderOrder = -10
      this.portalRoot.add(m)
    })

    // 1b) Border: a flat frame lying on the cover plane, just OUTSIDE the tracked image edge.
    //     Settings come from layers.json "border": {thicknessCm, opacityPercent, color}.
    const border = cfg.border || {}
    const t = this.data.preview ? 0 : cm(border.thicknessCm != null ? border.thicknessCm : 0)
    if (t > 0) {
      const bOpacity = border.opacityPercent != null ? border.opacityPercent / 100 : 1
      const borderMat = new THREE.MeshBasicMaterial({
        color: border.color || '#000000',
        transparent: bOpacity < 1,
        opacity: bOpacity,
        toneMapped: false,
        // Same plane as the invisible occluder: nudge toward the camera so it always wins.
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      })
      // Top and bottom bars span the corners; side bars fit between them (no overlap, so a
      // semi-transparent border has even opacity everywhere).
      const borderParts = [
        [w + 2 * t, t, 0, h / 2 + t / 2],    // top
        [w + 2 * t, t, 0, -h / 2 - t / 2],   // bottom
        [t, h, -w / 2 - t / 2, 0],           // left
        [t, h, w / 2 + t / 2, 0],            // right
      ]
      borderParts.forEach(([pw, ph, x, y]) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), borderMat)
        m.position.set(x, y, 0)
        m.renderOrder = -5  // after the occluder
        this.portalRoot.add(m)
      })
    }

    // 2) Tunnel: a box seen from inside (BackSide). Its front face points at the viewer and is culled,
    //    so the box looks open at the cover. With layers, it widens with depth (a frustum) to match
    //    the layers' scaling, so from the reference viewpoint its walls are seen edge-on.
    //    Unlit vertical gradient: innerColor at the top, innerColorBottom at the bottom
    //    (same color top and bottom if innerColorBottom is not set).
    const tunnelGeo = new THREE.BoxGeometry(w, h, d, 1, 1, 12)
    tunnelGeo.translate(0, 0, -d / 2)
    const pos = tunnelGeo.attributes.position
    const topColor = new THREE.Color(cfg.innerColor || this.data.innerColor)
    const bottomColor = new THREE.Color(cfg.innerColorBottom || cfg.innerColor || this.data.innerColor)
    const colors = new Float32Array(pos.count * 3)
    const c = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const t = 0.5 - pos.getY(i) / h  // 0 at the top edge, 1 at the bottom edge
      c.copy(topColor).lerp(bottomColor, t).toArray(colors, i * 3)
      const s = this.depthScale(pos.getZ(i))
      pos.setXY(i, pos.getX(i) * s, pos.getY(i) * s)
    }
    tunnelGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.portalRoot.add(new THREE.Mesh(tunnelGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, toneMapped: false,
    })))

    const loader = new THREE.TextureLoader()
    const renderer = this.el.sceneEl.renderer
    const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 1
    const base = new URL(cfgUrl || '/', window.location.href)

    // 2b) Masks (layers.json "masks"): invisible shapes, e.g. the glasses' lenses, that mark where
    //     a layer may be seen. Each mask is a plane at its own depth that writes one bit of the
    //     stencil buffer wherever its image is opaque. Masked layers then draw only where that bit
    //     is set ("show": "inside") or only where it is not ("show": "outside"). Because the mask
    //     sits at its own depth, the masked area shifts over deeper layers with parallax, like
    //     looking through real glasses.
    const maskBits = {}
    this.masks = {}  // name -> {bit, z, pw, ph, alpha, iw, ih}; alpha is filled in once the image loads
    Object.entries(cfg.masks || {}).forEach(([name, m]) => {
      if (!m || !m.file) return
      if (nextStencilBit > 7) { console.warn(`[book-portal] at most 8 masks in total; ignoring "${name}"`); return }
      const bit = 1 << nextStencilBit++
      maskBits[name] = bit
      const z = -cm(m.depthCm || 0)
      const s = this.depthScale(z)
      const mat = new THREE.MeshBasicMaterial({
        colorWrite: false, depthWrite: false,
        alphaTest: 0.5,  // only the opaque part of the mask image writes the stencil
        stencilWrite: true, stencilRef: bit, stencilWriteMask: bit,
        stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
      })
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w * s, h * s), mat)
      mesh.position.set(0, 0, z)
      const info = {bit, z, pw: w * s, ph: h * s, alpha: null, iw: 0, ih: 0}
      this.masks[name] = info
      mesh.renderOrder = -9  // opaque pass, before the tunnel and all layers
      mesh.visible = false   // until loaded; without its image it would mask the whole cover
      this.portalRoot.add(mesh)
      const fileUrl = new URL(m.file, base).href
      loader.load(fileUrl, (tex) => {
        mat.map = tex
        mat.needsUpdate = true
        mesh.visible = true
        // Keep the mask's alpha on the CPU, to test where spheres cross it.
        const img = tex.image
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d', {willReadFrequently: true})
        ctx.drawImage(img, 0, 0)
        const rgba = ctx.getImageData(0, 0, img.width, img.height).data
        const alpha = new Uint8Array(img.width * img.height)
        for (let p = 0; p < alpha.length; p++) alpha[p] = rgba[p * 4 + 3]
        Object.assign(info, {alpha, iw: img.width, ih: img.height})
      }, undefined, () => console.error(`[book-portal] could not load mask image ${fileUrl}`))
    })
    if (Object.keys(maskBits).length && renderer) {
      const attrs = renderer.getContext().getContextAttributes()
      if (attrs && !attrs.stencil) console.warn('[book-portal] the WebGL canvas has no stencil buffer; masks will not work')
      this.usesStencil = true
    }

    // 3) Cover layers, back to front. Layer i gets renderOrder 2i+1; spheres get the even numbers
    //    in between, according to their depth, so they appear between the right layers.
    layers.forEach((layer, i) => {
      // scalePercent enlarges/shrinks the layer around the cover's centre, on top of the depth scaling.
      const s = (layer.scale != null ? layer.scale : this.depthScale(layer.z)) *
        (layer.scalePercent != null ? layer.scalePercent / 100 : 1)
      let opacity = 1
      if (layer.opacityPercent != null) opacity = layer.opacityPercent / 100
      else if (layer.opacity != null) opacity = layer.opacity
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,   // PNG alpha; soft edges (blur, glow) blend correctly
        depthWrite: false,   // layers don't hide each other by depth; draw order does that
        opacity,
        toneMapped: false,   // show the artwork's colors as they are
        // A layer on the cover plane is level with the invisible occluder around the hole: push it a hair
        // back so the occluder hides any part of it outside the hole (e.g. a wider image's bleed).
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
      const blend = (layer.blend || 'normal').toLowerCase()
      const mode = BLEND_MODES[blend]
      if (mode) {
        mat.blending = THREE.CustomBlending
        mat.blendEquation = THREE.AddEquation
        mat.blendSrc = THREE[mode.src]
        mat.blendDst = THREE[mode.dst]
        mat.onBeforeCompile = (shader) => {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `#include <dithering_fragment>\n${mode.glsl}\ngl_FragColor.a = 1.0;`)
        }
        mat.customProgramCacheKey = () => `blend-${blend}`
      } else if (blend !== 'normal') {
        console.warn(`[book-portal] unknown blend "${layer.blend}" for ${layer.file}; ` +
          `use normal, ${Object.keys(BLEND_MODES).join(', ')}`)
      }
      if (layer.mask) {
        const bit = maskBits[layer.mask]
        if (bit) {
          const show = (layer.show || 'inside').toLowerCase()
          Object.assign(mat, {
            stencilWrite: true,  // in three.js this switches the stencil test on
            stencilRef: bit, stencilFuncMask: bit, stencilWriteMask: 0,  // test only, never modify
            stencilFunc: show === 'outside' ? THREE.NotEqualStencilFunc : THREE.EqualStencilFunc,
          })
          if (show !== 'inside' && show !== 'outside') {
            console.warn(`[book-portal] "show" for ${layer.file} must be "inside" or "outside"; using inside`)
          }
        } else {
          console.warn(`[book-portal] layer ${layer.file} uses mask "${layer.mask}", which is not defined in ` +
            `"masks" (defined: ${Object.keys(maskBits).join(', ') || 'none'})`)
        }
      }
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w * s, h * s), mat)
      mesh.position.set(0, 0, layer.z)
      mesh.renderOrder = 2 * i + 1
      mesh.visible = false   // until the texture has loaded
      this.portalRoot.add(mesh)
      const mats = this.ana && this.ana.layers.has(layer.file) ? this.anaglyphSplit(mesh) : [mat]

      const fileUrl = new URL(layer.file, base).href
      loader.load(fileUrl, (tex) => {
        if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace
        else tex.encoding = THREE.sRGBEncoding
        tex.anisotropy = maxAniso  // keeps layers sharp when seen at an angle
        const {width: iw, height: ih} = tex.image
        // Image proportions differ from the cover: "fit": "cover" (default) scales the image to fill the
        // frame, keeping its proportions; the overflow (bleed) sticks out past the cover edge, centred,
        // where the occluder hides it. It shows up only when needed, e.g. when the anaglyph copies shift
        // sideways or the cover is seen at an angle. "stretch" distorts the image to the frame instead.
        const imgAspect = iw / ih
        const frameAspect = w / h
        const fit = (layer.fit || 'cover').toLowerCase()
        if (fit === 'cover') {
          mesh.scale.set(Math.max(1, imgAspect / frameAspect), Math.max(1, frameAspect / imgAspect), 1)
        } else if (fit !== 'cover' && fit !== 'stretch') {
          console.warn(`[book-portal] "fit" for ${layer.file} must be "cover" or "stretch"; using stretch`)
        }
        if (Math.max(iw, ih) > 2048) {
          console.warn(`[book-portal] layer ${layer.file} is ${iw}x${ih}. Layers over 2048 px use a lot of ` +
            'GPU memory on phones; consider exporting at most 2048 px tall.')
        }
        for (const m of mats) {
          m.map = tex
          m.needsUpdate = true
        }
        mesh.visible = true
      }, undefined, () => console.error(`[book-portal] could not load layer image ${fileUrl}`))
    })
  },

  // Anaglyph: turn mesh into the left-eye (red) copy and add a right-eye (cyan/blue) twin as its child,
  // so it follows every move. Returns both materials, to keep them in sync.
  anaglyphSplit(mesh) {
    const left = mesh.material
    const right = left.clone()
    right.onBeforeCompile = left.onBeforeCompile  // clone() does not copy these
    right.customProgramCacheKey = left.customProgramCacheKey
    addAnaglyphShader(left, 1, this.anaUniforms)
    addAnaglyphShader(right, -1, this.anaUniforms)
    right.visible = anaglyphState.on  // the right-eye copy is drawn only while 3D is on
    this.anaRightMats.add(right)
    const twin = new this.THREE.Mesh(mesh.geometry, right)
    twin.renderOrder = mesh.renderOrder
    mesh.add(twin)
    setColorChannels(mesh, [true, false, false])
    setColorChannels(twin, this.ana.rightChannels)
    return [left, right]
  },

  // Anaglyph: the baseline plane in view space, and half the eye separation in view units.
  updateAnaglyph() {
    const THREE = this.THREE
    const cam = this.el.sceneEl.camera
    if (!cam) return
    cam.updateMatrixWorld()
    if (!this.anaView) {
      this.anaView = new THREE.Matrix4()
      this.anaNormal = new THREE.Matrix3()
      this.anaPoint = new THREE.Vector3()
    }
    const view = this.anaView.copy(cam.matrixWorld).invert().multiply(this.portalRoot.matrixWorld)
    const p = this.anaPoint.set(0, 0, this.ana.baseZ).applyMatrix4(view)
    const n = this.anaUniforms.uAnaN.value.set(0, 0, 1).applyMatrix3(this.anaNormal.getNormalMatrix(view)).normalize()
    this.anaUniforms.uAnaD.value = n.dot(p)
    // With stereoscopic off, no shift: the left-eye copy is then drawn as the normal, full-color object.
    this.anaUniforms.uAnaHalf.value = anaglyphState.on
      ? this.ana.halfSepCm * (this.localPerMeter() / 100) * this.worldScale : 0
    for (const m of this.anaRightMats) m.visible = anaglyphState.on
  },

  // Sphere draw order, for both anaglyph copies.
  setSphereOrder(s, order) {
    s.mesh.renderOrder = order
    for (const c of s.mesh.children) c.renderOrder = order
  },

  // 'in' direction: start at a point startDistanceCm straight out in front of the cover's centre (plus
  // a random offset within startRangeCmX/Y), fly to a random entry point within spawnRangeCmX/Y on the
  // cover and continue on the same line to spawnDepthCm behind it. Independent of where the phone is.
  // Returns {start, vel, life} in local units.
  incomingPath(sp) {
    const THREE = this.THREE
    const lpm = this.localPerMeter()
    const cmLocal = lpm / 100
    const start = new THREE.Vector3(
      (sp.originCmX + randomIn(sp.startRangeCmX, true)) * cmLocal,
      (sp.originCmY + randomIn(sp.startRangeCmY, true)) * cmLocal,
      Math.max(1, sp.startDistanceCm) * cmLocal)
    const entry = new THREE.Vector3(
      (sp.targetCmX + randomIn(sp.spawnRangeCmX, true)) * cmLocal,
      (sp.targetCmY + randomIn(sp.spawnRangeCmY, true)) * cmLocal,
      0)
    const dir = new THREE.Vector3().subVectors(entry, start).normalize()
    const dist = start.distanceTo(entry) + sp.spawnDepth / -dir.z  // to the cover, then to spawn depth
    const speed = (sp.speedCmPerS / 100) * lpm * (0.85 + Math.random() * 0.3)
    return {start, vel: dir.multiplyScalar(speed), life: dist / speed}
  },

  spawnSphere(sp) {
    const THREE = this.THREE
    const lpm = this.localPerMeter()

    if (sp.direction === 'in') {
      const path = this.incomingPath(sp)
      this.addSphere(path.start, path.vel, 'incoming', path.life, sp)
      return
    }

    // Vanishing point: centre of the cover, spawnDepth behind it, plus a random offset within
    // spawnRangeCmX / spawnRangeCmY.
    const cmLocal = lpm / 100
    const start = new THREE.Vector3(
      (sp.originCmX + randomIn(sp.spawnRangeCmX, true)) * cmLocal,
      (sp.originCmY + randomIn(sp.spawnRangeCmY, true)) * cmLocal,
      -sp.spawnDepth)

    // Base direction: toward the camera (the viewer's face), or straight out of the cover.
    const dir = new THREE.Vector3(0, 0, 1)
    const cam = this.el.sceneEl.camera
    if (sp.aim === 'camera' && cam) {
      cam.getWorldPosition(this.tmp)
      this.portalRoot.worldToLocal(this.tmp)
      if (this.tmp.z > 0) dir.subVectors(this.tmp, start).normalize()
    }
    // Fixed tilt: left/right (about Y; + = right), then up/down (about X; + = up).
    dir.applyAxisAngle(this.axisY, sp.aimDegX * DEG)
    dir.applyAxisAngle(this.axisX, -sp.aimDegY * DEG)
    // Random deviation within the arc: left/right (about Y), then up/down (about X).
    dir.applyAxisAngle(this.axisY, (Math.random() * 2 - 1) * sp.spreadDegX * DEG)
    dir.applyAxisAngle(this.axisX, (Math.random() * 2 - 1) * sp.spreadDegY * DEG)
    const vel = dir.multiplyScalar((sp.speedCmPerS / 100) * lpm * (0.85 + Math.random() * 0.3))
    this.addSphere(start, vel, 'portal', sp.lifetimeS, sp)
  },

  // Create a sphere at local position start with local velocity vel.
  addSphere(start, vel, phase, life, sp) {
    const THREE = this.THREE
    const cmLocal = this.localPerMeter() / 100
    const opacity = randomIn(sp.opacityPercent) / 100

    // Colour: a random pick from the "colors" list, or a random violet/magenta/cyan without one.
    let color
    const palette = Array.isArray(sp.colors) ? sp.colors.filter(Boolean) : []
    if (palette.length) {
      color = new THREE.Color(palette[Math.floor(Math.random() * palette.length)])
    } else {
      color = new THREE.Color().setHSL((0.72 + Math.random() * 0.4) % 1, 0.85, 0.6)
    }
    // Lambert = diffuse only: matte, no specular highlight.
    const mat = new THREE.MeshLambertMaterial({
      color, emissive: color, emissiveIntensity: 0.25,
      transparent: true, opacity, depthWrite: false,
    })
    // Sphere mask: while behind the mask's plane, draw only where the mask is (stencil test).
    let mask = null
    if (sp.mask) {
      mask = this.masks && this.masks[sp.mask]
      if (!mask) {
        if (!this.warnedSphereMask) console.warn(`[book-portal] spheres use mask "${sp.mask}", which is not defined in "masks"`)
        this.warnedSphereMask = true
      } else if (phase === 'incoming') {
        // Starts in front of the mask; it is masked only after passing through (see tick).
      } else if (start.z >= mask.z) {
        mask = null  // starts in front of the mask: nothing to pass through
      } else {
        Object.assign(mat, {
          stencilWrite: true, stencilRef: mask.bit, stencilFuncMask: mask.bit, stencilWriteMask: 0,
          stencilFunc: THREE.EqualStencilFunc,
        })
      }
    }
    const r = randomIn(sp.radiusCm) * cmLocal
    const mesh = new THREE.Mesh(this.sphereGeometry, mat)
    mesh.scale.setScalar(r * 0.01)
    mesh.position.copy(start)
    mesh.castShadow = !!sp.gravity
    this.portalRoot.add(mesh)
    const mats = this.ana && this.ana.spheres ? this.anaglyphSplit(mesh) : [mat]

    this.spheres.push({
      mesh, mats, vel, r, opacity, // portal phase: r and vel in local units
      phase, age: 0, life,
      sp,                          // the stream's settings
      mask,                        // mask still to pass (null = none / already passed)
    })
  },

  // Move a sphere from the portal (local space) to the world (scene root).
  crossThreshold(s) {
    const scale = this.worldScale
    s.vel.applyQuaternion(this.worldQuat).multiplyScalar(scale)
    this.el.sceneEl.object3D.attach(s.mesh)  // keeps the world transform
    s.r *= scale
    s.phase = 'world'
  },

  // Ground = the lowest edge of the cover in world space (gravity mode only). Works for a book lying
  // flat (ground = cover plane) and for a book standing upright (ground = its bottom edge).
  updateGround() {
    const {coverW: w, coverH: h} = this
    let minY = Infinity
    this.groundCenter.set(0, 0, 0)
    for (const [x, y] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) {
      this.tmp.set(x, y, 0)
      this.portalRoot.localToWorld(this.tmp)
      minY = Math.min(minY, this.tmp.y)
      this.groundCenter.add(this.tmp)
    }
    this.groundCenter.multiplyScalar(0.25)
    this.groundY = minY
    this.shadowPlane.position.set(this.groundCenter.x, minY, this.groundCenter.z)
    this.shadowPlane.scale.setScalar(this.worldScale * 30)
    this.shadowPlane.visible = !!this.sp.gravity
  },

  // Is local point (x, y) on the mask's plane inside the mask (opaque part of its image)?
  insideMask(mask, x, y) {
    if (!mask.alpha) return false
    const u = x / mask.pw + 0.5
    const v = 0.5 - y / mask.ph  // image rows run top to bottom
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return false
    return mask.alpha[Math.floor(v * mask.ih) * mask.iw + Math.floor(u * mask.iw)] >= 128
  },

  // Share (0..1) of a disc of radius r around (x, y) on the mask's plane that lies inside the mask,
  // sampled at the centre plus two rings of points.
  maskCoverage(mask, x, y, r) {
    let inside = 0
    let total = 0
    const rings = [[0, 1], [0.5, 6], [0.9, 12]]  // [radius fraction, points]
    for (const [f, n] of rings) {
      for (let k = 0; k < n; k++) {
        const a = (k / n) * 2 * Math.PI
        if (this.insideMask(mask, x + Math.cos(a) * f * r, y + Math.sin(a) * f * r)) inside++
        total++
      }
    }
    return inside / total
  },

  removeSphere(i) {
    const s = this.spheres[i]
    s.mesh.parent.remove(s.mesh)
    for (const m of s.mats) {
      m.dispose()
      if (this.anaRightMats) this.anaRightMats.delete(m)
    }
    this.spheres.splice(i, 1)
  },

  // Draw order for a sphere at local depth z: just in front of all layers that are behind it.
  sphereRenderOrder(z) {
    let k = 0
    while (k < this.layerZs.length && this.layerZs[k] < z) k++
    return 2 * k
  },

  tick(time, deltaMs) {
    // Masks need an empty stencil each frame. three.js clears it only with autoClear and
    // autoClearStencil on, and 8th Wall changes the renderer's clear settings, so make sure.
    const renderer = this.el.sceneEl.renderer
    if (this.usesStencil && renderer && !(renderer.autoClear && renderer.autoClearStencil)) {
      renderer.clearStencil()
    }
    if (!deltaMs) return
    const dt = Math.min(deltaMs / 1000, 1 / 20)  // avoid huge steps after tab switches / tracking stalls
    const {sp} = this
    const obj = this.el.object3D
    const tracked = obj.visible

    if (tracked && this.portalReady) {
      obj.updateMatrixWorld(true)
      obj.getWorldQuaternion(this.worldQuat)
      obj.getWorldScale(this.worldScaleVec)
      this.worldScale = this.worldScaleVec.y
      if (this.ana) this.updateAnaglyph()
      this.updateGround()

      for (const st of this.streams) {
        st.wait -= dt  // counts only while the cover is tracked
        while (st.wait <= 0) {
          st.wait += this.nextGap(st)
          if (this.spheres.length >= sp.maxSpheres) this.removeSphere(0)  // oldest
          this.spawnSphere(st)
        }
      }
    }

    // Portal phase: straight-line flight in local space. Paused while the cover is not tracked,
    // since its pose is then unknown.
    if (tracked) {
      for (const s of this.spheres) {
        if (s.phase === 'incoming') {  // stays in local space all the way into the cover
          const p = s.mesh.position
          const prevZ = p.z
          p.addScaledVector(s.vel, dt)
          if (s.mask && !s.maskPassed && s.perishAge == null && prevZ > s.mask.z && p.z <= s.mask.z) {
            // The centre reaches the mask's plane: in through the mask, or stop here and fade.
            const f = (prevZ - s.mask.z) / (prevZ - p.z)
            const x = p.x - s.vel.x * dt * (1 - f)
            const y = p.y - s.vel.y * dt * (1 - f)
            const coverage = this.maskCoverage(s.mask, x, y, s.r)
            if (coverage > 0 && coverage * 100 >= s.sp.passPercent) {
              s.maskPassed = true
            } else {
              p.set(x, y, s.mask.z)  // stopped by the frame
              s.vel.set(0, 0, 0)
              s.perishAge = 0
            }
          }
          if (s.maskPassed && !s.mesh.material.stencilWrite && p.z + s.r <= s.mask.z) {
            // Completely behind the mask: from now on visible only through it.
            for (const m of s.mats) {
              Object.assign(m, {
                stencilWrite: true, stencilRef: s.mask.bit, stencilFuncMask: s.mask.bit, stencilWriteMask: 0,
                stencilFunc: this.THREE.EqualStencilFunc,
              })
            }
          }
          continue
        }
        if (s.phase !== 'portal') continue
        const p = s.mesh.position
        const prevZ = p.z
        p.addScaledVector(s.vel, dt)
        if (s.mask && !s.maskPassed && prevZ < s.mask.z && p.z >= s.mask.z) {
          // The centre crosses the mask's plane: survive only if it passes through the mask.
          const f = (s.mask.z - prevZ) / (p.z - prevZ)
          const x = p.x - s.vel.x * dt * (1 - f)
          const y = p.y - s.vel.y * dt * (1 - f)
          const r = s.r * Math.min(1, s.age / 0.15)  // current size (spheres grow in at spawn)
          const coverage = this.maskCoverage(s.mask, x, y, r)
          if (coverage > 0 && coverage * 100 >= s.sp.passPercent) s.maskPassed = true
          else s.perishAge = 0  // blocked by the frame: keeps flying, stays masked, fades out
        }
        if (s.mask && s.maskPassed && p.z - s.r >= s.mask.z) {
          // Completely in front of the mask: draw it everywhere from now on.
          for (const m of s.mats) m.stencilWrite = false
          s.mask = null
        }
        if (p.z > s.r) this.crossThreshold(s)
      }
    }

    // World phase.
    if (sp.gravity) {
      if (this.groundY !== null) {
        const steps = 3
        for (let k = 0; k < steps; k++) this.stepGravity(dt / steps)
      }
    } else {
      for (const s of this.spheres) {
        if (s.phase === 'world') s.mesh.position.addScaledVector(s.vel, dt)
      }
    }

    // Age, grow in, fade out, draw order.
    for (let i = this.spheres.length - 1; i >= 0; i--) {
      const s = this.spheres[i]
      s.age += dt
      let perish = 1
      if (s.perishAge != null) {
        s.perishAge += dt
        perish = s.sp.perishFadeS > 0 ? 1 - s.perishAge / s.sp.perishFadeS : 0
      }
      if (perish <= 0 || s.age >= s.life) {
        this.removeSphere(i)
        continue
      }
      const grow = Math.min(1, s.age / 0.15)  // pop in from nothing at the vanishing point
      s.mesh.scale.setScalar(s.r * Math.max(0.01, grow))
      const fadeLeft = s.life - s.age
      const op = s.opacity * perish * (s.sp.fadeS > 0 ? Math.min(1, fadeLeft / s.sp.fadeS) : 1)
      for (const m of s.mats) m.opacity = op

      if (s.phase !== 'world') {
        this.setSphereOrder(s, this.sphereRenderOrder(s.mesh.position.z))
      } else {
        this.tmp.copy(s.mesh.position)
        this.portalRoot.worldToLocal(this.tmp)
        this.setSphereOrder(s, this.sphereRenderOrder(this.tmp.z))
      }
    }
  },

  // Gravity mode: fall, bounce inelastically on the ground, roll, collide with each other.
  stepGravity(h) {
    const {data, groundY} = this
    const unitPerMeter = this.localPerMeter() * this.worldScale  // world units per meter
    const g = G * unitPerMeter
    const restSpeed = data.restSpeed * unitPerMeter
    const rollKeep = Math.exp(-data.rollDamping * h)
    const world = this.spheres.filter(s => s.phase === 'world')

    for (const s of world) {
      const p = s.mesh.position
      const v = s.vel
      v.y -= g * h
      p.addScaledVector(v, h)

      let onGround = false
      if (p.y - s.r <= groundY) {
        p.y = groundY + s.r
        onGround = true
        if (v.y < 0) {
          if (-v.y < restSpeed) {
            v.y = 0  // too slow to bounce again: settle
          } else {
            v.y = -v.y * data.restitution  // inelastic bounce
            v.x *= data.bounceFriction
            v.z *= data.bounceFriction
          }
        }
      }

      const horizSpeed = Math.hypot(v.x, v.z)
      if (onGround && v.y === 0) {
        v.x *= rollKeep
        v.z *= rollKeep
      }
      // Visual rolling: rotate about the horizontal axis perpendicular to motion.
      if (onGround && horizSpeed > 1e-6) {
        this.tmp.set(v.z, 0, -v.x).normalize()
        s.mesh.rotateOnWorldAxis(this.tmp, (horizSpeed * h) / s.r)
      }
    }

    // Sphere-sphere collisions (simple pairwise; fine for a few dozen spheres).
    const e = data.sphereRestitution
    for (let i = 0; i < world.length; i++) {
      for (let j = i + 1; j < world.length; j++) {
        const a = world[i]
        const b = world[j]
        const n = this.tmp2.subVectors(b.mesh.position, a.mesh.position)
        const dist = n.length()
        const minDist = a.r + b.r
        if (dist >= minDist || dist < 1e-9) continue
        n.divideScalar(dist)
        const push = (minDist - dist) / 2
        a.mesh.position.addScaledVector(n, -push)
        b.mesh.position.addScaledVector(n, push)
        const rel = this.tmp.subVectors(b.vel, a.vel).dot(n)
        if (rel < 0) {
          const j2 = (-(1 + e) * rel) / 2
          a.vel.addScaledVector(n, -j2)
          b.vel.addScaledVector(n, j2)
        }
      }
    }
  },

  // Remove every sphere and restart the spawn timers, as if the cover had just been found.
  resetSpheres() {
    while (this.spheres.length) this.removeSphere(0)
    for (const st of this.streams || []) st.wait = this.firstWait(st)
  },

  // Seconds before a stream's first sphere.
  firstWait(st) {
    return st.spawnRate > 0 ? Math.max(0, Number(st.firstSpawnDelay) || 0) : Infinity
  },

  // Seconds between two spheres of a stream: 1 / spawnRate, varied by up to ± spawnRateVariability.
  nextGap(st) {
    if (!(st.spawnRate > 0)) return Infinity
    const v = Math.min(1, Math.max(0, Number(st.spawnRateVariability) || 0))
    return Math.max(0.001, (1 / st.spawnRate) * (1 + (Math.random() * 2 - 1) * v))
  },

  remove() {
    window.removeEventListener('book-portal-reset', this.onReset)
    while (this.spheres.length) this.removeSphere(0)
    this.el.object3D.remove(this.portalRoot)
    this.el.sceneEl.object3D.remove(this.shadowPlane)
  },
}
