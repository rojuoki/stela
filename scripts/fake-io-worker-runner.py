#!/usr/bin/env python3
"""Offline runner used only by the eight-slot worker integration test."""

import json
import os
from pathlib import Path
import sys
import time


def option(name: str) -> str:
    index = sys.argv.index(name)
    return sys.argv[index + 1]


def main() -> int:
    username = sys.argv[1]
    output = Path(option("--output"))
    progress = Path(option("--progress-output"))
    checkpoint = Path(option("--checkpoint"))
    restored = json.loads(checkpoint.read_text()) if checkpoint.exists() else None
    if os.environ.get("STELA_IO_FAKE_REQUIRE_RESUME") == "1":
        assert restored and restored.get("resume", {}).get("marker") == "saved-window", "DB checkpoint was not restored"
    state_directory = Path(os.environ["STELA_IO_FAKE_STATE_DIR"])
    state_directory.mkdir(parents=True, exist_ok=True)
    started = time.time()
    state_file = state_directory / f"{username}.json"
    state_file.write_text(json.dumps({"pid": os.getpid(), "started": started}), encoding="utf-8")

    created_at = "2020-01-01T00:00:00Z"
    payload = {
        "username": username,
        "provider": "twitterapi_io",
        "profile": {
            "account_id": f"fake-{username}",
            "username": username,
            "created_at": created_at,
        },
        "config": {"collection_mode": "prefix_initial", "target_count": 1000},
        "result": {
            "status": "EXPERIMENTAL_ACCOUNT_HAS_LESS_THAN_TARGET",
            "unique_post_count": 0,
            "progress_message": "Offline fixture complete",
        },
        "metrics": {
            "total_requests": 0,
            "total_pages": 0,
            "candidate_unique_count": 0,
            "duplicate_sightings": 0,
            "estimated_cost_usd": 0,
        },
        "windows": [{
            "start": created_at,
            "end": "2020-01-02T00:00:00Z",
            "status": "RESOLVED",
            "unique_post_count": 0,
            "requests": 0,
            "pages": 0,
        }],
        "candidate_posts": [],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    progress.write_text(json.dumps(payload), encoding="utf-8")
    checkpoint.write_text(json.dumps({
        "experiment": "twitterapi_io_oldest_block_checkpoint",
        "username": username,
        "resume": {"marker": "saved-window"},
    }), encoding="utf-8")
    print("PROGRESS fixture", flush=True)
    if os.environ.get("STELA_IO_FAKE_INTERRUPT") == "1":
        time.sleep(120)
    time.sleep(0.4)
    output.write_text(json.dumps(payload), encoding="utf-8")
    state_file.write_text(json.dumps({
        "pid": os.getpid(),
        "started": started,
        "finished": time.time(),
        "restored": restored is not None,
        "rate_limit_file": option("--shared-rate-limit-file"),
    }), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
