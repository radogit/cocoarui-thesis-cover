# 8thWall-test3 — Book portal

Combines **8thWall-test1** (image targets) and **8thWall-test2** (world tracking): a tracked book cover becomes a
portal into the cover's own layered artwork. Semi-transparent spheres fly out of a vanishing point inside the cover,
between the layers, toward the viewer's face, then fade away. An optional gravity mode makes them fall, bounce and
roll instead.

## Run

Same as test1/test2: `npm run serve` (HTTPS), then open `https://<LAN-IP>:<port>` on the phone and accept the certificate.
Use `npm run serve:phone` to avoid the dev-server WebSocket noise on iPhone.

## Use your own book cover

```bash
npm run make-target -- path/to/cover.jpg
```

Use a flat, straight-on image of the cover. A black border around it is trimmed automatically (`--no-trim` to
disable). The input file is never modified. The script writes into `src/targets/`:
- `book-cover.jpg`: the 480×640 grayscale crop that 8th Wall tracks
- `book-cover.json`: the target config, with the full cover size in `metadata` so the portal fills the whole cover
- `book-cover-cover.jpg`: the trimmed full cover, which is the reference your layers must line up with

Restart `npm run serve` afterwards. **Don't copy a cover image over `book-cover.jpg` by hand.** It must be the
480×640 crop that this script produces.

## Inner world and spheres: `src/assets/layers/layers.json`

Everything about the inner world and the spheres is set in this one file. It is loaded when the page
loads, so changes only need a page reload. New image files need a restart of `npm run serve`, or
`npm run build` if you serve `dist/`.

```json
{
  "innerColor": "#383DAA",
  "viewingDistanceCm": 35,
  "border": {"thicknessCm": 1, "opacityPercent": 100, "color": "#000000"},
  "layers": [
    {"file": "1.png", "depthCm": 0, "opacityPercent": 100, "blend": "multiply"},
    {"file": "2.png", "depthCm": 5, "opacityPercent": 100, "blend": "normal"}
  ],
  "spheres": { "...": "see below" }
}
```

### Top level

| key | meaning |
|---|---|
| `innerColor` | flat colour of the inner space (tunnel walls and back) |
| `viewingDistanceCm` | deeper layers are enlarged by `(viewing distance + depth) / viewing distance`, so that, seen straight on from this distance, the stack looks exactly like the printed cover |
| `border` | frame drawn just **outside** the tracked cover edge: `thicknessCm` (0 = no border), `opacityPercent` (0–100), `color` (hex) |

### Layers

Put the images in `src/assets/layers/`. **Export every layer on the same canvas as the cover** (same aspect ratio as
`src/targets/book-cover-cover.jpg`, borders trimmed), as PNG with transparency. Keep them at most ~2048 px tall.

| key | meaning |
|---|---|
| `file` | image file name, relative to `layers.json` |
| `depthCm` | distance behind the cover surface; 0 = on the cover, negative = in front of it. List order doesn't matter |
| `opacityPercent` | 0–100, like a layer's opacity in Photoshop/Affinity |
| `blend` | `normal`, `multiply` or `screen`, as in Photoshop/Affinity. The blend applies to what's drawn behind the layer (deeper layers, spheres, the inner colour) |
| `scale` | optional; overrides the automatic depth scaling |

### Spheres (`"spheres": {...}`)

Spheres start at a **vanishing point** in the centre of the cover, `spawnDepthCm` behind it. From there they fly in a
straight line perpendicular out of the cover, i.e. at the face of a viewer looking at the cover head-on, each
deviating by a random angle of up to `spreadDegX` (left/right) and `spreadDegY` (up/down). They do not follow the
viewer: seen from an angle, they still shoot straight out of the book. They pass between the layers on the way out,
then fade and disappear.

| key | default | meaning |
|---|---|---|
| `spawnRate` | 3 | spheres per second while the cover is tracked |
| `maxSpheres` | 40 | the oldest is removed beyond this |
| `radiusCm` | 1.5 | |
| `speedCmPerS` | 40 | ±15% random per sphere |
| `lifetimeS` | 2.2 | total life from the vanishing point |
| `fadeS` | 0.7 | fade-out during the last part of the life |
| `opacityPercent` | [30, 60] | random opacity per sphere, between these values |
| `aim` | `"straight"` | `"straight"` = perpendicular out of the cover; `"camera"` = toward the phone's current position |
| `spreadDegX` | 3 | max deviation left/right, in degrees (0 = exactly perpendicular) |
| `spreadDegY` | 3 | max deviation up/down, in degrees |
| `spawnDepthCm` | 15 | vanishing point depth behind the cover; the inner space extends to fit it. null = 1 cm in front of the deepest layer |
| `gravity` | false | true = fall, bounce on the ground and roll after leaving the portal (the earlier behaviour) |

## How it works (`src/book-portal.js`)

- **Portal**: an invisible depth-only frame (the occluder) surrounds the cover, so anything behind the cover is visible
  only through the cover opening. Behind it is a tunnel in `innerColor`, which widens with depth to fit the enlarged layers.
- **Draw order**: layers are drawn back to front. Each sphere is drawn between the layers it sits between, so front
  layers (e.g. the glasses) cover spheres behind them.
- **Spheres**: matte (no specular highlight), semi-transparent. Once outside the cover they move in world space, so
  they keep flying if the cover leaves the view.
- **Gravity mode**: ground = the lowest edge of the tracked cover (a book lying flat → the cover's plane; an upright
  book → its bottom edge). The physics is a small custom integrator: gravity, inelastic bounces, rolling friction and
  sphere-sphere collisions.

## Attributes on `book-portal` in `src/index.html`

| attribute | default | meaning |
|---|---|---|
| `coverHeightMeters` | 0.24 | real cover height; sets the physical scale (all cm values, speeds, gravity) |
| `layers` | `/assets/layers/layers.json` | config file (empty string = built-in defaults, no layers) |
| `innerColor` | `#383DAA` | fallback if `layers.json` has no `innerColor` |
| `tunnelDepth` | 1.2 | tunnel depth when there are no layers (in crop heights) |
| `restitution` | 0.45 | gravity mode: ground bounciness (0 = dead, 1 = elastic) |
| `sphereRestitution` | 0.6 | gravity mode: sphere-sphere bounciness |
| `bounceFriction` | 0.8 | gravity mode: horizontal speed kept per bounce |
| `rollDamping` | 1.5 | gravity mode: 1/s |
| `restSpeed` | 0.12 | gravity mode: m/s; slower impacts stop bouncing |
