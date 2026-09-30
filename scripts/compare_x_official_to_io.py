#!/usr/bin/env python3
"""Compare one bounded TwitterAPI.io result with X API v2 full-archive search.

The TwitterAPI.io acquisition is run separately so the production window and
split logic remains the code under test. This script fetches the identical UTC
interval from X, follows v2 pagination correctly, and compares normalized post
identity, timestamps, text, and reply classification.
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("username")
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--io-output", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--max-pages", type=int, default=10)
    parser.add_argument(
        "--max-official-rows",
        type=int,
        default=1000,
        help="stop after this many billed X API rows (default: 1000)",
    )
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument(
        "--official-window-hours",
        type=float,
        help="split the official query into adjacent half-open windows",
    )
    return parser.parse_args()


def load_env_value(path: Path, name: str) -> str:
    if value := os.environ.get(name):
        return value
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{name}="):
            value = line.split("=", 1)[1].strip()
            if value:
                return value
    raise RuntimeError(f"{name} is missing")


def utc_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def format_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def request_json(url: str, bearer: str, retries: int) -> tuple[dict[str, Any], float]:
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {bearer}",
            "User-Agent": "STELA-official-api-compare/0.2",
        },
    )
    for attempt in range(retries + 1):
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read()), time.perf_counter() - started
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            if error.code == 429 and attempt < retries:
                delay = min(15.0, 2.0 * (attempt + 1))
                time.sleep(delay)
                continue
            raise RuntimeError(f"X API HTTP {error.code}: {detail[:500]}") from error
    raise AssertionError("unreachable")


def fetch_official_interval(
    args: argparse.Namespace,
    bearer: str,
    start: str,
    end: str,
    row_budget: int,
) -> dict[str, Any]:
    base_params = {
        "query": f"from:{args.username.lstrip('@')} -is:retweet",
        "start_time": start,
        "end_time": end,
        "max_results": "100",
        "sort_order": "recency",
        "tweet.fields": (
            "id,created_at,author_id,conversation_id,lang,public_metrics,"
            "referenced_tweets,text"
        ),
    }
    raw_posts: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    pagination_token: str | None = None
    seen_tokens: set[str] = set()
    total_elapsed = 0.0

    for page_number in range(1, args.max_pages + 1):
        params = dict(base_params)
        if pagination_token:
            params["pagination_token"] = pagination_token
        url = "https://api.x.com/2/tweets/search/all?" + urllib.parse.urlencode(params)
        body, elapsed = request_json(url, bearer, args.retries)
        total_elapsed += elapsed
        rows = body.get("data") or []
        if not isinstance(rows, list):
            raise RuntimeError("X API data is not a list")
        raw_posts.extend(rows)
        if len(raw_posts) > row_budget:
            raise RuntimeError("X API row safety limit reached")
        meta = body.get("meta") or {}
        next_token = meta.get("next_token")
        pages.append(
            {
                "page": page_number,
                "start": start,
                "end": end,
                "elapsed_seconds": round(elapsed, 3),
                "result_count": len(rows),
                "has_next_token": bool(next_token),
            }
        )
        if not next_token:
            break
        if next_token in seen_tokens:
            raise RuntimeError("X API repeated a pagination token")
        seen_tokens.add(next_token)
        pagination_token = str(next_token)
    else:
        raise RuntimeError("X API page safety limit reached")

    unique = {str(row["id"]): row for row in raw_posts}
    return {
        "query": base_params["query"],
        "request_count": len(pages),
        "request_elapsed_seconds": round(total_elapsed, 3),
        "raw_count": len(raw_posts),
        "unique_count": len(unique),
        "duplicate_count": len(raw_posts) - len(unique),
        "pages": pages,
        "posts": list(unique.values()),
    }


def fetch_official(args: argparse.Namespace, bearer: str) -> dict[str, Any]:
    if args.official_window_hours is None:
        return fetch_official_interval(
            args, bearer, args.start, args.end, args.max_official_rows
        )
    if args.official_window_hours <= 0:
        raise RuntimeError("--official-window-hours must be positive")

    start = utc_timestamp(args.start)
    end = utc_timestamp(args.end)
    if start >= end:
        raise RuntimeError("--start must be before --end")
    width = timedelta(hours=args.official_window_hours)
    partitions: list[dict[str, Any]] = []
    cursor = start
    while cursor < end:
        partition_end = min(end, cursor + width)
        used_rows = sum(part["raw_count"] for part in partitions)
        partition = fetch_official_interval(
            args,
            bearer,
            format_utc(cursor),
            format_utc(partition_end),
            args.max_official_rows - used_rows,
        )
        partitions.append(partition)
        cursor = partition_end

    all_posts = [row for part in partitions for row in part["posts"]]
    unique = {str(row["id"]): row for row in all_posts}
    all_pages = [page for part in partitions for page in part["pages"]]
    raw_count = sum(part["raw_count"] for part in partitions)
    return {
        "query": f"from:{args.username.lstrip('@')} -is:retweet",
        "partition_hours": args.official_window_hours,
        "partition_count": len(partitions),
        "request_count": sum(part["request_count"] for part in partitions),
        "request_elapsed_seconds": round(
            sum(part["request_elapsed_seconds"] for part in partitions), 3
        ),
        "raw_count": raw_count,
        "unique_count": len(unique),
        "duplicate_count": raw_count - len(unique),
        "pages": all_pages,
        "posts": list(unique.values()),
    }


def io_posts(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("posts")
    if not isinstance(rows, list):
        raise RuntimeError("TwitterAPI.io result has no posts list")
    return rows


def official_reply(row: dict[str, Any]) -> bool:
    return any(
        reference.get("type") == "replied_to"
        for reference in (row.get("referenced_tweets") or [])
    )


def compare(args: argparse.Namespace, official: dict[str, Any]) -> dict[str, Any]:
    io_payload = json.loads(args.io_output.read_text(encoding="utf-8"))
    io_rows = io_posts(io_payload)
    official_by_id = {str(row["id"]): row for row in official["posts"]}
    io_by_id = {str(row["post_id"]): row for row in io_rows}
    official_ids = set(official_by_id)
    io_ids = set(io_by_id)
    shared = official_ids & io_ids

    timestamp_mismatches = sorted(
        post_id
        for post_id in shared
        if utc_timestamp(official_by_id[post_id]["created_at"])
        != utc_timestamp(io_by_id[post_id]["created_at"])
    )
    text_mismatches = sorted(
        post_id
        for post_id in shared
        if (official_by_id[post_id].get("text") or "").strip()
        != (io_by_id[post_id].get("text") or "").strip()
    )
    official_replies = {
        post_id for post_id, row in official_by_id.items() if official_reply(row)
    }
    io_replies = {
        post_id for post_id, row in io_by_id.items() if row.get("in_reply_to_post_id")
    }
    io_window_metrics = io_payload.get("metrics") or io_payload.get("window") or {}

    return {
        "schema_version": 1,
        "username": args.username.lstrip("@"),
        "start": args.start,
        "end": args.end,
        "policy": "authored posts; reposts excluded; replies included",
        "x_official": official,
        "twitterapi_io": {
            "unique_count": len(io_by_id),
            "reply_count": len(io_replies),
            "metrics": io_window_metrics,
        },
        "comparison": {
            "shared_count": len(shared),
            "id_sets_equal": official_ids == io_ids,
            "official_only_ids": sorted(official_ids - io_ids),
            "twitterapi_io_only_ids": sorted(io_ids - official_ids),
            "timestamp_mismatch_ids": timestamp_mismatches,
            "text_mismatch_ids": text_mismatches,
            "reply_sets_equal": official_replies == io_replies,
            "official_only_reply_ids": sorted(official_replies - io_replies),
            "twitterapi_io_only_reply_ids": sorted(io_replies - official_replies),
        },
    }


def main() -> int:
    args = parse_args()
    if args.max_pages < 1 or args.max_official_rows < 1:
        raise RuntimeError("official page and row limits must be positive")
    bearer = load_env_value(args.env_file, "X_BEARER_TOKEN")
    official = fetch_official(args, bearer)
    result = compare(args, official)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    comparison = result["comparison"]
    print(
        json.dumps(
            {
                "username": result["username"],
                "start": result["start"],
                "end": result["end"],
                "official_unique": result["x_official"]["unique_count"],
                "official_replies": sum(
                    official_reply(row) for row in result["x_official"]["posts"]
                ),
                "official_requests": result["x_official"]["request_count"],
                "official_elapsed_seconds": result["x_official"][
                    "request_elapsed_seconds"
                ],
                "io_unique": result["twitterapi_io"]["unique_count"],
                "io_replies": result["twitterapi_io"]["reply_count"],
                **comparison,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if (
        comparison["id_sets_equal"]
        and not comparison["timestamp_mismatch_ids"]
        and not comparison["text_mismatch_ids"]
        and comparison["reply_sets_equal"]
    ) else 2


if __name__ == "__main__":
    raise SystemExit(main())
