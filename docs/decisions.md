# Decision log

The conclusions and the key numbers from every experiment run while building look4, recorded here
so the scratch harnesses under `test/.tmp/` can be deleted.

**Read the timings with care.** Every build agent shared one 16-core WSL2 machine (GTX 1660
Super, 54 GB RAM), and most measurements were taken while others were running. Load averages are
given where they were recorded. A timing marked **contended** is an upper bound. Only a few were
measured on an idle machine, and those are marked **uncontended**. View counts and token counts do
not depend on load, so they are the reliable cost figures.

**Read the accuracy evidence with care.** All of it comes from 9 fixture clips (6 real Wikimedia
feeder clips from 6 scenes, 3 synthetic) and 11 web photos. None of it is real RLC-823S1 footage.
Treat every accuracy claim below as suggestive, not established.

---

## 1. Detector model: OWL-ViT B/32 at q8

**Decision.** `Xenova/owlvit-base-patch32`, int8-quantized (q8), on CPU through transformers.js
4.3 / onnxruntime-node. Other weights can be chosen with a `:dtype` suffix on
`pipeline.detector.model`.

**Benchmark.** 11 CC0/CC-BY photos: 6 with birds (one also with a squirrel) and 5 empty feeders.
Queries were `bird` and `squirrel`.

| Model | Download | s/frame | Best bird score on positives | Highest score on an empty feeder | Verdict |
|---|---|---|---|---|---|
| OWL-ViT B/32 **q8** | 158 MB | **0.52 uncontended**; 1.2–1.3 at load 30 | 0.49–0.72 | 0.022 | **chosen** |
| OWL-ViT B/32 fp32 | 615 MB | 1.03 | 0.56–0.76 | 0.030 | same scores, 2× slower, 4× bigger |
| OWLv2 B/16 ensemble q8 | 158 MB | 6.1 | — | **0.51** (a false bird) | rejected |
| OWLv2 B/16 fp32 | 617 MB | 9.0 | — | 0.35 | rejected |
| Grounding DINO tiny q8 | 207 MB | 4.3 | 0.84–0.93 | 0.20–0.34 | rejected: slow, labels unusable with several nouns in one prompt, crashes on batched prompts (input_ids dims error), so it needs one call per noun |
| Grounding DINO tiny fp32 | 722 MB | 8.0 | — | — | rejected |

The thread count (4, 8 or the default) made no difference at load 30.

**On the fixture clips** (real motion frames, at most 6 frames, threshold 0.1 at the time): birds were
found in 5 of 5 clips, including the 4K HEVC clip, with best scores of 0.87 (blue jay), 0.70
(cardinal + woodpecker), 0.68 (sparrow), 0.70 (great tits) and 0.69 (4K). The empty, static and
light-change clips had 0 of 3 hits. The squirrel was missed (best 0.07); see section 4.

**Early stop.** Detection stops once every query has a hit of at least max(0.3, 2× threshold) on 2
frames. With bird-only queries, positive clips used 2–3 of their 6 frames, and detect time fell
7.0→1.7 s, 5.9→1.6 s, 11.2→5.3 s, 5.1→1.5 s and 10.9→6.2 s (4K) (contended). Negative clips always
scan every frame.

**Frame decoding was the real cost on 4K.** One seek per frame on the 4K H.265 fixture (one keyframe
every 10 s) costs about 3.1 s each: 6 seeks took 15.0 s, against 4.8 s for one pass that selects
every frame. `detect-frames.ts` reads the keyframe index (about 0.1 s) and picks whichever is
cheaper. This cut `detectClip` on the 4K fixture from 28.9 s to 9.1 s (contended).

**Cold start.** The first run downloads 158 MB. The model loads in 4–8 s once cached.

## 2. Detector threshold: 0.15

The default was 0.1 and is now 0.15. On the snowy-feeder scene, a pole scored 0.08–0.105 as
"squirrel" in the full-frame view. At 0.1, `static.mp4` produced a false squirrel at 0.105, which
would have sent every motion clip from that scene to the paid judge. Every bird clip's best score
was at least 0.49, so 0.15 lost no bird recall on the fixtures. The sample is small: one empty
scene and 5 bird clips.

Speculative views (section 4) use a stricter bar of max(0.3, 2× threshold).

## 3. Motion gate design

`src/pipeline/motion.ts`. The design follows from what goes wrong on outdoor feeder footage:

- **Decode small and gray.** ffmpeg crops the zone first, scales to a 320 px long edge, and samples
  at 2 fps (`fps=…:round=up`, so frame i is the last source frame at or before i/fps, the same frame
  `extractFrame` seeks to). Between 8 and 240 frames are analyzed per clip.
- **Lighting: a robust gain + offset fit, not histogram matching.** Each frame is mapped onto its
  segment's middle frame. Histogram matching was rejected because it can erase a bird whose
  brightness is rare in the scene. Comparisons are limited to the brightness range both frames can
  actually show, so clipped highlights don't count as motion.
- **Segments.** A frame where more than `maxArea` (0.7) changed splits the clip (IR switch, camera
  bump) and counts as a whole-frame change, not motion.
- **Change mask = temporal median + 3-frame difference.** The difference from a 15-frame temporal
  median background is combined with three-frame differencing, which marks where the subject is
  *now* rather than where it was. At segment ends only the background difference is used, because
  one-sided differencing doubles the blob (before that fix the mover test scored 0.0139, a doubled
  blob).
- **Score = the largest compact blob, not the total changed area.** A 3×3 opening removes speckle,
  and connected components are labelled on a dilated copy. Leaf flicker and noise break into many
  small pieces whose sum can be large, while a bird is one blob. Secondary blobs (at most 4, each at
  least `minArea`, not a ghost, fill ≥ 0.3) are passed on for detector zooms.
- **Ghosts.** When a bird sits still for most of the clip, the background contains it, and its empty
  spot shows up as a false blob before it arrives. An edge test along the blob's outline tells a
  real subject from a ghost. Frames where the spot matches the background are offered too, with
  two thirds of the candidate slots going to the likelier reading, so a wrong ghost call can't push
  out every frame that shows the bird.
- **Candidate frames** are at least 0.5 s apart and padded with evenly spaced frames.
- **NVDEC for ≥ 2560×1440 H.264/HEVC.** The GPU decodes, crops and resizes. It adds about 1 s of
  setup per clip, which is why it's limited to large frames. Any NVDEC failure falls back to the CPU
  and turns NVDEC off for the rest of the process. `LOOK4_HWDEC=off` forces the CPU.

