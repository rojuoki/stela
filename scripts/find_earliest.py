#!/usr/bin/env python3
"""Find the oldest X post still obtainable through twscrape search.

This is an independent experiment; it does not import or modify STELA.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.metadata
import math
import random
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

UTC = timezone.utc


@dataclass(frozen=True)
class Window:
    start: datetime
    end: datetime

    def __post_init__(self) -> None:
        if self.start.tzinfo is None or self.end.tzinfo is None:
            raise ValueError("Window datetimes must be timezone-aware")
        if self.start >= self.end:
            raise ValueError("Window start must be before end")


class SearchFailure(RuntimeError):
    pass


def utc(dt: datetime) -> datetime:
    return dt.astimezone(UTC)


def floor_day(dt: datetime) -> datetime:
    dt = utc(dt)
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


def ceil_day(dt: datetime) -> datetime:
    return floor_day(dt) + timedelta(days=1)


def epoch(dt: datetime) -> int:
    return math.floor(utc(dt).timestamp())


def query_for(username: str, window: Window) -> str:
    # since_time is inclusive and until_time is exclusive in X search.
    return (
        f"from:{username} since_time:{epoch(window.start)} "
        f"until_time:{epoch(window.end)}"
    )


def label(window: Window) -> str:
    start, end = utc(window.start), utc(window.end)
    if start.time() == datetime.min.time() and end == start + timedelta(days=1):
        return start.strftime("%Y-%m-%d")
    if start.date() == end.date():
        return f"{start:%Y-%m-%d %H:%M:%S}-{end:%H:%M:%S} UTC"
    return f"{start:%Y-%m-%d %H:%M:%S} .. {end:%Y-%m-%d %H:%M:%S} UTC"


class TwscrapeClient:
    """Small API adapter with retries and an exact-query memory cache."""

    def __init__(self, db: Path, retries: int, retry_base: float, debug: bool) -> None:
        try:
            from twscrape import API
        except ImportError as exc:
            raise SearchFailure(
                "twscrape is not importable by this Python. Run with the Python "
                "environment where twscrape is installed."
            ) from exc
        self.api = API(str(db), raise_when_no_account=True, wait_timeout=30)
        self.retries = retries
        self.retry_base = retry_base
        self.debug = debug
        self.cache: dict[tuple[int, int, int], list[Any]] = {}
        self.probed_windows: set[tuple[int, int]] = set()
        self.searches = 0
        self.attempts = 0

    async def search(self, username: str, window: Window, limit: int) -> list[Any]:
        key = (epoch(window.start), epoch(window.end), limit)
        if key in self.cache:
            return self.cache[key]

        query = query_for(username, window)
        for attempt in range(self.retries + 1):
            self.attempts += 1
            try:
                rows = []
                async for tweet in self.api.search(query, limit=limit):
                    # twscrape 0.20 can yield a whole GraphQL page past limit.
                    # Keep the overshoot: it helps determine completeness safely.
                    rows.append(tweet)
                self.searches += 1
                self.cache[key] = rows
                return rows
            except Exception as exc:  # twscrape exception classes vary by version
                if attempt >= self.retries:
                    raise SearchFailure(
                        f"Search failed after {attempt + 1} attempts for {label(window)}: {exc}"
                    ) from exc
                delay = self.retry_base * (2**attempt) + random.uniform(0, 0.25)
                print(
                    f"RETRY {label(window)} attempt={attempt + 2} "
                    f"in={delay:.2f}s error={type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
                await asyncio.sleep(delay)
        raise AssertionError("unreachable")

    async def probe(self, username: str, window: Window) -> bool:
        rows = await self.search(username, window, 1)
        self.probed_windows.add((epoch(window.start), epoch(window.end)))
        hit = bool(rows)
        if self.debug:
            print(f"PROBE {label(window)} ... {'HIT' if hit else 'MISS'}")
        return hit


async def find_first_day(client: TwscrapeClient, username: str, created: datetime) -> Window:
    start = floor_day(created)
    end = ceil_day(datetime.now(UTC))
    whole = Window(start, end)
    if not await client.probe(username, whole):
        raise SearchFailure("No obtainable posts were found for this account")

    # Binary-search the monotone predicate: "the prefix [created_day, day) has a post".
    lo_day = 0
    hi_day = (end - start).days
    while hi_day - lo_day > 1:
        mid_day = (lo_day + hi_day) // 2
        prefix = Window(start, start + timedelta(days=mid_day))
        if await client.probe(username, prefix):
            hi_day = mid_day
        else:
            lo_day = mid_day
    return Window(start + timedelta(days=lo_day), start + timedelta(days=hi_day))


async def narrow_oldest_window(
    client: TwscrapeClient,
    username: str,
    window: Window,
    target: timedelta,
) -> Window:
    """Choose old halves until the first HIT window is at most target wide."""
    current = window
    while current.end - current.start > target:
        midpoint = current.start + (current.end - current.start) / 2
        older = Window(current.start, midpoint)
        if await client.probe(username, older):
            current = older
        else:
            current = Window(midpoint, current.end)
    return current


async def fetch_complete_oldest_window(
    client: TwscrapeClient,
    username: str,
    window: Window,
    limit: int,
) -> list[Any]:
    """Split saturated windows old-first until a non-saturated HIT is obtained."""
    current = window
    while True:
        # A limit=1 probe may have stopped after its first GraphQL page.  Do not
        # query that exact interval again with a larger limit: descend directly
        # into children, preserving the one-physical-query-per-window rule.
        was_probed = (epoch(current.start), epoch(current.end)) in client.probed_windows
        if was_probed:
            midpoint = current.start + (current.end - current.start) / 2
            older = Window(current.start, midpoint)
            older_rows = await client.search(username, older, limit)
            if client.debug:
                state = "SATURATED" if len(older_rows) >= limit else ("HIT" if older_rows else "MISS")
                print(f"FETCH {label(older)} count={len(older_rows)} limit={limit} ... {state}")
            if older_rows:
                if len(older_rows) < limit:
                    return older_rows
                current = older
            else:
                current = Window(midpoint, current.end)
            continue

        rows = await client.search(username, current, limit)
        if client.debug:
            state = "SATURATED" if len(rows) >= limit else ("HIT" if rows else "MISS")
            print(f"FETCH {label(current)} count={len(rows)} limit={limit} ... {state}")
        if rows and len(rows) < limit:
            return rows
        if current.end - current.start <= timedelta(seconds=1):
            if rows:
                # Multiple tweets cannot have a total ordering finer than X's timestamp.
                return rows
            raise SearchFailure("The narrowed one-second interval unexpectedly became empty")

        midpoint = current.start + (current.end - current.start) / 2
        older = Window(current.start, midpoint)
        older_rows = await client.search(username, older, limit)
        if client.debug:
            state = "SATURATED" if len(older_rows) >= limit else ("HIT" if older_rows else "MISS")
            print(f"FETCH {label(older)} count={len(older_rows)} limit={limit} ... {state}")
        if older_rows:
            if len(older_rows) < limit:
                return older_rows
            current = older
        else:
            current = Window(midpoint, current.end)


async def run(args: argparse.Namespace) -> int:
    started = time.perf_counter()
    username = re.sub(r"^@", "", args.username.strip())
    if not re.fullmatch(r"[A-Za-z0-9_]{1,15}", username):
        raise SearchFailure(f"Invalid X username: {args.username!r}")

    client = TwscrapeClient(args.db.expanduser(), args.retries, args.retry_base, not args.quiet)
    profile_attempts_before = client.attempts
    try:
        profile = await client.api.user_by_login(username)
        client.attempts += 1
    except Exception as exc:
        client.attempts += 1
        raise SearchFailure(f"Could not retrieve @{username} profile: {exc}") from exc
    if profile is None:
        raise SearchFailure(f"Account @{username} was not found")
    if profile.protected:
        raise SearchFailure(f"Account @{username} is private")
    created = utc(profile.created)
    if not args.quiet:
        version = importlib.metadata.version("twscrape")
        print(f"twscrape {version}; Python API; db={args.db.expanduser()}")
        print(f"PROFILE @{username} created={created.isoformat()} requests={client.attempts - profile_attempts_before}")

    day = await find_first_day(client, username, created)
    if not args.quiet:
        print(f"FIRST DAY {day.start:%Y-%m-%d}")
    narrowed = await narrow_oldest_window(
        client, username, day, timedelta(minutes=args.initial_window_minutes)
    )
    rows = await fetch_complete_oldest_window(client, username, narrowed, args.limit)
    earliest = min(rows, key=lambda tweet: (utc(tweet.date), int(tweet.id)))
    elapsed = time.perf_counter() - started

    print("\nEarliest tweet found")
    print(f"Username: @{username}")
    print(f"ID: {earliest.id}")
    print(f"Date: {utc(earliest.date).isoformat().replace('+00:00', 'Z')}")
    print(f"Text: {earliest.rawContent}")
    print(f"URL: {earliest.url or f'https://x.com/{username}/status/{earliest.id}'}")
    print(f"Probe count: {client.searches}")
    print(f"Requests/attempts performed: {client.attempts}")
    print(f"Elapsed: {elapsed:.2f}s")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Find the earliest post obtainable for a public X account using time-window probes."
    )
    parser.add_argument("username", help="X username, with or without @")
    parser.add_argument(
        "--db",
        type=Path,
        default=Path("~/accounts.db"),
        help="twscrape account database (default: ~/accounts.db)",
    )
    parser.add_argument("--limit", type=int, default=100, help="Final fetch saturation limit")
    parser.add_argument(
        "--initial-window-minutes",
        type=int,
        default=60,
        help="Narrow by probes to this size before fetching (default: 60)",
    )
    parser.add_argument("--retries", type=int, default=3, help="Retries after errors/rate limits")
    parser.add_argument("--retry-base", type=float, default=1.0, help="Retry backoff base seconds")
    parser.add_argument("--quiet", action="store_true", help="Hide probe debug output")
    args = parser.parse_args()
    if args.limit < 2:
        parser.error("--limit must be at least 2")
    if args.initial_window_minutes < 1:
        parser.error("--initial-window-minutes must be at least 1")
    return args


def main() -> int:
    try:
        return asyncio.run(run(parse_args()))
    except KeyboardInterrupt:
        print("Interrupted", file=sys.stderr)
        return 130
    except SearchFailure as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
