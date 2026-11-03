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

import bookCover from './targets/book-cover.json'

const G = 9.81
const DEG = Math.PI / 180

// Defaults for the "spheres" section of layers.json.
const SPHERE_DEFAULTS = {
  spawnRate: 3,              // spheres per second while the cover is tracked
  maxSpheres: 40,
  radiusCm: 1.5,
  speedCmPerS: 40,
  lifetimeS: 1.8,            // total life, from leaving the vanishing point
  fadeS: 0.7,                // fade-out at the end of the life
  opacityPercent: [30, 60],  // random opacity per sphere, between these two values
  aim: 'straight',           // 'straight' = perpendicular out of the cover (toward a viewer facing it head-on),
                             // 'camera' = toward the phone's current position
  spreadDegX: 3,             // max random deviation left/right from the aim direction
  spreadDegY: 3,             // max random deviation up/down
  spawnDepthCm: null,        // vanishing point depth behind the cover; null = 1 cm in front of the deepest layer
  gravity: false,            // true = fall, bounce and roll once out of the portal
}

// Photoshop-style blend modes for layers. The shader mixes transparent pixels toward the mode's
// neutral color (white for multiply, black for screen), then the GPU blends with what's behind.
const BLEND_MODES = {
  multiply: {src: 'ZeroFactor', dst: 'SrcColorFactor', glsl: 'gl_FragColor.rgb = mix(vec3(1.0), gl_FragColor.rgb, gl_FragColor.a);'},
  screen: {src: 'OneFactor', dst: 'OneMinusSrcColorFactor', glsl: 'gl_FragColor.rgb *= gl_FragColor.a;'},
}

