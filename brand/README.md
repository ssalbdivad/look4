# look4 brand

A chubby bald eagle whose one huge gold eye, glint and all, is also a camera lens: the eagle eye
that watches the feeder so you don't have to. It is cute first (round head, feather tuft, blush, big
pupil) and still unmistakably an eagle (white head, hooked yellow beak, brown shoulders).

Open `index.html` for the brand sheet: every size on light and dark, the palette, type, the
terminal banner, and the five concepts it was chosen from, with scores.

## Files

| File | What |
|---|---|
| `logo-mark.svg` | The mark, full colour. **Source**, hand-written. |
| `logo-mark-mono.svg` | One colour, `fill="currentColor"`, so CSS `color` sets it. **Source.** |
| `favicon.svg` | The mark simplified for 16–32 px: no tuft, blush or nape, a heavier brow, and a bigger eye. **Source.** |
| `logo.svg` | Mark + "look4" wordmark. The letters are stroked paths, so it needs no font. It follows `prefers-color-scheme` (navy/blue on light, cream/gold on dark), the same way `brand.css` does. |
| `logo-512.png`, `logo-1024.png` | The mark, transparent background. |
| `social-card.png` | 1200×630 Open Graph card. |
| `render.ts` | Regenerates everything below from the sources and checks token contrast. |
| `concepts/` | The five explored concepts (`concepts/index.html`). |
| `mascot/<pose>.svg` | The mascot poses, self-contained and animated (the CSS is inside, so they move as an `<img>`). Generated from `web/src/components/Mascot.tsx`. |
| `mascot/poses.png` | Contact sheet: every pose at 200 and 48 px on bg, surface and dark bg. |
| `mascot/render.ts` | Regenerates `mascot/`: `node brand/mascot/render.ts`. Run it before `render.ts`, which shows the poses on the brand sheet. |

`node brand/render.ts` writes `logo.svg`, the PNGs, `index.html`, and copies into `web/public/`:
`favicon.svg`, `logo-mark.svg`, `logo.svg`, and `apple-touch-icon.png` (180×180, opaque, the disc
colour fills the square). `--no-browser` skips the social card, which needs Playwright's Chromium.

## Palette

Mark colours: sky `#2f6fb6` (disc), navy `#1b3354` / `#13243b` (eye ring, brow, pupil), eye gold
`#f6b52e`, brown `#6b3f22`, blush `#f9b8ad`, white.

App tokens (`web/src/brand.css`):

| Token | Light | Dark | Use |
|---|---|---|---|
| `--l4-bg` | `#f7f3ea` | `#111823` | Page |
| `--l4-surface` | `#ffffff` | `#18212f` | Cards, panels |
| `--l4-surface-2` | `#efe9dc` | `#212c3d` | Wells, hover, table stripes |
| `--l4-border` | `#e2d9c7` | `#2e3b50` | Hairlines |
| `--l4-ink` | `#1b2a40` | `#eef1f6` | Text |
| `--l4-ink-soft` | `#5a6577` | `#a3afc2` | Secondary text |
| `--l4-primary` | `#f6b52e` | `#f6b52e` | Main buttons, the active state. A fill, not a text colour. |
| `--l4-primary-ink` | `#1b2a40` | `#13243b` | Text on primary |
| `--l4-accent` | `#2f6fb6` | `#7fb0ea` | Links, secondary buttons, focus rings. Safe as text. |
| `--l4-accent-ink` | `#ffffff` | `#111823` | Text on accent |
| `--l4-good` | `#23794b` | `#4cc184` | Kept, healthy |
| `--l4-bad` | `#c2412f` | `#f07462` | Rejected, errors |
| `--l4-warn` | `#9a5f00` | `#f0b43c` | Unsure, degraded |
| `--l4-eye` | `#f6b52e` | `#f6b52e` | The eye gold, for illustration and highlights (added token) |
| `--l4-sky` | `#2f6fb6` | `#2f6fb6` | The disc blue, for illustration (added token) |

Contrast, checked by `render.ts` on every run (WCAG 2): ink and ink-soft are at least 4.5:1 on
bg, surface and surface-2 (lowest: light ink-soft on surface-2, 4.87). primary-ink on primary is
7.97 light and 8.61 dark. Accent as text is 4.66 on the light bg. good/bad/warn are at least 4.5 on
surface and at least 4.2 on surface-2.

## Mascot

