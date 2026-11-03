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

## More image targets (e.g. the back cover)

Each target is its own portal with its own config:

1. `npm run make-target -- path/to/image.jpg --name my-target` (writes `src/targets/my-target.json`)
2. Import that `.json` in `src/targets/index.js` and add it to `imageTargets`.
3. In `src/index.html`, add
   `<xrextras-named-image-target name="my-target" book-portal="coverHeightMeters: 0.24; layers: assets/my-target/layers.json">`
4. Create `src/assets/my-target/layers.json` (same format as below).

The back cover (`book-cover-back`) is set up this way: `src/assets/back/` has its own copies of the layers (the title layers mirrored) and its own `layers.json`, so front and back are tuned independently. Targets must look
clearly different to the tracker; the back cover is low in contrast and shares the glasses with the front, so
it may be found less reliably.

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
| `innerColor` | colour of the inner space at the **top** (tunnel walls and back) |
| `innerColorBottom` | colour at the **bottom**; the inner space is a top-to-bottom gradient between the two. Leave it out for a flat `innerColor` |
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
| `mask` | optional; name of a mask from `"masks"` (see below) |
| `show` | with `mask`: `inside` = visible only where the mask is, `outside` = visible everywhere except there |

### Sphere streams (`"streams": [...]` inside `"spheres"`)

Spheres can come from several streams, e.g. one aimed at each lens. Each stream is a list entry that
overrides any sphere setting; everything it doesn't set comes from the surrounding `"spheres"` values.
`spawnRate` is per stream (two streams at 5 = 10 spheres per second). Without `"streams"` there is one stream.

```json
"streams": [
  {"name": "left lens",  "originCmX": -5.5, "originCmY": 2, "spawnRate": 5},
  {"name": "right lens", "originCmX": 6.1,  "originCmY": 2, "spawnRate": 5, "spreadDegX": 2}
]
```

| key | meaning |
|---|---|
| `name` | optional label, for your own reference |
| `originCmX`, `originCmY` | the stream's start point, in cm from the cover's centre (+x right, +y up). `out`: at `spawnDepthCm` behind the cover; `in`: at `startDistanceCm` in front of it. `spawnRangeCm*` (`out`) / `startRangeCm*` (`in`) scatter starts around it |
| `targetCmX`, `targetCmY` | `in` only: centre of the entry area on the cover; `spawnRangeCmX/Y` is the area around it |

The lens centres on the cover are about (−5.5, 2) and (6.1, 2) cm.

### Masks (`"masks": {...}`)

A mask is an invisible shape that decides where masked layers can be seen. The example uses the
glasses' lenses: the sharp title (`2.png`) shows only through the lenses, the blurred title
(`2-blurred.png`) everywhere else.

```json
"masks": {"lenses": {"file": "1-lens-mask.png", "depthCm": 0}},
"layers": [
  {"file": "2.png",         "depthCm": 5, "mask": "lenses", "show": "inside"},
  {"file": "2-blurred.png", "depthCm": 5, "mask": "lenses", "show": "outside"}
]
```

- Draw the mask on the same canvas as the layers: **opaque where the mask is** (any colour), transparent
  elsewhere. Pixels count as "mask" above 50% opacity, so edges are hard; let the shape run slightly under
  the glasses frame so the frame hides the edge.
- `depthCm` places the mask in depth. At the glasses' depth, the masked area slides over deeper
  layers when you move, as with real glasses. At the masked layer's own depth it stays fixed to it.
- Up to 8 masks; any number of layers can use the same one.

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
| `radiusCm` | 1.5 | sphere radius; a number, or `[min, max]` for a random size per sphere |
| `speedCmPerS` | 40 | ±15% random per sphere |
| `lifetimeS` | 2.2 | total life from the vanishing point |
| `fadeS` | 0.7 | fade-out during the last part of the life |
| `opacityPercent` | [30, 60] | random opacity per sphere, between these values |
| `colors` | violets/magentas/cyans | list of hex colours, e.g. `["#8A5CFF", "#40C4FF"]`; each sphere picks one at random. Repeat a colour to make it more frequent. Can differ per stream |
| `spawnRangeCmX` | 0 | where spheres start, left/right of the centre: `4` = random within ±4 cm, or `[min, max]` (e.g. `[-2, 6]`) |
| `spawnRangeCmY` | 0 | same, up/down |
| `direction` | `out` | `out` = spheres fly from the vanishing point out of the cover. `in` = they start at a point straight out in front of the cover (`startDistanceCm`), fly into the cover, entering at a random point within `spawnRangeCmX`/`Y` and fading out at `spawnDepthCm`. With `in`, `aim`, `spreadDeg*`, `gravity` and `lifetimeS` are not used; with a `mask`, spheres that reach the mask's plane with at least `passPercent` inside it fly on (then visible only through the mask), the others stop there and fade out (each sphere lives until it reaches the depth) |
| `startDistanceCm` | 50 | `in` only: spheres start this far in front of the cover, on the line straight out from its centre |
| `startRangeCmX` | 0 | `in` only: random offset of the start point left/right: `n` = within ±n cm, or `[min, max]`. 0 = all from one point |
| `startRangeCmY` | 0 | `in` only: same, up/down |
| `mask` | null | name of a mask from `"masks"`. Behind the mask's plane, spheres show only inside the mask. When a sphere reaches that plane, the share of it inside the mask decides: enough (`passPercent`) and it flies on, fully visible once in front of the plane; otherwise it stays masked and fades out |
| `passPercent` | 50 | with `mask`: how much of a sphere (0–100) must be inside the mask to pass. Lower = more permissive |
| `perishFadeS` | 0.25 | with `mask`: fade-out time, in seconds, for spheres that don't pass |
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
