#!/usr/bin/env python3
"""Measure whether twscrape can collect the oldest N obtainable X posts.

This is an independent experiment.  It does not import or modify STELA, use its
database, or make assumptions about STELA's unlock/job model.

The prototype intentionally targets twscrape 0.20.x internals so it can observe
why SearchTimeline pagination stopped.  Public ``API.search()`` only exposes an
iterator and cannot distinguish natural cursor exhaustion from a cursor stall,
an empty-page guard, or an intentional page ceiling.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.metadata
import json
import math
import random
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

UTC = timezone.utc


class PrototypeFailure(RuntimeError):
    """A failure that should stop the measurement without claiming completeness."""


@dataclass(frozen=True, order=True)
class Window:
    """A UTC, half-open SearchTimeline interval: [start, end)."""

    start: int
    end: int

    def __post_init__(self) -> None:
        if self.start >= self.end:
            raise ValueError(f"invalid window: [{self.start}, {self.end})")

    @property
    def width_seconds(self) -> int:
        return self.end - self.start

    @property
    def start_dt(self) -> datetime:
        return datetime.fromtimestamp(self.start, UTC)

    @property
    def end_dt(self) -> datetime:
        return datetime.fromtimestamp(self.end, UTC)

    def label(self) -> str:
        return f"{iso_epoch(self.start)} .. {iso_epoch(self.end)}"


@dataclass
class WindowResult:
    purpose: str
    window: Window
    status: str
    termination_reason: str
    posts: list[Any] = field(default_factory=list)
    requests: int = 0
    pages: int = 0
    raw_entries: int = 0
    parsed_posts: int = 0
    filtered_posts: int = 0
    duplicate_posts: int = 0
    elapsed_seconds: float = 0.0
    cursor_seen: bool = False
    cursor_remaining: bool = False
    repeated_page: bool = False
    review_reached: bool = False
    empty_pages: int = 0
    rate_limit_remaining: int | None = None
    rate_limit_reset: int | None = None
    error: str | None = None
    attempt: int = 1

    @property
    def unique_posts(self) -> int:
        return len({str(post.id) for post in self.posts})

    def event_json(self) -> dict[str, Any]:
        return {
            "phase": self.purpose,
            "start": iso_epoch(self.window.start),
            "end": iso_epoch(self.window.end),
            "status": self.status,
            "termination_reason": self.termination_reason,
            "attempt": self.attempt,
            "requests": self.requests,
            "pages": self.pages,
            "raw_entry_count": self.raw_entries,
            "parsed_post_count": self.parsed_posts,
            "unique_post_count": self.unique_posts,
            "filtered_post_count": self.filtered_posts,
            "duplicate_post_count": self.duplicate_posts,
            "cursor_seen": self.cursor_seen,
            "cursor_remaining": self.cursor_remaining,
            "repeated_page": self.repeated_page,
            "review_reached": self.review_reached,
            "empty_pages": self.empty_pages,
            "rate_limit_remaining": self.rate_limit_remaining,
            "rate_limit_reset": self.rate_limit_reset,
            "elapsed_seconds": round(self.elapsed_seconds, 3),
            "error": self.error,
            "post_ids": [str(post.id) for post in self.posts],
        }


@dataclass
class Candidate:
    post: Any
    sightings: int = 1
    seen_in_complete_result: bool = False
    sources: set[str] = field(default_factory=set)


def epoch(dt: datetime) -> int:
    return math.floor(dt.astimezone(UTC).timestamp())


def iso_epoch(value: int) -> str:
    return datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")


def post_epoch(post: Any) -> int:
    return epoch(post.date)


def query_for(username: str, window: Window) -> str:
    return (
        f"from:{username} since_time:{window.start} "
        f"until_time:{window.end}"
    )


def year_start(year: int) -> int:
    return epoch(datetime(year, 1, 1, tzinfo=UTC))


def next_month_start(dt: datetime) -> datetime:
    if dt.month == 12:
        return datetime(dt.year + 1, 1, 1, tzinfo=UTC)
    return datetime(dt.year, dt.month + 1, 1, tzinfo=UTC)


def normalize_username(value: str) -> str:
    username = re.sub(r"^@", "", value.strip())
    if not re.fullmatch(r"[A-Za-z0-9_]{1,15}", username):
        raise PrototypeFailure(f"invalid X username: {value!r}")
    return username


def safe_header_int(headers: Any, name: str) -> int | None:
    try:
        value = headers.get(name)
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


class InstrumentedSearchTimeline:
    """A thin, version-pinned SearchTimeline page adapter with stop reasons."""

    def __init__(self, args: argparse.Namespace, username: str) -> None:
        try:
            from twscrape import API
        except ImportError as exc:
            raise PrototypeFailure(
                "twscrape is not importable; run with the repository's twscrape venv"
            ) from exc

        self.args = args
        self.username = username
        self.api = API(
            str(args.db.expanduser()),
            debug=args.twscrape_debug,
            raise_when_no_account=True,
            wait_timeout=args.account_wait_timeout,
        )
        self.total_request_calls = 0
        self.profile_request_calls = 0
        self.search_request_calls = 0
        self.events: list[WindowResult] = []
        self.cache: dict[tuple[Any, ...], WindowResult] = {}

    async def profile(self) -> Any:
        self._reserve_request("profile")
        try:
            profile = await self.api.user_by_login(self.username)
        except Exception as exc:
            raise PrototypeFailure(
                f"profile lookup failed: {type(exc).__name__}: {exc}"
            ) from exc
        if profile is None:
            raise PrototypeFailure(
                f"profile lookup for @{self.username} returned no response; "
                "the account may be missing, or twscrape/X aborted the GraphQL request"
            )
        if profile.protected:
            raise PrototypeFailure(f"account @{self.username} is private")
        return profile

    def _reserve_request(self, kind: str) -> None:
        if self.total_request_calls >= self.args.max_requests:
            raise PrototypeFailure(
                f"max request budget reached ({self.args.max_requests})"
            )
        self.total_request_calls += 1
        if kind == "profile":
            self.profile_request_calls += 1
        else:
            self.search_request_calls += 1

    async def fetch(self, purpose: str, window: Window) -> WindowResult:
        key = (
            purpose,
            window.start,
            window.end,
            self.args.probe_limit if purpose.startswith("probe_") else None,
            self.args.page_review,
            self.args.page_split,
            self.args.page_ceiling,
        )
        cached = self.cache.get(key)
        if cached is not None:
            return cached

        combined_posts: dict[str, Any] = {}
        aggregate: WindowResult | None = None
        last: WindowResult | None = None

        for attempt in range(1, self.args.retries + 2):
            result = await self._fetch_once(purpose, window, attempt)
            self.events.append(result)
            last = result
            for post in result.posts:
                combined_posts[str(post.id)] = post

            if aggregate is None:
                aggregate = WindowResult(
                    purpose=purpose,
                    window=window,
                    status=result.status,
                    termination_reason=result.termination_reason,
                )
            aggregate.requests += result.requests
            aggregate.pages += result.pages
            aggregate.raw_entries += result.raw_entries
            aggregate.parsed_posts += result.parsed_posts
            aggregate.filtered_posts += result.filtered_posts
            aggregate.duplicate_posts += result.duplicate_posts
            aggregate.elapsed_seconds += result.elapsed_seconds
            aggregate.cursor_seen = aggregate.cursor_seen or result.cursor_seen
            aggregate.cursor_remaining = result.cursor_remaining
            aggregate.repeated_page = aggregate.repeated_page or result.repeated_page
            aggregate.review_reached = aggregate.review_reached or result.review_reached
            aggregate.empty_pages += result.empty_pages
            aggregate.rate_limit_remaining = result.rate_limit_remaining
            aggregate.rate_limit_reset = result.rate_limit_reset
            aggregate.error = result.error
            aggregate.attempt = attempt

            if result.status != "UNKNOWN":
                break
            if attempt <= self.args.retries:
                delay = self.args.retry_base * (2 ** (attempt - 1))
                delay += random.uniform(0, 0.25)
                self._log(
                    f"RETRY {purpose} {window.label()} "
                    f"attempt={attempt + 1} in={delay:.2f}s reason={result.termination_reason}"
                )
                await asyncio.sleep(delay)

        assert aggregate is not None and last is not None
        aggregate.status = last.status
        aggregate.termination_reason = last.termination_reason
        aggregate.posts = list(combined_posts.values())
        self.cache[key] = aggregate
        return aggregate

    async def _fetch_once(
        self, purpose: str, window: Window, attempt: int
    ) -> WindowResult:
        started = time.perf_counter()
        posts: dict[str, Any] = {}
        pages = 0
        requests = 0
        raw_entries = 0
        parsed_posts = 0
        filtered_posts = 0
        duplicate_posts = 0
        cursor_seen = False
        cursor_remaining = False
        repeated_page = False
        review_reached = False
        empty_pages = 0
        remaining: int | None = None
        reset: int | None = None
        termination = "request_error"
        status = "UNKNOWN"
        error: str | None = None
        cur: str | None = None
        seen: set[tuple[str, ...]] = set()

        try:
            from twscrape.api import GQL_FEATURES, GQL_URL, OP_SearchTimeline
            from twscrape.models import parse_tweets
            from twscrape.queue_client import QueueClient
            from twscrape.utils import encode_params

            queue = "SearchTimeline"
            base_variables = {
                "rawQuery": query_for(self.username, window),
                "count": self.args.graphql_count,
                "product": "Latest",
                "querySource": "typed_query",
            }

            async with asyncio.timeout(self.args.window_timeout):
                async with QueueClient(
                    self.api.pool,
                    queue,
                    self.api.debug,
                    proxy=self.api.proxy,
                ) as client:
                    while True:
                        variables = dict(base_variables)
                        if cur is not None:
                            variables["cursor"] = cur
                        params = {
                            "variables": variables,
                            "features": dict(GQL_FEATURES),
                            "fieldToggles": {
                                "withArticleRichContentState": False
                            },
                        }

                        self._reserve_request("search")
                        requests += 1
                        rep = await client.get(
                            f"{GQL_URL}/{OP_SearchTimeline}",
                            params=encode_params(params),
                        )
                        if rep is None:
                            termination = "request_aborted"
                            status = "UNKNOWN"
                            break

                        pages += 1
                        remaining = safe_header_int(
                            rep.headers, "x-rate-limit-remaining"
                        )
                        reset = safe_header_int(rep.headers, "x-rate-limit-reset")

                        obj = rep.json()
                        entries = self.api._gql_entries(obj)
                        next_cursor = self.api._get_cursor(obj)
                        cursor_seen = cursor_seen or next_cursor is not None
                        cursor_remaining = next_cursor is not None
                        raw_entries += len(entries)

                        if self.api._is_stalled(
                            queue, entries, next_cursor, seen
                        ):
                            repeated_page = True
                            termination = "cursor_stall"
                            status = "UNKNOWN"
                            break

                        page_posts = list(parse_tweets(rep.json(), limit=-1))
                        parsed_posts += len(page_posts)
                        for post in page_posts:
                            author = getattr(getattr(post, "user", None), "username", "")
                            timestamp = post_epoch(post)
                            if author.lower() != self.username.lower():
                                filtered_posts += 1
                                continue
                            if not (window.start <= timestamp < window.end):
                                filtered_posts += 1
                                continue
                            post_id = str(post.id)
                            if post_id in posts:
                                duplicate_posts += 1
                            else:
                                posts[post_id] = post

                        if not entries:
                            if next_cursor is not None:
                                empty_pages += 1
                                if empty_pages >= 3:
                                    termination = "empty_page_limit"
                                    status = "UNKNOWN"
                                    break
                                cur = next_cursor
                                continue
                            termination = "natural_exhaustion"
                            status = "COMPLETE"
                            break

                        empty_pages = 0

                        if next_cursor is None:
                            termination = "natural_exhaustion"
                            status = "COMPLETE"
                            break

                        cur = next_cursor

                        if purpose.startswith("probe_"):
                            if len(posts) >= self.args.probe_limit:
                                termination = "probe_threshold"
                                status = "PARTIAL"
                                break
                            continue

                        if pages >= self.args.page_review:
                            review_reached = True

                        if pages >= self.args.page_ceiling:
                            termination = "page_ceiling"
                            status = "PARTIAL"
                            break

                        if (
                            pages >= self.args.page_split
                            and window.width_seconds > self.args.min_window_seconds
                        ):
                            termination = "page_split"
                            status = "PARTIAL"
                            break

        except TimeoutError:
            termination = "timeout"
            status = "UNKNOWN"
            error = f"window timed out after {self.args.window_timeout}s"
        except PrototypeFailure as exc:
            termination = "request_budget"
            status = "UNKNOWN"
            error = str(exc)
        except Exception as exc:  # twscrape exception types vary by version
            termination = "request_error"
            status = "UNKNOWN"
            error = f"{type(exc).__name__}: {exc}"

        return WindowResult(
            purpose=purpose,
            window=window,
            status=status,
            termination_reason=termination,
            posts=list(posts.values()),
            requests=requests,
            pages=pages,
            raw_entries=raw_entries,
            parsed_posts=parsed_posts,
            filtered_posts=filtered_posts,
            duplicate_posts=duplicate_posts,
            elapsed_seconds=time.perf_counter() - started,
            cursor_seen=cursor_seen,
            cursor_remaining=cursor_remaining,
            repeated_page=repeated_page,
            review_reached=review_reached,
            empty_pages=empty_pages,
            rate_limit_remaining=remaining,
            rate_limit_reset=reset,
            error=error,
            attempt=attempt,
        )

    def _log(self, message: str) -> None:
        if not self.args.quiet:
            print(message, flush=True)


class OldestBlockExperiment:
    def __init__(
        self,
        args: argparse.Namespace,
        username: str,
        client: InstrumentedSearchTimeline,
        lower_bound: int,
        snapshot_end: int,
    ) -> None:
        self.args = args
        self.username = username
        self.client = client
        self.lower_bound = lower_bound
        self.snapshot_end = snapshot_end
        self.candidates: dict[str, Candidate] = {}
        self.complete_intervals: list[Window] = []
        self.split_count = 0
        self.probe_count = 0
        self.collect_window_count = 0
        self.duplicate_sightings = 0

    def add_result(self, result: WindowResult) -> None:
        source = (
            f"{result.purpose}:{result.window.start}:{result.window.end}:"
            f"{result.termination_reason}"
        )
        for post in result.posts:
            post_id = str(post.id)
            existing = self.candidates.get(post_id)
            if existing is None:
                self.candidates[post_id] = Candidate(
                    post=post,
                    seen_in_complete_result=result.status == "COMPLETE",
                    sources={source},
                )
            else:
                existing.sightings += 1
                existing.sources.add(source)
                existing.seen_in_complete_result = (
                    existing.seen_in_complete_result or result.status == "COMPLETE"
                )
                self.duplicate_sightings += 1

        if result.status == "COMPLETE":
            self.complete_intervals.append(result.window)

    def coverage_frontier(self) -> int:
        frontier = self.lower_bound
        for window in sorted(self.complete_intervals):
            if window.end <= frontier:
                continue
            if window.start > frontier:
                break
            frontier = max(frontier, window.end)
        return frontier

    def confirmed_candidates(self) -> list[Candidate]:
        frontier = self.coverage_frontier()
        rows = [
            candidate
            for candidate in self.candidates.values()
            if self.lower_bound <= post_epoch(candidate.post) < frontier
        ]
        return sorted(rows, key=lambda row: (post_epoch(row.post), int(row.post.id)))

    def target_reached(self) -> bool:
        return len(self.confirmed_candidates()) >= self.args.target_count

    async def probe_until_collect(self) -> int | None:
        created_dt = datetime.fromtimestamp(self.lower_bound, UTC)
        last_dt = datetime.fromtimestamp(self.snapshot_end - 1, UTC)

        for year in range(created_dt.year, last_dt.year + 1):
            start = max(self.lower_bound, year_start(year))
            end = min(self.snapshot_end, year_start(year + 1))
            if start >= end:
                continue
            window = Window(start, end)
            result = await self.client.fetch("probe_year", window)
            self.probe_count += 1
            self.add_result(result)
            self._log_result("PROBE YEAR", result)

            if result.status == "COMPLETE":
                if self.target_reached():
                    return None
                continue
            if result.status == "UNKNOWN":
                self._raise_unknown(result)

            month_cursor = datetime(year, 1, 1, tzinfo=UTC)
            while month_cursor.year == year:
                month_end = next_month_start(month_cursor)
                month_start_epoch = max(start, epoch(month_cursor))
                month_end_epoch = min(end, epoch(month_end))
                if month_start_epoch >= month_end_epoch:
                    month_cursor = month_end
                    continue
                month_window = Window(month_start_epoch, month_end_epoch)
                result = await self.client.fetch("probe_month", month_window)
                self.probe_count += 1
                self.add_result(result)
                self._log_result("PROBE MONTH", result)

                if result.status == "COMPLETE":
                    if self.target_reached():
                        return None
                    month_cursor = month_end
                    if month_window.end >= end:
                        break
                    continue
                if result.status == "UNKNOWN":
                    self._raise_unknown(result)
                return month_window.start

        return None

    async def collect_from(self, collect_start: int) -> None:
        cursor = collect_start
        span_index = 0
        spans = self.args.window_days

        while cursor < self.snapshot_end and not self.target_reached():
            span_days = spans[span_index]
            end = min(
                self.snapshot_end,
                cursor + span_days * 24 * 60 * 60,
            )
            window = Window(cursor, end)
            fully_resolved = await self.resolve_collect_window(window, depth=0)
            if self.target_reached():
                return
            if not fully_resolved:
                raise PrototypeFailure(
                    f"window was not fully resolved: {window.label()}"
                )

            unique_in_window = sum(
                1
                for candidate in self.candidates.values()
                if window.start <= post_epoch(candidate.post) < window.end
            )
            if unique_in_window <= self.args.sparse_threshold:
                span_index = min(span_index + 1, len(spans) - 1)
            cursor = window.end

    async def resolve_collect_window(self, window: Window, depth: int) -> bool:
        result = await self.client.fetch("collect", window)
        self.collect_window_count += 1
        self.add_result(result)
        self._log_result(f"COLLECT depth={depth}", result)

        if result.status == "COMPLETE":
            return True
        if result.status == "UNKNOWN":
            self._raise_unknown(result)

        if window.width_seconds <= self.args.min_window_seconds:
            raise PrototypeFailure(
                "partial result remained at minimum window size: "
                f"{window.label()} reason={result.termination_reason}"
            )

        midpoint = window.start + window.width_seconds // 2
        if midpoint <= window.start or midpoint >= window.end:
            raise PrototypeFailure(f"could not split window: {window.label()}")

        older = Window(window.start, midpoint)
        newer = Window(midpoint, window.end)
        self.split_count += 1
        self.client._log(
            f"SPLIT {window.label()} -> older={older.label()} newer={newer.label()}"
        )

        older_complete = await self.resolve_collect_window(older, depth + 1)
        if self.target_reached():
            return False
        newer_complete = await self.resolve_collect_window(newer, depth + 1)
        return older_complete and newer_complete

    def _raise_unknown(self, result: WindowResult) -> None:
        detail = f" error={result.error}" if result.error else ""
        raise PrototypeFailure(
            f"UNKNOWN window {result.window.label()} "
            f"reason={result.termination_reason}{detail}"
        )

    def _log_result(self, prefix: str, result: WindowResult) -> None:
        self.client._log(
            f"{prefix} {result.window.label()} status={result.status} "
            f"termination={result.termination_reason} requests={result.requests} "
            f"pages={result.pages} unique={result.unique_posts} "
            f"elapsed={result.elapsed_seconds:.2f}s"
        )


def post_json(candidate: Candidate) -> dict[str, Any]:
    post = candidate.post
    mentions = []
    for user in getattr(post, "mentionedUsers", None) or []:
        username = getattr(user, "username", None)
        if username:
            mentions.append(username)

    media = []
    post_media = getattr(post, "media", None)
    for photo in getattr(post_media, "photos", None) or []:
        url = getattr(photo, "url", None)
        if url:
            media.append({"type": "photo", "url": url})
    for video in getattr(post_media, "videos", None) or []:
        thumbnail = getattr(video, "thumbnailUrl", None)
        variants = []
        for variant in getattr(video, "variants", None) or []:
            url = getattr(variant, "url", None)
            if url:
                variants.append(
                    {
                        "url": url,
                        "content_type": getattr(variant, "contentType", None),
                        "bitrate": getattr(variant, "bitrate", None),
                    }
                )
        media.append(
            {
                "type": "video",
                "preview_image_url": thumbnail,
                "variants": variants,
            }
        )

    return {
        "post_id": str(post.id),
        "created_at": post.date.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "id": str(post.id),
        "date": post.date.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "text": post.rawContent,
        "url": post.url,
        "author_username": getattr(post.user, "username", None),
        "language": post.lang,
        "reply_count": post.replyCount,
        "retweet_count": post.retweetCount,
        "like_count": post.likeCount,
        "quote_count": post.quoteCount,
        "view_count": post.viewCount,
        "conversation_id": str(post.conversationId),
        "in_reply_to_tweet_id": (
            str(post.inReplyToTweetId) if post.inReplyToTweetId is not None else None
        ),
        "mentions": mentions,
        "media": media,
        "provider": "twscrape",
        "candidate_sightings": candidate.sightings,
        "seen_in_complete_result": candidate.seen_in_complete_result,
    }


def profile_json(profile: Any) -> dict[str, Any]:
    return {
        "account_id": (
            str(profile.id) if getattr(profile, "id", None) is not None else None
        ),
        "username": getattr(profile, "username", None),
        "display_name": getattr(profile, "displayname", None),
        "avatar_url": getattr(profile, "profileImageUrl", None),
        "cover_url": getattr(profile, "profileBannerUrl", None),
        "description": getattr(profile, "rawDescription", None),
        "created_at": (
            profile.created.astimezone(UTC).isoformat().replace("+00:00", "Z")
            if getattr(profile, "created", None) is not None
            else None
        ),
        "protected": bool(getattr(profile, "protected", False)),
        "followers_count": getattr(profile, "followersCount", 0),
        "following_count": getattr(profile, "friendsCount", 0),
        "statuses_count": getattr(profile, "statusesCount", 0),
    }


def config_json(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "target_count": args.target_count,
        "probe_limit": args.probe_limit,
        "graphql_count": args.graphql_count,
        "window_days": args.window_days,
        "sparse_threshold": args.sparse_threshold,
        "page_review": args.page_review,
        "page_split": args.page_split,
        "page_ceiling": args.page_ceiling,
        "min_window_seconds": args.min_window_seconds,
        "max_requests": args.max_requests,
        "window_timeout_seconds": args.window_timeout,
        "retries": args.retries,
    }


def metrics_json(
    experiment: OldestBlockExperiment,
    client: InstrumentedSearchTimeline,
    elapsed: float,
) -> dict[str, Any]:
    confirmed = experiment.confirmed_candidates()
    reused = sum(1 for row in confirmed if not row.seen_in_complete_result)
    return {
        "total_request_calls": client.total_request_calls,
        "profile_request_calls": client.profile_request_calls,
        "search_request_calls": client.search_request_calls,
        "total_pages": sum(event.pages for event in client.events),
        "probe_count": experiment.probe_count,
        "collect_window_count": experiment.collect_window_count,
        "split_count": experiment.split_count,
        "candidate_unique_count": len(experiment.candidates),
        "confirmed_prefix_unique_count": len(confirmed),
        "duplicate_sightings": experiment.duplicate_sightings,
        "reused_candidate_count": reused,
        "partial_window_attempts": sum(
            event.status == "PARTIAL" for event in client.events
        ),
        "unknown_window_attempts": sum(
            event.status == "UNKNOWN" for event in client.events
        ),
        "elapsed_seconds": round(elapsed, 3),
        "request_count_note": (
            "Counts logical QueueClient.get calls; transport/account rotation retries "
            "inside twscrape are not separately exposed."
        ),
    }


def parse_window_days(value: str) -> list[int]:
    try:
        rows = [int(item.strip()) for item in value.split(",") if item.strip()]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("window days must be comma-separated integers") from exc
    if not rows or any(item < 1 for item in rows):
        raise argparse.ArgumentTypeError("window days must contain positive integers")
    if rows != sorted(rows):
        raise argparse.ArgumentTypeError("window days must be ascending")
    return rows


def default_output(username: str) -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return Path("results/twscrape-1000") / f"{username}-{stamp}.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Measure oldest-side unique post collection with year/month probes, "
            "adaptive time windows, and instrumented twscrape cursor pagination."
        )
    )
    parser.add_argument("username", help="X username, with or without @")
    parser.add_argument(
        "--db",
        type=Path,
        default=Path("~/accounts.db"),
        help="twscrape account database (default: ~/accounts.db)",
    )
    parser.add_argument("--output", type=Path, help="JSON output path")
    parser.add_argument("--target-count", type=int, default=1000)
    parser.add_argument("--probe-limit", type=int, default=10)
    parser.add_argument("--graphql-count", type=int, default=20)
    parser.add_argument("--window-days", type=parse_window_days, default=[7, 30, 120])
    parser.add_argument("--sparse-threshold", type=int, default=100)
    parser.add_argument("--page-review", type=int, default=25)
    parser.add_argument("--page-split", type=int, default=50)
    parser.add_argument("--page-ceiling", type=int, default=75)
    parser.add_argument("--min-window-seconds", type=int, default=1)
    parser.add_argument("--max-requests", type=int, default=2000)
    parser.add_argument("--window-timeout", type=float, default=300.0)
    parser.add_argument("--account-wait-timeout", type=float, default=30.0)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--retry-base", type=float, default=1.0)
    parser.add_argument("--snapshot-lag-seconds", type=int, default=60)
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--twscrape-debug", action="store_true")
    args = parser.parse_args()

    if args.target_count < 1:
        parser.error("--target-count must be at least 1")
    if args.probe_limit < 1:
        parser.error("--probe-limit must be at least 1")
    if args.graphql_count < 1:
        parser.error("--graphql-count must be at least 1")
    if args.sparse_threshold < 0:
        parser.error("--sparse-threshold must be non-negative")
    if not (1 <= args.page_review <= args.page_split <= args.page_ceiling):
        parser.error("page thresholds must satisfy review <= split <= ceiling")
    if args.min_window_seconds < 1:
        parser.error("--min-window-seconds must be at least 1")
    if args.max_requests < 1:
        parser.error("--max-requests must be at least 1")
    if args.retries < 0:
        parser.error("--retries must be non-negative")
    if args.snapshot_lag_seconds < 0:
        parser.error("--snapshot-lag-seconds must be non-negative")
    return args


async def run(args: argparse.Namespace) -> int:
    started = time.perf_counter()
    username = normalize_username(args.username)
    args.db = args.db.expanduser()
    args.output = (args.output or default_output(username)).expanduser()
    version = importlib.metadata.version("twscrape")
    if not version.startswith("0.20."):
        raise PrototypeFailure(
            f"this instrumented prototype expects twscrape 0.20.x, found {version}"
        )

    client = InstrumentedSearchTimeline(args, username)
    profile = await client.profile()
    lower_bound = epoch(profile.created)
    snapshot_end = epoch(datetime.now(UTC) - timedelta(seconds=args.snapshot_lag_seconds))
    if lower_bound >= snapshot_end:
        raise PrototypeFailure("account creation is not before the snapshot end")

    print(
        f"twscrape {version}; @{username}; created={iso_epoch(lower_bound)}; "
        f"snapshot_end={iso_epoch(snapshot_end)}",
        flush=True,
    )
    experiment = OldestBlockExperiment(
        args,
        username,
        client,
        lower_bound,
        snapshot_end,
    )

    collect_start = await experiment.probe_until_collect()
    if collect_start is not None and not experiment.target_reached():
        client._log(f"COLLECT START {iso_epoch(collect_start)}")
        await experiment.collect_from(collect_start)

    elapsed = time.perf_counter() - started
    confirmed = experiment.confirmed_candidates()
    selected = confirmed[: args.target_count]
    coverage_frontier = experiment.coverage_frontier()

    if len(selected) >= args.target_count:
        result_status = "SUCCESS"
    elif coverage_frontier >= snapshot_end:
        result_status = "ACCOUNT_HAS_LESS_THAN_TARGET"
    else:
        result_status = "INCOMPLETE"

    payload = {
        "schema_version": 1,
        "provider": "twscrape",
        "username": username,
        "twscrape_version": version,
        "profile": profile_json(profile),
        "created_at": iso_epoch(lower_bound),
        "snapshot_end": iso_epoch(snapshot_end),
        "config": config_json(args),
        "result": {
            "status": result_status,
            "unique_post_count": len(selected),
            "confirmed_prefix_unique_count": len(confirmed),
            "coverage_frontier": iso_epoch(coverage_frontier),
            "oldest_timestamp": (
                selected[0].post.date.astimezone(UTC).isoformat().replace("+00:00", "Z")
                if selected
                else None
            ),
            "newest_timestamp": (
                selected[-1].post.date.astimezone(UTC).isoformat().replace("+00:00", "Z")
                if selected
                else None
            ),
        },
        "metrics": metrics_json(experiment, client, elapsed),
        "windows": [event.event_json() for event in client.events],
        "posts": [post_json(candidate) for candidate in selected],
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("\nOldest-side collection finished")
    print(f"Status: {result_status}")
    print(f"Username: @{username}")
    print(f"Unique post count: {len(selected)}")
    print(f"Candidate unique count: {len(experiment.candidates)}")
    print(f"Total request calls: {client.total_request_calls}")
    print(f"Search request calls: {client.search_request_calls}")
    print(f"Total pages: {sum(event.pages for event in client.events)}")
    print(f"Split count: {experiment.split_count}")
    print(
        "Oldest timestamp: "
        + (payload["result"]["oldest_timestamp"] or "n/a")
    )
    print(
        "Newest timestamp: "
        + (payload["result"]["newest_timestamp"] or "n/a")
    )
    print(f"Elapsed: {elapsed:.2f}s")
    print(f"JSON: {args.output.resolve()}")
    return 0 if result_status in {"SUCCESS", "ACCOUNT_HAS_LESS_THAN_TARGET"} else 2


def main() -> int:
    try:
        return asyncio.run(run(parse_args()))
    except KeyboardInterrupt:
        print("Interrupted", file=sys.stderr)
        return 130
    except PrototypeFailure as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