The eagle from the mark, given a body so it can act. The head is the mark's own geometry (drawn in
its 512 units and scaled into place), so the face, lens-eye, beak, tuft and blush are exactly the
logo's; the body is the mark's brown shoulders grown into a round belly, with a white bald-eagle tail
and gold feet. Off the sky disc a white head would vanish on a white card, so the whole bird sits in
one navy (`#1b3354`) sticker outline. On dark backgrounds that outline turns pale (`#c6d5ea`):
the app sets `--l4m-line` under `prefers-color-scheme: dark`, and `brand/mascot/<pose>-dark.svg` has
it baked in. Two derived browns are added for depth: wings `#56311a`, belly
`#7a4828`.

The single source is `web/src/components/Mascot.tsx`:

```tsx
import { Mascot } from "./components/Mascot.tsx"

<Mascot pose="sleepy" size={120} />              // decorative: aria-hidden
<Mascot pose="found" size={160} title="Found one!" /> // an image with that accessible name
```

Props: `pose` (below), `size` in px (default 96; the figure is square), `title`, `className`. It
needs no CSS file: its keyframes are one React 19 hoisted `<style>`, shared by every instance. Props
and bubbles (sparkles, z's, the thought bubble) stay inside its square.

| Pose | Looks like | Motion | Use for |
|---|---|---|---|
| `looking` | Wings tucked, eye ahead | Eye scans left and right, head turns with it | Watching: the first pull, scanning the network |
| `found` | Wings thrown up, a star in its eye, gold sparkles | Little hops with squash, wings flap, sparkles twinkle | A find: wizard success, the first sighting |
| `sleepy` | Heavy half-closed lid, low brow, sky-blue "z z Z" | Slow breathing, z's drift up | Nothing yet: empty states |
| `puzzled` | Head cocked back, a "?" thought bubble | Head sways, the "?" rocks | Something's off: errors, setup problems |
| `hello` | Near wing raised in front of the body, gold wave lines | Waves | Welcome: the setup wizard's first step |
| `thinking` | Wing tip on its chin, eye up at a "..." thought bubble | Dots pulse in turn, small nod | Working: "the judge is looking..." |

Every pose except `sleepy` also blinks every 5 s. Each pose's resting shape is set in SVG
attributes and CSS only adds motion on top, so under `prefers-reduced-motion` (which stops all of
it) every pose still reads, and so do renderers without CSS animation.

Do: use one mascot per view, at 96–200 px for empty states and dialogs, and 48–76 px inline.
Below 48 px the poses stop reading; use the logo mark or an icon there.
Don't: recolour it, flip it, or use it as the logo (the mark on its disc stays the logo).

## Typography

- **Fredoka** (`@fontsource-variable/fredoka`, 600) for display: headings, buttons, the wordmark.
  Its round terminals echo the mark.
- **Nunito** (`@fontsource-variable/nunito`, 400 and 700) for body and UI text. Fredoka is too
  soft at small sizes, and Nunito is its rounded match.
- The wordmark in `logo.svg` is Fredoka SemiBold redrawn as round-capped strokes (29 units at a
  200 px em). Overlaid on the real glyphs, it matches to within a pixel or two. In running text,
  write "look4" all lowercase, never "Look4" or "LOOK4".

## Usage

Do:
- Use `favicon.svg` at 32 px and below, and `logo-mark.svg` above that.
- Use `logo-mark-mono.svg` where only one colour is possible, and set it with CSS `color`.
- Leave clear space around the mark of at least a quarter of its width.
- Put the colour mark on any background: the sky disc holds up on both cream and near-black.

Don't:
- Recolour the colour mark, or put the eagle on a disc of another colour.
- Use the eye gold (`--l4-primary`, `--l4-eye`) for text on light backgrounds (1.6:1).
- Stretch, rotate or outline the mark, or add a drop shadow at small sizes.
- Set the wordmark in a different typeface. Use `logo.svg`, or Fredoka 600 if it must be live text.

## Terminal banner

For the CLI startup banner (`look4 start`). It is 5 lines of plain ASCII, so it lines up in any
monospace terminal. When stdout is a colour TTY (and `NO_COLOR` is unset), colour `(@)` with eye
gold (`\x1b[38;2;246;181;46m`) and the `4` with sky (`\x1b[38;2;47;111;182m`), and dim the tagline.

```
    ,--^-.
   / (@)  `--.
  |      .--. )   look4
   \     /   v    keep the clips worth watching
    `~~~'
```

The head has a tuft (`^`) and the gold eye `(@)`, and the beak hooks down to the `v`. `render.ts`
prints it on every run, so you can check it in a real terminal.
