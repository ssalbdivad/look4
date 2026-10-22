# look4

Filter a camera's motion clips for "interesting" events described in plain English
("a cardinal or blue jay at the feeder", "any squirrel on the feeder pole").
First target is a Reolink feeder cam, but nothing in the pipeline is bird- or Reolink-specific.

## Cost model

Almost every motion clip is junk: leaves, shadows, light changes. So the design is a
cascade. Each stage is cheaper than the one after it and drops most of what it sees,
which means the paid model only ever looks at a few frames from a few clips.

| Stage | Runs | Cost | Drops |
|---|---|---|---|
| 0. Ingest | camera FTP upload, or the Reolink HTTP API pulling from the SD card | free | — |
| 1. Frame sampling + pixel diff | local, ffmpeg | free | static clips, light-only changes |
| 2. Open-vocab detector (YOLO-World / OWLv2) on sampled frames | local, CPU is OK at 1–2 fps | free | clips with no object matching the prompt's nouns |
| 3. VLM judge (Claude Haiku 5.5) on the best 1–4 crops | API | ~cents per 100 clips | false positives, and fine-grained calls (species, behavior) |
| 4. Optional: Sonnet re-check on stage-3 hits marked uncertain | API | rare | — |

The prompt gets compiled once, by the LLM, into (a) the detector's noun list
(`bird`, `squirrel`) and (b) the judge's yes/no rubric. Stages 2 and 3 are prompt-driven
with no retraining, which is what makes this general.

## Ingest

The core takes any video: a file, a directory, or an `inbox/` it watches. Each kind of
source is a small adapter that drops clips into `inbox/`, and everything after `inbox/`
is source-agnostic.

- `files`: a path or glob, for one-off runs over existing footage.
- `watch`: a directory that something else writes into (FTP server, NVR export, phone sync).
- `rtsp`: a continuous stream, cut into clips by the stage-1 motion gate. Most IP
  cameras offer RTSP.
- `reolink`: the camera's HTTP API (`Search` + `Download`) pulling recordings off the
  SD card.

First target: the RLC-823S1 (wired PoE). Set the camera to FTP-upload its motion clips
to a local FTP server pointed at `inbox/` (Settings → Network → FTP). The SD card stays
as a backup. The `reolink` adapter is the fallback.

## Output

- `kept/<date>/<clip>.mp4` plus a JSONL index: matched prompt, judge rationale,
  best-frame crop, and timestamp.
- Rejected clips are deleted after N days, not immediately, so thresholds can be
  re-tuned against real misses.

## Accuracy

- Keep a small labeled set (`eval/`) per prompt and report precision/recall when the
  detector threshold or judge model changes.
- Species-level calls on small, distant birds are the weak point. Crop-to-detection
  before judging, keep the camera within 1–2 m of the feeder, and log the judge's
  confidence.

## Open before building

- Where it runs: always-on local box (WSL, a Pi 5, an old laptop).