| 3840×2160 H.265, 25 fps (contended, load 22–34) | NVDEC decode | CPU decode | Analysis | CPU time used |
|---|---|---|---|---|
| 10 s fixture | 1.3–2.8 s | 3.1–5.9 s | 0.2–0.75 s | about 1 s vs about 16 s |
| 30 s (looped) | 4.8–5.8 s | 8.3–14.6 s | 0.45–0.7 s | about 5 s vs 55–64 s for two clips |

720p H.264 clips take 0.4–1.4 s end to end on the CPU (contended).

**Defaults and their margins.** `pixelThreshold` 22: static and light-change score exactly 0 even
at 8, and every animal clip still passes at 40. `minArea` 0.0008 (46 px at 320×180): the smallest
animal peak was the sparrow at 2.0%, about 25× that. Peaks on the fixtures: sparrow 2.0–2.6%,
squirrel 1.7–4.5%, blue jay 8%, cardinal 15–19%, 4K 5–7%. Scratch stress clips (an IR-like step,
a gamma ramp, heavy noise, ±0.25 flicker with clipping) were all dropped.

**Mutation checks.** Each of these breaks made the matching test fail: an identity lighting LUT,
the clipping clamp disabled, the ghost logic disabled, and the NVDEC crop arguments swapped (a mean
difference of 66 gray levels vs 0.01–0.016).

