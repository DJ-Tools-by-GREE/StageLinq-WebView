#!/usr/bin/env python3
"""
Read hotcue positions for a list of tracks from an Engine DJ SQLite database.

Engine DJ stores hotcues as a zlib-compressed binary blob in the
PerformanceData table (column: quickCues).  This module decodes that blob
and returns cue positions in seconds.

Cue mapping used by this project:
    cue1 → in-transition start   (mix begins)
    cue3 → in-transition end     (previous track gone)
    cue6 → out-transition start  (next track becomes audible)
    cue8 → out-transition end    (this track gone)
"""

import os
import sqlite3
import struct
import zlib
from typing import Optional

# Engine DJ stores cue positions as a sample count at this fixed rate,
# regardless of the actual sample rate of the audio file.
ENGINE_SAMPLE_RATE = 44100


def _parse_hotcue_blob(blob: bytes) -> dict:
    """Decompress and parse an Engine DJ PerformanceData.quickCues blob.

    The blob layout (after stripping the 4-byte length prefix and decompressing):
        bytes 0–7   : int64 big-endian  — number of cue entries
        per entry:
            byte 0       : uint8         — length of the cue name string
            next N bytes : UTF-8 string  — cue name (skipped)
            next 8 bytes : double big-endian — position in samples (float64)
            next 4 bytes : uint32        — ARGB colour (skipped)

    Returns {cue_number: position_seconds} for every cue with position >= 0.
    Cue numbers are 1-indexed (entry 0 → cue 1, entry 2 → cue 3, etc.).
    """
    if not blob or len(blob) < 5:
        return {}

    # The first 4 bytes are a length prefix added by Engine DJ; skip them.
    # The remaining bytes are a raw zlib stream.
    try:
        raw = zlib.decompress(blob[4:])
    except zlib.error:
        return {}

    pos = 0

    # Read the count of cue entries (8-byte big-endian signed integer).
    if len(raw) < 8:
        return {}
    n_cues = struct.unpack_from(">q", raw, pos)[0]
    pos += 8

    cues = {}
    for cue_idx in range(n_cues):
        if pos >= len(raw):
            break

        # Read and skip the variable-length cue name.
        name_len = struct.unpack_from("B", raw, pos)[0]
        pos += 1
        if pos + name_len > len(raw):
            break
        pos += name_len  # skip name bytes

        # Read the 8-byte double that holds the position in samples.
        if pos + 12 > len(raw):
            break
        position_samples = struct.unpack_from(">d", raw, pos)[0]
        pos += 8
        pos += 4  # skip ARGB colour

        # A position of -1 means the cue slot is empty; skip those.
        if position_samples >= 0:
            cue_number = cue_idx + 1  # convert 0-indexed entry to 1-indexed cue number
            cues[cue_number] = position_samples / ENGINE_SAMPLE_RATE

    return cues


def _track_id_for_path(db_path: str, file_path: str) -> Optional[int]:
    """Return the Engine DJ track ID for the given audio file path.

    Engine DJ stores only the bare filename (no directory) in the Track table.
    Strategy:
        1. Try an exact match on the basename.
        2. Fall back to a LIKE search in case the stored name differs slightly
           (e.g. trailing whitespace or encoding difference).
    """
    if not os.path.isfile(db_path):
        return None
    try:
        con = sqlite3.connect(db_path)
        cur = con.cursor()

        basename = os.path.basename(file_path)

        # Exact match — fastest and most reliable.
        cur.execute("SELECT id FROM Track WHERE filename = ?", (basename,))
        row = cur.fetchone()
        if row:
            con.close()
            return int(row[0])

        # Fallback: partial match handles minor name differences.
        cur.execute("SELECT id FROM Track WHERE filename LIKE ?",
                    (f"%{basename}%",))
        row = cur.fetchone()
        con.close()
        return int(row[0]) if row else None
    except Exception:
        return None


def _hotcues_for_track_id(db_path: str, track_id: int) -> dict:
    """Fetch and parse the quickCues blob for the given track ID.

    Queries PerformanceData for the compressed blob, then hands it to
    _parse_hotcue_blob() for decoding.  Returns {} on any error or if
    no data exists.
    """
    try:
        con = sqlite3.connect(db_path)
        cur = con.cursor()
        cur.execute(
            "SELECT quickCues FROM PerformanceData WHERE trackId = ?",
            (track_id,)
        )
        row = cur.fetchone()
        con.close()

        if not row or row[0] is None:
            return {}

        return _parse_hotcue_blob(bytes(row[0]))
    except Exception:
        return {}


def read_engine_hotcues(tracks: list, db_path: str) -> None:
    """Populate cue1/cue3/cue6/cue8_secs on each Track object from the Engine DJ DB.

    Cue positions in the database are in original-track-file time (seconds from
    the start of the file, at the original playback speed).  The caller must
    convert to set time by adding detected_start_secs and dividing by tempo_ratio
    when needed — that conversion happens in write_tracklist / write_review_ui.

    Tracks marked as mashup or missing are silently skipped.
    If the database file does not exist, a warning is printed and the function
    returns without modifying any tracks.
    """
    if not os.path.isfile(db_path):
        print(f"  Engine DB not found, skipping hotcues: {db_path}")
        return

    for t in tracks:
        # Mashup and missing tracks have no meaningful cue positions.
        if t.is_mashup or t.is_missing:
            continue

        # Two-step lookup: filename → track ID → cue blob.
        track_id = _track_id_for_path(db_path, t.file_path)
        if track_id is None:
            continue

        cues = _hotcues_for_track_id(db_path, track_id)

        # Only overwrite fields where a cue actually exists in the DB.
        if 1 in cues:
            t.cue1_secs = cues[1]
        if 3 in cues:
            t.cue3_secs = cues[3]
        if 6 in cues:
            t.cue6_secs = cues[6]
        if 8 in cues:
            t.cue8_secs = cues[8]