export const bookPortalComponent = {
  schema: {
    coverHeightMeters: {default: 0.24},  // real height of the printed cover; sets the physical scale
    layers: {default: 'assets/layers/layers.json'},  // inner-world + sphere config; '' = defaults only
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
    this.spawnAccumulator = 0
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
    const meta = bookCover.metadata || {}
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
    const w = this.coverW
    const h = this.coverH
    const cm = v => (v / 100) * this.localPerMeter()  // centimeters -> local units

    const layers = (Array.isArray(cfg.layers) ? cfg.layers : [])
      .filter(l => l && l.file)
      .map(l => ({...l, z: -cm(l.depthCm || 0)}))
      .sort((a, b) => a.z - b.z)  // deepest first
    this.layerZs = layers.map(l => l.z)

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
    this.tunnelDepth = Math.max(this.tunnelDepth, this.spawnDepth + cm(0.5))
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
    const t = cm(border.thicknessCm != null ? border.thicknessCm : 0)
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

    // 3) Cover layers, back to front. Layer i gets renderOrder 2i+1; spheres get the even numbers
    //    in between, according to their depth, so they appear between the right layers.
    const loader = new THREE.TextureLoader()
    const renderer = this.el.sceneEl.renderer
    const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 1
    const base = new URL(cfgUrl || '/', window.location.href)
    layers.forEach((layer, i) => {
      const s = layer.scale != null ? layer.scale : this.depthScale(layer.z)
      let opacity = 1
      if (layer.opacityPercent != null) opacity = layer.opacityPercent / 100
      else if (layer.opacity != null) opacity = layer.opacity
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,   // PNG alpha; soft edges (blur, glow) blend correctly
        depthWrite: false,   // layers don't hide each other by depth; draw order does that
        opacity,
        toneMapped: false,   // show the artwork's colors as they are
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
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w * s, h * s), mat)
      mesh.position.set(0, 0, layer.z)
      mesh.renderOrder = 2 * i + 1
      mesh.visible = false   // until the texture has loaded
      this.portalRoot.add(mesh)

      const fileUrl = new URL(layer.file, base).href
      loader.load(fileUrl, (tex) => {
        if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace
        else tex.encoding = THREE.sRGBEncoding
        tex.anisotropy = maxAniso  // keeps layers sharp when seen at an angle
        const {width: iw, height: ih} = tex.image
        if (Math.abs(iw / ih - w / h) > 0.02 * (w / h)) {
          console.warn(`[book-portal] layer ${layer.file} is ${iw}x${ih}; its aspect ratio does not match ` +
            'the cover. Export every layer on the same canvas as the cover, or it will be stretched.')
        }
        if (Math.max(iw, ih) > 2048) {
          console.warn(`[book-portal] layer ${layer.file} is ${iw}x${ih}. Layers over 2048 px use a lot of ` +
            'GPU memory on phones; consider exporting at most 2048 px tall.')
        }
        mat.map = tex
        mat.needsUpdate = true
        mesh.visible = true
      }, undefined, () => console.error(`[book-portal] could not load layer image ${fileUrl}`))
    })
  },

  spawnSphere() {
    const THREE = this.THREE
    const {sp} = this
    const lpm = this.localPerMeter()

    // Vanishing point: centre of the cover, spawnDepth behind it.
    const start = new THREE.Vector3(0, 0, -this.spawnDepth)

    // Base direction: toward the camera (the viewer's face), or straight out of the cover.
    const dir = new THREE.Vector3(0, 0, 1)
    const cam = this.el.sceneEl.camera
    if (sp.aim === 'camera' && cam) {
      cam.getWorldPosition(this.tmp)
      this.portalRoot.worldToLocal(this.tmp)
      if (this.tmp.z > 0) dir.subVectors(this.tmp, start).normalize()
    }
    // Random deviation within the arc: left/right (about Y), then up/down (about X).
    dir.applyAxisAngle(this.axisY, (Math.random() * 2 - 1) * sp.spreadDegX * DEG)
    dir.applyAxisAngle(this.axisX, (Math.random() * 2 - 1) * sp.spreadDegY * DEG)
    const vel = dir.multiplyScalar((sp.speedCmPerS / 100) * lpm * (0.85 + Math.random() * 0.3))

    const [oMin, oMax] = Array.isArray(sp.opacityPercent) ? sp.opacityPercent : [sp.opacityPercent, sp.opacityPercent]
    const opacity = (oMin + Math.random() * (oMax - oMin)) / 100

    const hue = (0.72 + Math.random() * 0.4) % 1  // violets, magentas, cyans
    const color = new THREE.Color().setHSL(hue, 0.85, 0.6)
    // Lambert = diffuse only: matte, no specular highlight.
    const mat = new THREE.MeshLambertMaterial({
      color, emissive: color, emissiveIntensity: 0.25,
      transparent: true, opacity, depthWrite: false,
    })
    const r = (sp.radiusCm / 100) * lpm
    const mesh = new THREE.Mesh(this.sphereGeometry, mat)
    mesh.scale.setScalar(r * 0.01)
    mesh.position.copy(start)
    mesh.castShadow = !!sp.gravity
    this.portalRoot.add(mesh)

    this.spheres.push({
      mesh, vel, r, opacity,       // portal phase: r and vel in local units
      phase: 'portal', age: 0,
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

  removeSphere(i) {
    const s = this.spheres[i]
    s.mesh.parent.remove(s.mesh)
    s.mesh.material.dispose()
    this.spheres.splice(i, 1)
  },

  // Draw order for a sphere at local depth z: just in front of all layers that are behind it.
  sphereRenderOrder(z) {
    let k = 0
    while (k < this.layerZs.length && this.layerZs[k] < z) k++
    return 2 * k
  },

  tick(time, deltaMs) {
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
      this.updateGround()

      this.spawnAccumulator += dt * sp.spawnRate
      while (this.spawnAccumulator >= 1) {
        this.spawnAccumulator -= 1
        if (this.spheres.length >= sp.maxSpheres) this.removeSphere(0)  // oldest
        this.spawnSphere()
      }
    }

    // Portal phase: straight-line flight in local space. Paused while the cover is not tracked,
    // since its pose is then unknown.
    if (tracked) {
      for (const s of this.spheres) {
        if (s.phase !== 'portal') continue
        s.mesh.position.addScaledVector(s.vel, dt)
        if (s.mesh.position.z > s.r) this.crossThreshold(s)
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
      if (s.age >= sp.lifetimeS) {
        this.removeSphere(i)
        continue
      }
      const grow = Math.min(1, s.age / 0.15)  // pop in from nothing at the vanishing point
      s.mesh.scale.setScalar(s.r * Math.max(0.01, grow))
      const fadeLeft = sp.lifetimeS - s.age
      s.mesh.material.opacity = s.opacity * (sp.fadeS > 0 ? Math.min(1, fadeLeft / sp.fadeS) : 1)

      if (s.phase === 'portal') {
        s.mesh.renderOrder = this.sphereRenderOrder(s.mesh.position.z)
      } else {
        this.tmp.copy(s.mesh.position)
        this.portalRoot.worldToLocal(this.tmp)
        s.mesh.renderOrder = this.sphereRenderOrder(this.tmp.z)
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

  remove() {
    while (this.spheres.length) this.removeSphere(0)
    this.el.object3D.remove(this.portalRoot)
    this.el.sceneEl.object3D.remove(this.shadowPlane)
  },
}