**Clips a stream's motion gate made** (kv `gate:<id>`, §12) are never dropped here: over a
whole-frame zone no `minArea` tells a small bird from wind on real RLC-823S1 footage, and the gate
already saw something move. The stage still runs on them with its floor lowered to 0.0001 (the
watch's 6 px) to pick candidate frames and zoom boxes, and passes them, so the detector's second
look runs when its zooms find nothing.

**Known gaps.**
- Camera shake isn't compensated: a ±10 px jitter passes at 1.2%.
- On windy footage the largest blob is often leaves (on `squirrel.mp4` the squirrel's blobs rank
  about 5th–12th by size, and 84% of leaf blobs pass the fill filter).
- The margins against real night IR noise and real 4K bitrates are unmeasured.

## 4. Second look: tiling the zone when nothing was found

**Problem.** In `squirrel.mp4` a gray squirrel hangs under a caged feeder, half hidden by leaves
moving in the wind. OWL-ViT scored it below 0.01 at full frame and 0.03–0.04 in a 720 px half-frame
crop, and only 0.27 in a tight crop of about 400 px. The motion boxes sat on the leaves, so the
zooms never landed on it.

**Decision.** When a clip passed motion, zoom is on, and the normal views found nothing, tile the
zone of the 2 best motion frames (already decoded) and stop at the first frame with a hit. Tiles are
square, with a side of **0.6 × the zone's short edge**, at least 25% overlap, and at most 8 per frame
(a 720p frame gets 8 tiles of 432 px).

**Tile size, measured** on squirrel frames at 0, 1.5, 7.5, 8.5 and 10.5 s (max squirrel score):

| Tile side | Tiles | Scores |
|---|---|---|
| 0.5 × short edge | 15 | 0.065 / 0.599 / 0.041 / 0.066 / 0.219 (split across rows) |
| **0.6 × short edge** | **8** | **0.150 / 0.565 / 0.364 / 0.457 / 0.423** |
| 0.75 × short edge | 6 | 0.062 / 0.412 / 0.035 / 0.227 / 0.044 (diluted) |

**Speculative bar: 0.3.** Tiles and zooms on secondary blobs see clutter up close, so their hits
must reach max(0.3, 2× threshold) rather than 0.15. Without the bar, a suet cake on the snowy feeder
scored 0.215 as "squirrel" in a tile, and a secondary zoom gave the 4K bird clip a false squirrel at
0.165. With 0.6 tiles on the negatives: static max 0.069, light-change 0.065, bird clips max
squirrel 0.078.

**Result.** The squirrel is found at 0.33–0.35 from a tile. Its box is on the squirrel (IoU about
0.7 against a hand-labelled box). Through the claude-code judge it was kept as "Eastern Gray
Squirrel" at 0.92 for $0.0005. Birds stay at 5 of 5 with unchanged best scores, and snow, static and
light-change stay at 0. With only `squirrel` queried, which forces the second look on every bird
clip, there were 0 false squirrels. With only `bird`, there were no false birds on the squirrel or
snow clips.

**Cost** (second look on vs off, 3 alternations, median, contended):

| Clip | Added time | Extra views |
|---|---|---|
| empty-feeder-snow | +17.6 s (load 14–19) | 16 |
| 4K, squirrel query | +8.7 s (load 12) | 16 |
| squirrel | +3.3 s | 8 (stops after the first frame) |

Uncontended, that's about +8 s per clip that moved but held nothing. Windy real footage will trigger
this often. Setting `SECOND_LOOK_FRAMES` to 1 halves the cost, and the squirrel was found on the
first frame in every run.

**The margin is thin:** 0.331–0.347 against a bar of 0.30, with a false-positive ceiling of 0.215.
It rests on one squirrel clip and one negative scene. Secondary-blob zooms (+3–4 views per clip,
capped at 4 per clip) found nothing new on the fixtures. They are kept for clips with a second,
separate subject. The second look only runs when a clip has *no* detection, so a clip with a bird
and a hidden squirrel can still miss the squirrel lookout.

## 5. Judge: Claude Haiku 5.5, `claude-code` backend by default on this machine

**Decision.** `pipeline.judge.model = claude-haiku-5-5` and `provider = auto`, which picks:
`anthropic` if `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` is set; else `claude-code` if `claude` is
on PATH; else `none`.

- **Why claude-code exists.** The build machine has no API key but does have a Claude Code login.
  Each request runs one isolated `claude -p` process: images go inline as base64 over
  `--input-format stream-json`, tools are off (`--tools ""`), it runs in an empty working directory
  (no project CLAUDE.md or `.mcp.json` in reach), and `--safe-mode` is on. At most 2 run at once,
  with a 120 s timeout. Verified live: one model call per clip, no tool-permission prompts, 0
  thinking tokens with `alwaysThinkingEnabled:false`. Cost is billed to the subscription. look4
  computes the API-price equivalent itself because the CLI's own cost figure is wrong for this
  model.
- **Structured output.** The anthropic backend sends `output_config.format` with a JSON schema
  generated from an ArkType type, and parses the reply against the same type. Thinking is disabled
  for Haiku 5.5, effort is low, and there are no sampling parameters and no prefill. (Sonnet 5.5
  needs `between_tools`; Opus 5.5 can't turn thinking off.) Images come before the text, and the
  system block is marked for caching. **The anthropic backend has never been called live** (there
  is no key on the machine). Its request shape is pinned by unit tests against the SDK 0.134 types.
- **One request per clip** covers every candidate lookout. A lookout the model skips gets an
  explicit "judge gave no answer" verdict. Escalation re-asks only the uncertain lookouts.

**Measured (claude-code, Haiku 5.5, contended):**

| Input | Time | Input / output / cache-read tokens | Cost at API prices | Verdict |
|---|---|---|---|---|
| cardinal-woodpecker | 4.4 s | 3905 / 297 / 0 | $0.00093 | cardinal yes 0.97, woodpecker yes 0.95 |
| squirrel | 4.7 s | 1728 / 159 / 1387 | $0.00044 | yes 0.93 |
| chipping-sparrow | 5.6 s | 2319 / 277 / 1387 | $0.00062 | not a cardinal 0.93, not a woodpecker 0.95 |
| empty feeder + fake 0.12 "bird" box | 5.7 s | 2180 / 281 / 1387 | $0.00059 | both no 0.97 |
| blue jay photo, no feeder | 5.5 s | 1863 / 285 / 1387 | $0.00053 | "Blue Jay", rejected for no feeder |

That was 8 of 8 verdicts correct. Across the later e2e runs, a judged clip cost **$0.0004–0.0011**.
A full real e2e (10 clips, 3 lookouts) made 17 model calls for $0.0122–0.0126, and took 264–514 s
wall time under load 14–23. Lookout compiles take 5–7 s each.

**Above the original target.** The spec aimed for about $0.0003 per clip. Most of the input is
images: up to 4 crops at 512 px plus a 768 px context frame. A 512 px crop costs about 1.8× a 384 px
one. `cropSize` 384 or a lower `maxCrops` would cut the cost, but the accuracy impact is
**unmeasured**.

**Compiler fixes found live (COMPILER_VERSION 2).**
- "a sparrow" got a rubric that required breast streaks, which Chipping Sparrows lack. The prompt
  now says any member of a group qualifies. The sparrow was kept in 2 of 3 runs after the fix and 0
  of 1 before: a near-threshold case.
- Summaries added a place the user never gave ("Squirrel at Feeder"). A guard now swaps in the
  prompt's own words.

**Transient failures.** Timeouts, rate limits, 5xx, network errors and Claude subscription limits
("hit your session limit") are retried after 2, 8 and 20 minutes, then every 3 hours until the clip
would have expired. Not logged in, a bad request, a refusal or malformed output are reported as
errors.

## 6. Ingest: pull over HTTPS from the camera, not FTP push

`PLAN.md` originally had the camera FTP its clips into the inbox. That was reversed:

- **WSL2's NAT.** Outbound connections to the LAN work, but an FTP server inside WSL2 would need a
  Windows port forward (plus passive-mode ports) for the camera to reach it.
- **No camera reconfiguration.** The camera already records motion clips to its SD card on a 24/7
  schedule. Pulling (Search + Download over the camera's HTTP API) uses that as-is, and the card
  stays the source of truth, so look4 catches up after downtime.
- **The cost:** newer firmware has HTTP/HTTPS **off** by default. The real camera at 192.168.1.31
  had only port 9000 (Reolink's native protocol) open. So setup detects that case by port probes,
  *without* a login attempt (logins count toward the camera's lockout), and walks the user through
  switching HTTPS on.

How the pull works (`src/sources/reolink.ts`):
- `protocol: auto` tries HTTPS (self-signed) first, then HTTP.
- It searches per local day from a cursor, with 30 min of overlap and dedupe by `sourceRef`.
- Files that ended less than 20 s ago are skipped (they may still be recording), and the cursor is
  held at any file still owed.
- It downloads one file at a time with idle and total timeouts, and falls back to `Playback` when
  `Download` answers "not support".
- After a rejected password it won't log in again until the password changes.
- The camera clock is compared hourly. Skew over 2 min is shown as a warning and compensated in the
  search windows.
- When free disk space is under `retention.minFreeGb`, it pauses before downloading.

The request shapes were checked against `reolink_aio`. **Nothing has run against the real
RLC-823S1**, by instruction: its HTTPS is off and a lockout was the risk. That leaves untested on
hardware: whether in-progress recordings are listed, the exact lockout code and message, and the
type of `size`.

## 7. Retention defaults

| Setting | Default | Why |
|---|---|---|
| `rejectedDays` | 7 | Long enough to re-tune thresholds and backfill new lookouts against real misses (PLAN.md). |
| `motionlessDays` | 2 | No lookout can ever want these, and they are the bulk of the volume. |
| kept clips | never deleted | They are the product. |
| labeled clips | never deleted | They are the eval set. Clearing a label puts the clip back on the clock. |
| `minFreeGb` | 5 | Below it, new clips are refused (the camera keeps them on SD) and rejected clips are deleted early, soonest-to-expire first. Kept and labeled clips are never deleted to free space. |

Retention deletes the files and media but keeps the database row, so funnel counts and spend stay
accurate. The sweep runs hourly.

## 8. Logo concept

Five concepts were drawn (`brand/concepts/`) and scored out of 60 by eye. **These scores are
judgment, not measurement.**

| Concept | Score |
|---|---|
| **Eagle Eye** (bald-eagle head, a gold eye that is also a camera lens) | **46** |
| Binocular Bird | 44 |
| Owl Lens | 33 |
| Search Robin | 30 |
| Viewfinder Finch | 29 |

Eagle Eye won because it is the only one that literally says "eagle eye" and the most legible at
16 px. It took Binocular Bird's charm: a feather tuft, a rounder eye, a blush. The navy disc
disappeared on dark backgrounds, so it became sky blue `#2f6fb6`. `favicon.svg` is a separate
simplified mark for 32 px and below. `brand/render.ts` checks 32 contrast pairs on every run (the
lowest are 4.87 for light ink-soft on surface-2 and 4.66 for light accent on bg). Details are in
[brand/README.md](../brand/README.md).

## 9. Event-loop stalls: the detector in its own process, the motion gate in slices

The server and the pipeline share one Node process, so any synchronous stretch freezes the UI,
the API, SSE and live view for its whole length. A whole-app check saw stalls of up to 12.9 s
during the mock e2e run at load 60+. A scratch probe ran every fixture through `processClip` and
through each stage on its own, with `monitorEventLoopDelay` (10 ms) and a CPU profile.

**Most of it was ours, and load only stretched it.** onnxruntime-node 1.30 runs `session.run` and
the model load synchronously on the calling thread, and transformers.js pre-processes in plain JS
(`permute_data`, `rescale`: 0.3–0.5 s per view at load 50). So every view froze the loop for its
whole inference: 2.9–4.7 s per view, and 3.9–9.1 s for the model load, at load 22–58. The other
blocks over 250 ms:
- **The motion analysis**, 0.13–1.3 s of pixel loops per clip (`analyzeMotion`, `medianFrame`,
  `morph`).
- **Every ffmpeg or ffprobe spawn**, 0.15–0.5 s. `fork()` copies the page tables of the whole
  process, and the model made it ~700 MB, up from 90 MB. A bare 2 GB process measured 520 ms
  per spawn at load 45, against 15 ms at 66 MB.

**Fix.**
- `detect-host.ts` holds the model in a forked child process and gets one view at a time over
  IPC. A worker thread would have freed the loop, but it would have left the ~600 MB in the
  server's process and so kept the slow spawns. If the host dies, the clip in flight fails and
  the next clip starts a fresh host. An idle host does not keep a CLI command or a test alive.
- `runMotionGate` runs the same analysis as a generator and yields to the loop every 20 ms. Its
  output is identical, and the speed did not change (17.6 s vs 21.0 s for 36 runs, contended).

**Results.** Same detections and motion results as before, deep-equal on all 9 fixtures. Per
clip, through `processClip` (contended):

| | Max stall | p99 | Stalls > 250 ms (9 clips) | Load |
|---|---|---|---|---|
| Before | 0.2–8.8 s (6.9–8.8 s on 4 of the 9 clips) | 45 ms–4.1 s | 121 | 41–74 |
| After | 119–187 ms | 32–53 ms | 0 | 40–68 |

During detection the loop now waits at most 121–162 ms, and during the model load 53 ms. The
stage-by-stage pass still saw two gaps of 259–262 ms during detection. What is left is GC
(~110 ms) and the cheaper spawns. Startup (ArkType compiling the config schemas)
still blocks for ~5 s, but that happens before the server listens.

## 10. Live view: Sharp by default

Measured on the real RLC-823S1 from this machine, single runs, **contended** (load average ~58 on
16 cores for the first-picture times):

| Path | First picture | Bitrate | Server cost |
|---|---|---|---|
| Sharp, 4K HEVC copied (Chrome) | 1.5–3.3 s from look4 | ~2 Mbps | ~1% CPU, no GPU |
| Sharp, 1080p NVENC transcode (Edge, no HEVC) | ~2.5 s | 2.5 Mbps (was 6.7–7.3 before capping) | ~14% CPU, NVDEC 7%, NVENC 4% |
| Quick, 640×360 H.264 copied | 2.3–4.0 s | ~50 kbps | ~0 |
| Any CPU path at 4K (x264, MJPEG) | — | — | 0.5–0.8× real time: falls behind |

So Sharp is the default wherever the browser plays HEVC or the server has NVENC, and the server
reports `defaultStream: "sub"` when neither holds. Changes that made it viable:

- `-fflags nobuffer` threw away the keyframe found while probing, so every start waited almost a
  GOP (1.2 s on main, 2.5–4 s on sub). Removed: the gap from init segment to first fragment is
  now 0–48 ms.
- `-flags low_delay` makes 4K HEVC decoding single-threaded; it is kept only on the copy path,
  and the CPU rungs get `-threads 4`.
- A failed HEVC playback retries the H.264 transcode before falling to Motion JPEG, and the
  probe uses the codec string the server actually sends (`hvc1`, which the second session after
  a start gets; the first is `hev1`).
- ~~Phones on a slow link drop to Quick by themselves (media buffered per wall second below 0.85
  over 6 s, or `waiting` over 3 s), once per session.~~ Removed 2026-10-16: it dropped a fast
  connection to Quick often. From the browser a slow link looks the same as the camera or the
  server pausing (a `waiting` over 3 s, a GOP arriving late), so no threshold separates them;
  Sharp vs Quick is now only ever the user's pick. A stream that stops entirely still reconnects.

Skipped from the Reolink app as niche here: two-way talk, patrol and auto-scan, multi-camera
grids, the SD playback timeline, PTZ calibration, image sliders, and alerts inside Live.

**The wheel zooms where the pointer is.** The lens only zooms around the middle of the picture, so
driving it first (the earlier design) ignored the pointer until it was all the way in. There are
two ways now, a choice in ⋯ More stored per browser (`look4:live-wheel`).

*Magnify first* (`"picture"`): the wheel magnifies at the pointer at once, and 700 ms after it rests the lens frames that part of the
scene (the `box` op, a box of the frame's shape around the view's centre, as much of the
magnification as the lens has left); the rest stays digital (`web/src/live/lens.ts`). The live
stream shows a move about a second after the camera makes it, and a magnified view of a picture
that is itself zooming swings far past the target, so the stage holds the last frame from before
the move until the moving picture settles. It tells the two apart by the change of a 64×36 grey
copy per 100 ms: the median pixel's change, less the picture's overall brightening or darkening.
That reads 0 on eight still clips from this camera across a day (wind and birds included); on the
demo's fixture clip, which drifts, at most 7 from its first frame over 10 s and 2 between samples;
on a simulated 2.5× lens move, 9 at its first sample, 8–16 between samples and 16–25 from the
start. The move has reached the picture past 8 from the start, has arrived after three samples
under 4 apart, and nothing holds the picture longer than 8 s. The mean change was tried first (0.4
at most on the still clips, 15–22 on the move) and failed in the browser: a bird filling the
fixture's frame plus Chrome's coarse default downscale read 2–5 per sample and 5–12 from the start
on a still camera. Out, the wheel magnifies back to 1× and
then zooms the lens out around the middle. A pinch only magnifies. Not yet measured: the real
camera's framing accuracy and how long the picture is held, and the night picture's
noise against the thresholds.

*Camera zoom first* (`"camera"`, the default): the user found magnify first's swap from the
magnified picture to the lens's janky, so the lens goes first and the picture magnifies only what
the lens can't take. The first version (one `Set3DPos` box per request, sent 250 ms after the latest
notch, the next only once the picture had settled) was laggy and, on the real camera, wrong: "a big
white box, then it randomly zooms all the way out, then suddenly all the zoom in happens at once".
Measured on the RLC-823S1 on 2026-10-15 (logs in the thread's `wheel/` directory), and what changed:

- **`Set3DPos` with a box doesn't zoom in on this camera.** A 1.5× box (x 0.1, y 0.2, w = h = 2/3)
  moved the lens from position 8 to 7 at the automatic speed, and to 4 at speed 64. A point (w = h =
  0) pans and tilts to centre it and leaves the zoom alone (x 0.3, y 0.6: pan +64, tilt +10 units),
  done about 1 s after the command. A point then `StartZoomFocus ZoomPos` 0.6 s later: both finish;
  `ZoomPos` then a point: the point stops the zoom (target 14, stopped at 11). So the `box` op (Aim,
  "Zoom camera here", magnify first's handoff, close-ups) is now a point at the box's centre and then
  `ZoomPos` to the position whose magnification is the current one over the box's longer side, in
  one POST, point first. Not yet measured: whether the camera finishes both when they arrive in one
  POST rather than 0.6 s apart (`aimAndZoom` in `src/live/reolink-control.ts` is where to split them).
- **The lens's real magnification** (`src/live/zoom-curve.ts`), by registering the sub stream at
  each fourth position (NCC 0.89–0.95): 1.00× at 0, 1.15 at 4, 1.38 at 8, 1.61 at 12, 1.84 at 16, 2.07
  at 20, 2.30 at 24, 2.53 at 28. The linear model before said 5.0× at 28, twice too much, in the zoom
  slider's label, the wheel's room and every factor → position conversion. Server and page share it.
- **`GetPtzStat` reads 0 even mid-move**, so nothing waits on it any more: a move has arrived when
  `GetPtzCurPos` pan/tilt and `GetZoomFocus` zoom hold across two reads (0.2 s each idle, up to 0.8 s
  while moving). `zoomTo` takes `aim` (the point first, batched as above) and `settle` (answer once
  arrived, 3 s at most); views and Home wait the same way before their thumbnail and position (20 s at
  most). Both caps are deadlines, not counts of reads: twenty reads at 0.2–0.8 s each would have held a
  `settle` 7–19 s (11.6 s measured with the mock behind a 400 ms proxy), past the page's 8 s run cap,
  and a read still out at the deadline is cut off. Only a wait that arrived, and that no newer move
  replaced, writes the lens position it read into the cache relative zooms start from.
- **Order at the camera.** The page lets a wheel-out go 150 ms after an aimed step. The first aimed step
  after a start used to read `Get3DPos` (the frame size) before its batch, so a zoom out could reach the
  camera first and the step then zoomed back in (mock behind a 250 ms proxy: `ZoomPos` 4, then 16; the
  camera ended at 16). A move is now counted when its request arrives, an aimed one sends nothing if a
  newer move came while it waited, and the controls read learns the frame size up front.
- **Latency.** `zoomTo` was 0.43–0.71 s: it read `GetZoomFocus` for the range on every call. The range
  is static, so it's read once and a `zoomTo` is one round trip. Command → picture changed at the
  client: 0.82–0.92 s (0.35–0.45 s of it the stream path). The Live page's player sat p50 0.79 s (p90
  0.83) behind its newest buffered frame, since `MAX_LAG_S` only jumps past 1.2 s. It now keeps a
  cushion: 1.15× while more than cushion + 0.2 s behind, until under the cushion (pitch kept; never
  while `waiting`). A fixed 0.2 s cushion stalled: against the mock demo in headless Chromium (30 s at
  250 ms per run, load average 25–31), Quick p50 0.24–0.26 s against the old 0.40–0.80, but `waiting`
  in 10 of 11 Quick runs (1–3 short ones each, 11–24 ms) where the old player had 0 in 5 interleaved
  runs, also in windows with no speed-up. So the cushion starts at 0.3 s and each stall after playback
  began adds 0.1 s, up to 0.7: Quick 0 `waiting` in all 8 runs, p50 0.32–0.42 s (0.64 in one run of a
  first build that also counted the start's own wait). Sharp p50 0.33–0.61 s against
  the old 0.33–1.11, `waiting` 0–7 per run against the old 0–5: the long ones (0.7–1.8 s) are this
  machine's load on both. Before/after on Quick is suggestive of a real fix (0 of 8 runs stalling
  against 10 of 11), not tuned further. Load (average 22–57 on 16 cores) was not the main cause of the
  lag.

The dispatcher now (`LiveStage`'s `pump`, `nextBurst` in `web/src/live/lens.ts`): the first notch
starts a run when the lens has room (≥ 1.1×); its first step goes once the picture is current, 50 ms
after that notch (the first events of a flick together), and later notches never push it back. A step
aims at the centre of `anchoredBox` at the pointer (corner `a·(1 − 1/F)`, side `1/F`, so the scene
point under the pointer is under it again) and zooms by `F`, rounded to whole lens positions
(`lensStep`; under one position it waits for more, and goes after 600 ms without). Notches during a
step add up, and the next step goes the moment the camera has arrived (not when the picture shows it),
computed in the view the camera now has, at the pointer: steady scrolling is a chain of steps about
0.5 s apart on the mock, where they were 1–2 s (4 s for a move never seen) apart. Zoom past the lens's
limit magnifies at the pointer once the run is over: no step on its way, the camera arrived, and the
picture held still for three samples at least 0.4 s after that (or 2 s after, if the move never showed;
8 s after anything at most). Feedback (`web/src/live/iris.ts`, chosen over a viewfinder's corner
brackets and a frosted "lifted pane" by a judge on recorded day and night frames, then two critique
rounds and a code review): from the first notch the target box stays crisp under a lit rim, and
everything outside it, the part about to be zoomed away, goes dim, grey and soft (one stage-wide
`backdrop-filter` layer, at 0.8 of full on the first frame). Further notches pull it tighter on a spring
that keeps its momentum, with a factor readout. While the first step is on its way, a light runs round
the rim. When the move shows, the hole opens to the frame along the rest of the zoom's ease-in-out (from
4.5% in, 590 ms), so its edges stay on the box's contents, and the light dissolves. A run cancelled
before it went relaxes back out; later steps, asked for or on their way, get only a faint rim at the
frame's edge, plus a line closing in on each notch. Under reduced motion it is the same picture, still,
with short fades. Two Chromium facts shaped it. A `clip-path` hole in a backdrop-filter blurs its
inside too under the Live page's rounded `overflow: hidden` frame, so the hole is a mask: four bands
and four rounded corner pieces. And a backdrop-filter at opacity 0 is still drawn (a third of the
frame rate at 4K in software), so unused layers are `visibility: hidden`. Out: an unsent step shrinks
or goes first, then the
magnification, then the lens with an absolute `zoomTo` at once, latest wins: it ends the run, and the
server's wait for the step's arrival ends with it (the page's PTZ queue holds a settling `zoomTo` for
150 ms only). The picture isn't current for 2.5 s after a move outside a run (a lens zoom out, a saved
view or Home, a run cut off with its step on the way): a point aimed on it would be read by the camera in
the view it has, not the one shown, and would stop that move halfway. A run begun then gathers notches
under the quiet cue and sends its first step, with its box, once the 2.5 s are up. A refused step, another camera, the other mode, a saved view or actual size ends the run with
no retry. A camera that zooms but can't aim zooms around the middle and magnifies the rest at the
pointer. In either mode the wheel over the picture is the picture's, all the way out too (it then does
nothing), and the page scrolls only from outside it. It used to fall through to the page once there was
nothing left to zoom out, so the notches past the end of a zoom out scrolled the page, and the camera's
zoom out, which the picture shows a second later, invited more. The page scrolls little anyway: of five
window sizes tried, only 900×900 scrolled at all (436 px), and theater and full screen never do. One
exception: a page scroll under way (wheel events under 400 ms apart, a trackpad's momentum included)
stays the page's when it slides the picture under the pointer. Without it, a scroll back up from below
the picture stopped there and zoomed the camera all the way in. Checked with real wheel events against
the mock camera on that 900×900 window: a flick out from lens position 12 scrolled the page all of its
436 px under the old rule, and none now. Not yet measured on the real camera: how a chain of steps looks there, and whether the
picture's "moved" reading opens the box in time, and the blur's cost on Electron's GPU path at 4K.

## 11. Ingest: the camera's live stream, gated by the camera's own motion detection

look4's pipeline can't check a continuous stream: the detector took 58–70 s per 30 s segment at
concurrency 1 on this machine, so it falls further behind every hour. The camera's motion
detection runs on the camera for free, so a Reolink source now records its RTSP stream in 6 s
segments, polls `GetMdState` (and `GetAiState` while that is quiet) about once a second, and joins
the segments around each motion event (4 s pre-roll, 8 s post-roll, gaps under 8 s merged, split
at 2 min) into one clip for the usual pipeline. The rest goes to `data/unchecked/` for
`motionlessDays`, capped at `retention.uncheckedGb` (10): 4K main-stream footage is ~17–22 GB a
day at the measured 1.6–2.0 Mbps, so age alone would fill this machine's 37 GB of free disk down
to the floor in about a day and a half, and ingest would then refuse the clips that matter. Under
the floor unchecked footage goes first, and the sweep leaves headroom (1 GB, or five minutes of the
stream if that is more) above it so a new clip's join and ingest are never refused for want of it. A failed or stale motion read counts as motion (fail open). This replaces
pulling the SD card when RTSP is on and a password is set (`capture: "auto"`): no card, no 60 s
poll delay, sound in every clip, and Record on the Live page can reach 10 s back.

**Lockout safety.** The poller holds one login for the run and logs out on stop. A refused
password (from the API, or an RTSP 401 from ffmpeg) pauses both ffmpeg and the poller until the
password is changed: a Reolink camera locks after a handful of wrong tries.

**Not yet verified on the real camera:** the motion poll itself (shapes come from captured
`GetMdState`/`GetAiState` replies), how far the event boundaries sit from the motion, and whether
ffmpeg 4.4 reports a real RTSP 401 as the recorder expects.

**Superseded in part by §12:** on the real camera its motion detection almost never fires for a
small bird, so the gate is now the camera's detection OR look4's own watch of the preview stream
(`motionGate: "both"`, the default). The gate fails open only for time neither can tell about.

## 12. Ingest: look4's own motion watch on the sub stream

**Why.** Measured on the real RLC-823S1 (2026-10-15, a wide 4K view of two small feeders, a fence,
bushes and vines): 60 one-second `GetMdState` reads during busy feeder time were all 0; the SD card
held 22 motion recordings from midnight to 10:03; once look4 gated on the camera, 8 clips came from
10:00 to 12:23. In a 3-minute live check (11:48–11:51) four bird visits at the right feeder
produced no camera event, and all 31 main-stream pieces went to `data/unchecked/`. The camera's
own settings are left alone on purpose.

**What.** A Reolink source recording its stream also runs one more ffmpeg on the camera's sub
stream (`h264Preview_01_sub`, 640×360 H.264), decoded to 320×180 grey at 4 fps
(`src/sources/stream-motion.ts`). Its readings (one per second, `null` while warming up) join the
camera's in `planCapture`: **footage around motion either one saw becomes a clip**; time neither
can tell about fails open. A watch that is down leaves the camera to decide alone, and the other
way round. It starts only after the recorder's first frame, so a wrong password costs one RTSP try,
and a 401 on the sub stream refuses the source like one on the main stream (never retried).
Restarts back off 2 s → 5 min; no frame for 15 s restarts it. No sensitivity knob: every setting
that cut wind further lost birds.

**The watch, per frame.** (1) Map the frame onto the background with a robust gain + offset (the
16-bin median fit of §3), comparing only within the brightness range the mapped frame can show.
(2) A pixel changed when `|frame − background| > max(8, 2 × noise)`, `noise` its own running mean
absolute deviation (EMA 0.02, one frame's share capped at 2× the threshold). (3) Over 12% changed:
a whole-frame change, taken into the background at once, never motion; 3 in a row (the camera
moving) or one over 50% (IR switch) starts over with a 15 s warm-up. (4) 3×3 majority clean-up
(≥ 5 of 9). (5) Flicker mask: per-pixel EMA (0.01) of toggles between changed and unchanged; above
0.05 a pixel doesn't count. (6) Blobs: 8-connected components of a dilated copy, sized by the
cleaned pixels, 6 px to 25% of the frame. (7) Motion: a blob in 2 of the last 3 frames.
(8) Background EMA 0.05 (≈5 s), 0.0125 where changed. The on-screen clock and name (from
`GetOsd`, else top centre and lower right) never count.

| Parameter | Value | Evidence |
|---|---|---|
| Frame | 320×180 | Best 640×360 and best 320×180 settings had the same recall (19/22) and day wind (5/9); 320×180 cost ~4× less (4.3–5.1 vs 17–20 ms/frame) |
| Rate | 4 fps | A flyby crossing in ≥ 1 s gives ≥ 4 frames for the 2-of-3 rule. Not varied |
| Threshold | max(8, 2 × noise) | Majority clean-up, 6–8 px floor: k 3 / floor 14 caught 11–13 of 22 bird pieces; k 2.5 / 10, 17–18; k 2 / 8, 19 |
| Clean-up | majority ≥ 5/9 | Same thresholds: a 3×3 opening caught 8–16/22, majority 11–19/22 |
| Min blob | 6 px | 12 px caught 13–17/22, 6 px 18–19/22; 16 px, 4–14/22 |
| Flicker mask | toggles, 0.01, 0.05 | Same recall as no mask, wind halved. A share-of-time-changed mask (0.005/0.05) cut more wind but lost a bird piece (18/22) and hides a perch ~90 s after a 20 s visit |
| Whole-frame | 12%, absorb; restart after 3 or > 50% | Synthetic pan/tilt 1–3 px/frame and zoom 0.5%/frame for 3 s: 0 motion frames. In dim light the mimic's 4 s keyframes changed > 12% every 4 s; freezing on each blinded the watch 9–21% of the time, absorbing 1.7–12% at equal recall |

**How it was tuned.** 4K pieces the camera called quiet (`data/unchecked/2026-10-15/`,
09:57–10:41, 427 pieces, birds very active) and the old all-footage source's 30 s clips (dawn
07:14–07:29, night 00:10–06:59 under IR) were each turned into a sub-stream mimic: 4K → 640×360,
H.264 256 kbps CBR, 10 fps, 4 s GOP (the camera's own sub-stream settings), decoded at 4 fps like
the live path, run in time order with state carried across, first 20 s of each run left out.
Labels by eye on 4K frames: 23 bird pieces (feeders, fence top, ground, chair, table, lattice,
flying; sparrows, finches, doves, a nuthatch) and 15 wind-only pieces (10 day, 5 dawn). One
labeller, one morning, one camera: every number is suggestive.

| Setting | Bird pieces with motion | Bird pieces inside a clip | Wind-only 6 s windows flagged, day / dawn | Footage flagged: morning / dawn / night / live noon | Clips/h, same |
|---|---|---|---|---|---|
| **Pick** | **19/22 = 86% (95% CI 67–95%)** | **21/22 = 95% (78–99%)** | **2/9 = 22% (CI 6–55%) / 11/25 = 44% (27–63%)** | 87% / 80% / 29% / 85% | 37 / 45 / 34 / 45 |
| Same, freeze on whole-frame | 19/22 | 21/22 | 2/9 / 10/25 | 86% / 76% / 29% / 85% | 39 / 37 / 35 / 45 |
| No mask (k 2.5) | 19/22 | 21/22 | 5/9 / 20/25 | 90% / 96% / 38% / 99.5% | 35 / 33 / 37 / 45 |
| Share-of-time mask (k 2.5) | 18/22 | 21/22 | 1/9 / 10/25 | 79% / 61% / 21% / 75% | 42 / 66 / 29 / 45 |

The 3 bird pieces without motion: a sparrow on dark ground in shade, one on the chair at the right
edge, one still feeding at the left feeder whose arrival ~50 s earlier was caught (the one piece
outside every clip). The morning had birds nearly all the time, so most of it being flagged is
right; wind-only windows are the honest false-positive measure, and the grass tuft at lower left is
the persistent culprit, then the bushes and vines along the top. The finalists differ by 1 piece of
22 on recall (not significant) and suggestively on wind.

**Live check** (real sub stream, 11:48:02–11:51:03, sunny, light wind): all four bird visits fell
inside motion runs, live and replayed through the pick; the camera flagged none. **Cost**
(contended, load 11–15): ffmpeg 2.12 s CPU in 183 s = 1.2% of one core, the watch 1.59 ms/frame =
0.6%; ~1.4 MB of buffers. A frame is one synchronous step of a few ms, under §9's 20 ms slice.

**Synthetic checks** after warm-up on real quiet footage: pan 1 and 3 px/frame, tilt and zoom for
3 s → 0 motion frames; exposure ramp 2%/frame → 1; IR-like remap → 0. An abrupt +30% exposure step
gave 6 motion frames and a sudden gamma 0.8 tone change 22 (5.5 s): the gain + offset fit can't
absorb a non-linear jump.

**The pipeline's motion stage on gated clips.** `runMotionGate` at the defaults on ~18 s 4K clips
around each labelled piece (whole-frame zone):

| | Pass at minArea 0.0008 | 0.0004 | 0.0002 | 0.0001 | Peak blob |
|---|---|---|---|---|---|
| 23 bird clips | **4 (17%, CI 7–37%)** | 14 | 22 | 23 | 0.016–0.224% of the frame, median 0.047% |
| 15 wind clips | 2 | 5 | 13 | 15 | 0.016–0.087% |

No floor separates them: by the time it passes 96% of the birds it passes 87% of the wind. So a
clip marked `gate:<id>` is never dropped at motion (§3); lowering `minArea` would only trade birds
for wind and change every other source. The stage costs 3.6–8.3 s per 18 s 4K clip (median 5.0 s,
contended) and every gated clip now reaches the detector (18–60 s each). So the detector's load is
the share of footage flagged, 80–87% of busy daytime: more than under `all`, whose stage 1 at 0.0008
drops most daytime clips (and 19 of these 23 birds). The watch's ~2% of a core is the watch alone.

**Gaps.** Night recall is unmeasured (no night bird labelled; 29% of IR footage flagged, mostly the
grass tuft), and so is the dusk IR switch on the real stream. What the detector finds on these
clips is unmeasured. An abrupt non-linear tone change reads as ~5 s of motion. A bird landing wholly
on pixels that flickered in the last ~30–45 s isn't seen until they calm down (a rate of 0.3 decays
under 0.05 in ~45 s, 0.15 in ~27 s). No hawk was in the footage: anything hawk-sized (≥ 100 px at
320×180) is far above every floor, unless it only moves during a whole-frame change. Unjoined,
clips ran 34–45/h, above the ~30/h budget, so motion runs up to two quiet segments apart (`joinMs`,
13 s to allow for segment jitter) are joined into one clip, gap included: 25–37/h measured, for +2–6
points of footage flagged. A finished clip now waits up to that long for the quiet after it.

## 13. Close-ups: zoom in only on what the detector calls a bird (2026-10-15)

**Decision.** `closeUps` on a Reolink source (off by default) zooms the camera onto a bird for a
sharp still, then back Home (`src/live/closeup.ts`). The trigger is look4's motion watch (§12)
**confirmed by the detector**, not motion alone: on a windy day the watch flags 80–87% of the
footage, nearly all of it leaves, and a camera that zoomed on each would be useless and never at
Home. Per check: one `Snap`, then one detector view (§4's `zoomView`, ≥ 384 px square) around each
of the two largest moving areas, `bird` at the detector's threshold.

**Latency, measured** (one view of a synthetic 4K wide still: the cardinal fixture frame shrunk to a
quarter on a blurred copy of itself, so the bird is ~260 px wide; **contended**, load 25–40 on 16
cores): 1.0–4.3 s per view, medians 2.9 s and 1.7 s over two runs of 8; the bird scored 0.57, an
empty view of the same still nothing. Uncontended it should be near §1's 0.5 s a view (unmeasured).
Model load on a cold process: 6–11 s, which the clip pipeline usually has paid already. Scoring a
4K still's sharpness (Laplacian variance of the middle half at 960 px, grey): ~0.2 s, mostly JPEG
decoding; a 3 px blur dropped the score from 42 to 11. So a bird is in frame roughly 2–6 s after it
first moves (the watch's 2-of-3 frames at 4 fps, a `Snap`, one or two views, the lens move): fine
for a bird feeding, too slow for a flyby.

**Budget.** At most one check per camera every 8 s, a minute's rest after a close-up, and the
check's views wait their turn on the detector the clips use (at most the one view in flight). That
caps close-ups at roughly 13–33% of the detector's time on a constantly moving day, the cost of
choosing the detector over motion alone.

**Side effects.** The zoom is a whole-frame change, so the watch restarts its 15 s warm-up when the
lens moves and again on the way Home: no motion, so no new trigger and no new clip, for ~15 s each
time, and blobs are never read in zoomed coordinates. Its readings are `null` meanwhile, which the
gate fails open on only if the camera's own detection can't be read either. The zoom happens inside
the motion run that set it off (plus the 8 s post-roll and 13 s join), so the zoomed seconds are
part of that clip. Stills wait in `data/closeups/` and are filed into the clip's media as
`closeup-N.jpg` when the capture reports the clip covering them (bus `captured`).

**Not verified on the real camera:** everything end to end. Against the mock RLC-823S1 through the
real control driver, a close-up sent `Set3DPos` for the expected box, took 1 + 3 `Snap`s, and was
back Home 1.9 s after the motion (mock moves take 0.5 s). Unknown: how long the real lens takes to
move and focus (the wait gives up after 8 s and shoots anyway), `Set3DPos`'s framing accuracy
(§10), the real `Snap` latency at 4K, how often real birds clear the threshold at the real
camera's distance, and the 8 s / 60 s / 2 min timings, which are guesses.

## 14. Life list: look4 decides "new", the judge only identifies; feeders judged as sheets (2026-10-22)

**What went wrong.** One morning the `new-for-life-list` lookout kept five clips, every one a
regular misread: Mourning Doves as a Dark-eyed Junco, a Eurasian Collared-Dove and a White-breasted
Nuthatch, a Northern Cardinal as a House Finch, a House Sparrow as a House Wren, all at species
confidence 0.5–0.6 (Sonnet 5.5). The judge was shown the person's words ("more likely than not, 50%+
is fine"), a rubric asking for a species not on the list, and which listed species still lacked a
clip, with "a lookout … is satisfied by any of these". Both clipless species, House Finch and
White-breasted Nuthatch, turned up among the five. Asked to find a lifer, it found one.

**Decision.** A lookout compiles to `lifeList: "new" | "newOrClipless"` (compiler v4) and its rubric
no longer mentions the list. The judge sees the life list only as "this camera's regulars", never the
person's words for such a lookout and never which species lack a clip. `lifeListVerdict` (judge.ts)
then keeps a clip only when the judge's species is new for the lookout's mode **and** named at
`NEW_SPECIES_CONFIDENCE` = 0.75 or more; the "New species" badge uses the same bar.

**Replay** (the 21 clips still on disk, `claude-sonnet-5-5` via `claude-code`; for each of the 6
confirmed lifer clips its species was hidden from the list so it played a new bird):
- 15 regular clips (Mourning Doves, with sparrows and a jay): 0 called new.
- Hidden lifers: Northern Cardinal 0.90 and Downy Woodpecker 0.80 kept (the Downy was 0.60 under
  the old prompt); Black-capped Chickadee 0.80 kept once feeder sheets landed (below). Missed: a soft
  House Sparrow (no species named), a Blue Jay clip whose crops were a squirrel, and a blurred
  Mourning Dove read as the House Sparrow beside it. All three were kept before only by 0.55–0.6 calls,
  the same band as the five false lifers, so the bar costs them by design.
Six lifer clips is a small sample: read it as "the false lifers stop and clear lifers still pass",
not as a recall figure.

**Feeder sheets.** A clip the detector finds nothing in (a still bird on a feeder) went to the
judge with feeder crops from the motion gate's frames. The chickadee clip shows why that fails: the
bird sat still on the feeder for 0–3 s of 24 and the feeder then swung for 20, so every frame
motion picked showed an empty feeder ("only empty feeders", 0.96). Ranking frames by difference from
the feeder's median look failed too: the swing (~8 px of 48) outscored the bird (~7×3 px), with or
without aligning shifts of up to 6 px. So the judge now gets one image per feeder, every keyframe
tiled with its time (`feederSheets`: 12 tiles of 256 px, 1024×768, ~1k tokens). Keyframes decode on
their own: one pass over a 24 s 4K clip's 12 keyframes takes ~3.2 s, where seeking 4 frames took
6.0 s. The judge then named the chickadee "clearly on the feeder tray at 0.0s and 2.0s".

Also found: the dev server had run since before the feeder fallback was written, so it had never run
(0 feeder crops in the database, 131 "no bird detected" drops in a day).
