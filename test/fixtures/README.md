# Test footage

Real feeder clips from Wikimedia Commons plus a few synthetic edge cases. The videos are
gitignored; reproduce them with

```sh
node scripts/fetch-fixtures.ts          # or: pnpm fixtures
node scripts/fetch-fixtures.ts --force  # rebuild every output
```

The script downloads each pinned source into `videos/.src/` (verified by sha256), cuts a
segment, re-encodes it to H.264 yuv420p, 25 fps, at most 1280 px wide, without audio, and
rewrites `manifest.json`. Outputs that already exist are skipped. Total size is about 20 MB.

`manifest.json` lists every clip with what a correct pipeline should conclude about it:
`expect.motion` (should the motion gate pass it), `expect.subjects` (detector-level nouns,
`[]` when no animal is visible) and `expect.species` (judge-level labels). Segment times
were picked by looking at extracted frames, so the subject is visible across each segment
and no segment spans a scene cut or an on-screen caption.

## Clips

| File | What it tests |
|---|---|
| `blue-jay.mp4` | Blue Jay on a platform feeder, large in frame |
| `cardinal-woodpecker.mp4` | male Northern Cardinal + Downy Woodpecker at a snowy suet feeder |
| `chipping-sparrow.mp4` | small brown sparrow, feeder-mounted camera (pillarbox cropped) |
| `great-tits.mp4` | Great Tits and a Willow Tit landing and flying off, motion blur |
| `squirrel.mp4` | grey squirrel hanging under a caged feeder, half hidden by wind-blown leaves |
| `empty-feeder-snow.mp4` | real negative: falling snow and camera drift, no animal; only 5.3 s, the longest animal-free stretch found |
| `static.mp4` | synthetic: 10 s still of the empty feeder with faint sensor-like noise |
| `light-change.mp4` | synthetic: same still, luma dips to 70% and recovers over 10 s (passing cloud) |
| `RecM07_20261014_093012_093042_6D28808_1E2F3A.mp4` | synthetic: 3840x2160 H.265 upscale of the cardinal feeder, named like a Reolink SD-card recording |

## Attributions

- **Blue Jay at bird feeder, video (3675639120).webm** by Matt MacGillivray, CC BY 2.0.
  <https://commons.wikimedia.org/wiki/File:Blue_Jay_at_bird_feeder,_video_(3675639120).webm>
  Used for `blue-jay.mp4` (0–12 s).
- **Busy Bird Feeder (31524812531).webm** by U.S. Fish and Wildlife Service – Midwest Region,
  public domain.
  <https://commons.wikimedia.org/wiki/File:Busy_Bird_Feeder_(31524812531).webm>
  Used for `cardinal-woodpecker.mp4` (4–16 s), `empty-feeder-snow.mp4` (95.7–101 s), the
  still behind `static.mp4` and `light-change.mp4` (99 s), and the Reolink-named 4K clip
  (20–30 s).
- **Chipping sparrow and black-capped chickadee.webm** by kev0nte 77x, CC BY 3.0.
  <https://commons.wikimedia.org/wiki/File:Chipping_sparrow_and_black-capped_chickadee.webm>
  Used for `chipping-sparrow.mp4` (28–43 s, pillarbox cropped).
- **Bird feeder in the mountains of Slovakia.webm** by Lubo Ondrasko, CC BY 3.0.
  <https://commons.wikimedia.org/wiki/File:Bird_feeder_in_the_mountains_of_Slovakia.webm>
  Used for `great-tits.mp4` (91.2–100 s).
- **Grey squirrel eating from bird feeder.webm** by Alexis Markwick (User:Dr-Mx), CC BY-SA 3.0.
  <https://commons.wikimedia.org/wiki/File:Grey_squirrel_eating_from_bird_feeder.webm>
  Used for `squirrel.mp4` (64–79 s). The script pins Commons' 720p VP9 transcode because the
  original is 1 GB; derived clips are CC BY-SA 3.0.

All derived clips are trimmed, scaled and re-encoded; the synthetic clips are additionally
looped, noised, brightness-modulated or upscaled.
