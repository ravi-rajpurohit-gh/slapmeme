#!/usr/bin/env python3
"""Safely trim leading and trailing silence from Meme Machine sound files.

The default mode is a report-only dry run. `--apply` first copies the complete
sound library to an app-data backup folder and only then replaces files with
trimmed, same-format re-encodes. It intentionally skips formats that Meme
Machine does not currently play (such as .m4a and .mov).
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path


PLAYABLE_EXTENSIONS = {".mp3", ".wav", ".ogg", ".flac"}
DEFAULT_LIBRARY = Path.home() / "Library/Application Support/com.mememachine.desktop/sounds"
SILENCE_START = re.compile(r"silence_start:\s*([0-9.]+)")
SILENCE_END = re.compile(r"silence_end:\s*([0-9.]+)")


def binary(name: str) -> str:
    """Find Homebrew's binary even when its bin directory is not on PATH."""
    return shutil.which(name) or str(Path("/opt/homebrew/bin") / name)


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=False, text=True, capture_output=True)


def duration(path: Path, ffprobe: str) -> float:
    result = run([
        ffprobe, "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ])
    if result.returncode or not result.stdout.strip():
        raise RuntimeError(result.stderr.strip() or "ffprobe did not return a duration")
    return float(result.stdout.strip())


def trim_points(
    path: Path,
    ffmpeg: str,
    ffprobe: str,
    threshold: str,
    minimum_silence: float,
    padding: float,
) -> tuple[float, float, float] | None:
    """Return (start, end, duration) or None when no safe trim is found."""
    total_duration = duration(path, ffprobe)
    detected = run([
        ffmpeg, "-hide_banner", "-nostats", "-i", str(path),
        "-af", f"silencedetect=noise={threshold}:d={minimum_silence}",
        "-f", "null", "-",
    ])
    output = f"{detected.stdout}\n{detected.stderr}"
    events: list[tuple[str, float]] = []
    for line in output.splitlines():
        if match := SILENCE_START.search(line):
            events.append(("start", float(match.group(1))))
        if match := SILENCE_END.search(line):
            events.append(("end", float(match.group(1))))

    if not events:
        return None

    start_time = 0.0
    end_time = total_duration
    tolerance = 0.03

    # Only remove an opening silence that begins at the audio's first frame.
    if events[0][0] == "start" and events[0][1] <= tolerance:
        first_end = next((time for kind, time in events[1:] if kind == "end"), None)
        if first_end is None:
            # The source is silent all the way through. Never replace it.
            return None
        start_time = max(0.0, first_end - padding)

    # A final silence may end at EOF with or without a silence_end event.
    # Internal pauses also have silence_start events, so only trim the last
    # silence when its final event is effectively at end-of-file.
    last_start = next((time for kind, time in reversed(events) if kind == "start"), None)
    final_kind, final_time = events[-1]
    final_silence_reaches_eof = (
        final_kind == "start"
        or total_duration - final_time <= max(0.15, minimum_silence + (padding * 2))
    )
    if last_start is not None and final_silence_reaches_eof and total_duration - last_start >= minimum_silence:
        end_time = min(total_duration, last_start + padding)

    if end_time - start_time < 0.04:
        return None
    if start_time < 0.005 and total_duration - end_time < 0.005:
        return None
    return start_time, end_time, total_duration


def encoder_options(extension: str) -> list[str]:
    return {
        ".mp3": ["-c:a", "libmp3lame", "-q:a", "2"],
        ".wav": ["-c:a", "pcm_s16le"],
        ".ogg": ["-c:a", "libvorbis", "-q:a", "5"],
        ".flac": ["-c:a", "flac"],
    }[extension]


def replace_with_trimmed(path: Path, ffmpeg: str, start: float, end: float) -> None:
    temporary = path.with_name(f".{path.stem}.trim-{uuid.uuid4().hex}{path.suffix}")
    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(path),
        "-ss", f"{start:.6f}", "-t", f"{end - start:.6f}", "-map_metadata", "0",
        "-vn", *encoder_options(path.suffix.lower()), str(temporary),
    ]
    result = run(command)
    if result.returncode:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(result.stderr.strip() or "ffmpeg could not encode the trimmed file")
    temporary.replace(path)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--library", type=Path, default=DEFAULT_LIBRARY, help="Active Meme Machine sounds folder")
    result.add_argument("--apply", action="store_true", help="Create a backup and replace files; omit for a dry run")
    result.add_argument("--threshold", default="-42dB", help="Silence threshold passed to FFmpeg (default: -42dB)")
    result.add_argument("--min-silence", type=float, default=0.08, help="Minimum silence run in seconds (default: 0.08)")
    result.add_argument("--padding", type=float, default=0.015, help="Audio retained around a cut in seconds (default: 0.015)")
    result.add_argument("--backup-dir", type=Path, help="Optional destination for the one-time full-library backup")
    result.add_argument("--restore-from", type=Path, help="Restore files from a prior full-library backup; requires --apply")
    return result


def main() -> int:
    args = parser().parse_args()
    library = args.library.expanduser().resolve()
    ffmpeg, ffprobe = binary("ffmpeg"), binary("ffprobe")
    if not Path(ffmpeg).is_file() or not Path(ffprobe).is_file():
        print("FFmpeg and ffprobe are required. Install FFmpeg first.", file=sys.stderr)
        return 2
    if not library.is_dir():
        print(f"Sound library not found: {library}", file=sys.stderr)
        return 2
    if args.min_silence <= 0 or args.padding < 0:
        print("--min-silence must be positive and --padding cannot be negative.", file=sys.stderr)
        return 2

    if args.restore_from:
        source = args.restore_from.expanduser().resolve()
        if not args.apply:
            print("--restore-from is destructive; pass --apply to confirm.", file=sys.stderr)
            return 2
        if not source.is_dir() or source == library:
            print(f"Invalid backup source: {source}", file=sys.stderr)
            return 2
        shutil.copytree(source, library, dirs_exist_ok=True)
        print(f"Restored active library from: {source}")
        return 0

    files = sorted(path for path in library.rglob("*") if path.is_file() and path.suffix.lower() in PLAYABLE_EXTENSIONS)
    plan: list[dict[str, object]] = []
    failures: list[dict[str, str]] = []
    for path in files:
        try:
            points = trim_points(path, ffmpeg, ffprobe, args.threshold, args.min_silence, args.padding)
            if points is None:
                continue
            start, end, total_duration = points
            plan.append({
                "file": str(path.relative_to(library)),
                "start_seconds": round(start, 3),
                "end_seconds": round(end, 3),
                "removed_seconds": round(total_duration - (end - start), 3),
            })
        except Exception as error:  # Keep analyzing the rest of the library.
            failures.append({"file": str(path.relative_to(library)), "error": str(error)})

    print(f"Scanned {len(files)} playable files in {library}")
    print(f"{len(plan)} file(s) have leading or trailing silence to trim.")
    for item in plan:
        print(f"  {item['file']}: {item['start_seconds']}s → {item['end_seconds']}s ({item['removed_seconds']}s removed)")
    if failures:
        print(f"{len(failures)} file(s) could not be analyzed:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure['file']}: {failure['error']}", file=sys.stderr)
    if not args.apply:
        print("Dry run only. Re-run with --apply to back up and trim these files.")
        return 1 if failures else 0
    if not plan:
        print("Nothing to trim; no files were changed.")
        return 1 if failures else 0

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = (args.backup_dir or library.parent / "backups" / f"sounds-before-trim-{timestamp}").expanduser().resolve()
    if backup.exists():
        print(f"Backup destination already exists: {backup}", file=sys.stderr)
        return 2
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(library, backup)
    print(f"Created original-files backup: {backup}")

    report = {"library": str(library), "backup": str(backup), "threshold": args.threshold, "files": plan, "failures": failures}
    for item in plan:
        path = library / str(item["file"])
        try:
            replace_with_trimmed(path, ffmpeg, float(item["start_seconds"]), float(item["end_seconds"]))
        except Exception as error:
            failures.append({"file": str(item["file"]), "error": str(error)})
            print(f"Could not trim {item['file']}: {error}", file=sys.stderr)
    report["failures"] = failures
    (backup / "trim-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Trimmed {len(plan) - len(failures)} file(s). Report: {backup / 'trim-report.json'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
