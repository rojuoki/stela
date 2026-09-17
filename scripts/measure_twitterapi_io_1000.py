#!/usr/bin/env python3
"""Measure oldest-side collection through TwitterAPI.io.

This is an independent experiment. It does not import STELA, write to STELA's
database, or alter the existing twscrape prototype.

The prototype uses cursor pagination as the normal collection path, but keeps
time windows as an independent safety boundary.  Probes read one page only.
Collection windows follow cursors until observed exhaustion or a configurable
page/post budget; budgeted or anomalous windows are split into half-open UTC
intervals and the older half is resolved first. Resolved normal windows adapt
 through page-density feedback targeting 12 pages. Empty, fully resolved
 windows re-enter the year/month exploration path, while capped windows are
 discarded and resolved through contiguous oldest-first children. Observed
 exhaustion is an operational coverage signal, not a claim of provider-level
 completeness.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

UTC = timezone.utc
API_BASE = "https://api.twitterapi.io"
TWEET_RESULT_RATE_USD = 0.00015
PROFILE_RESULT_RATE_USD = 0.00018
COLLECT_DENSE_POST_THRESHOLD = 100
SPLIT_RECOVERY_MAX_DAYS = 7
SECONDS_PER_DAY = 24 * 60 * 60


class PrototypeFailure(RuntimeError):
    """Stop without claiming complete coverage."""


class SharedRateLimiter:
    """Coordinate request starts across account workers on this host.

    The measurement runner is intentionally subprocess-friendly. A small
    file-backed limiter lets independently running account workers share one
    provider cadence without moving the cursor state out of the account
    worker. The timestamp uses the host monotonic clock and is only advisory
    across process crashes; a stale value can at most add one interval.
    """

    def __init__(self, state_path: Path, interval: float) -> None:
        self.state_path = state_path
        self.interval = interval

    def wait(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with self.state_path.open("a+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                handle.seek(0)
                raw = handle.read().strip()
                try:
                    last_start = float(raw)
                except ValueError:
                    last_start = 0.0
                remaining = self.interval - (time.monotonic() - last_start)
                if remaining > 0:
                    time.sleep(remaining)
                handle.seek(0)
                handle.truncate()
                handle.write(str(time.monotonic()))
                handle.flush()
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@dataclass(frozen=True, order=True)
class Window:
    start: int
    end: int

    def __post_init__(self) -> None:
        if self.start >= self.end:
            raise ValueError(f"invalid window [{self.start}, {self.end})")

    @property
    def width_seconds(self) -> int:
        return self.end - self.start

    def label(self) -> str:
        return f"{iso_epoch(self.start)} .. {iso_epoch(self.end)}"


@dataclass(frozen=True)
class NormalizedPost:
    post_id: str
    account_id: str | None
    author_username: str
    created_at: int
    text: str
    url: str
    language: str | None
    reply_count: int
    retweet_count: int
    like_count: int
    quote_count: int
    view_count: int
    conversation_id: str | None
    in_reply_to_post_id: str | None
    in_reply_to_user_id: str | None
    in_reply_to_username: str | None
    mentions: tuple[str, ...]
    media: tuple[dict[str, Any], ...]
    provider: str = "twitterapi_io"


@dataclass
class WindowResult:
    purpose: str
    window: Window
    status: str
    termination_reason: str
    posts: list[NormalizedPost] = field(default_factory=list)
    requests: int = 0
    pages: int = 0
    raw_post_count: int = 0
    first_page_raw_post_count: int = 0
    filtered_post_count: int = 0
    duplicate_post_count: int = 0
    elapsed_seconds: float = 0.0
    has_next_page: bool | None = None
    next_cursor_present: bool = False
    cursor_pages: int = 0
    cursor_new_posts: int = 0
    cursor_repeated: bool = False
    cursor_remaining: bool = False
    review_reached: bool = False
    no_progress_pages: int = 0
    oldest_observed_timestamp: int | None = None
    newest_observed_timestamp: int | None = None
    cursor_progress_seconds: int = 0
    timestamp_order_anomaly: bool = False
    resolution_basis: str | None = None
    http_status: int | None = None
    error: str | None = None
    attempt: int = 1

    @property
    def unique_posts(self) -> int:
        return len({post.post_id for post in self.posts})

    def event_json(self) -> dict[str, Any]:
        return {
            "phase": self.purpose,
            "start": iso_epoch(self.window.start),
            "end": iso_epoch(self.window.end),
            "width_seconds": self.window.width_seconds,
            "status": self.status,
            "termination_reason": self.termination_reason,
            "resolution_basis": self.resolution_basis,
            "attempt": self.attempt,
            "requests": self.requests,
            "pages": self.pages,
            "raw_post_count": self.raw_post_count,
            "first_page_raw_post_count": self.first_page_raw_post_count,
            "unique_post_count": self.unique_posts,
            "filtered_post_count": self.filtered_post_count,
            "duplicate_post_count": self.duplicate_post_count,
            "has_next_page": self.has_next_page,
            "next_cursor_present": self.next_cursor_present,
            "cursor_pages": self.cursor_pages,
            "cursor_new_posts": self.cursor_new_posts,
            "cursor_repeated": self.cursor_repeated,
            "cursor_remaining": self.cursor_remaining,
            "review_reached": self.review_reached,
            "no_progress_pages": self.no_progress_pages,
            "oldest_observed_timestamp": (
                iso_epoch(self.oldest_observed_timestamp)
                if self.oldest_observed_timestamp is not None
                else None
            ),
            "newest_observed_timestamp": (
                iso_epoch(self.newest_observed_timestamp)
                if self.newest_observed_timestamp is not None
                else None
            ),
            "cursor_progress_seconds": self.cursor_progress_seconds,
            "timestamp_order_anomaly": self.timestamp_order_anomaly,
            "elapsed_seconds": round(self.elapsed_seconds, 3),
            "http_status": self.http_status,
            "error": self.error,
            "post_ids": [post.post_id for post in self.posts],
        }


@dataclass
class Candidate:
    post: NormalizedPost
    sightings: int = 1
    seen_in_resolved_window: bool = False
    sources: set[str] = field(default_factory=set)


def normalized_post_from_json(row: dict[str, Any]) -> NormalizedPost:
    """Restore a normalized post stored in a checkpoint or result JSON."""
    created_at = row.get("created_at")
    if not isinstance(created_at, str):
        raise PrototypeFailure("checkpoint post has no created_at")
    mentions = row.get("mentions")
    media = row.get("media")
    return NormalizedPost(
        post_id=str(row.get("post_id") or ""),
        account_id=(str(row["account_id"]) if row.get("account_id") is not None else None),
        author_username=str(row.get("author_username") or ""),
        created_at=epoch(parse_datetime(created_at)),
        text=str(row.get("text") or ""),
        url=str(row.get("url") or ""),
        language=(str(row["language"]) if row.get("language") is not None else None),
        reply_count=integer(row.get("reply_count")),
        retweet_count=integer(row.get("retweet_count")),
        like_count=integer(row.get("like_count")),
        quote_count=integer(row.get("quote_count")),
        view_count=integer(row.get("view_count")),
        conversation_id=(
            str(row["conversation_id"])
            if row.get("conversation_id") is not None
            else None
        ),
        in_reply_to_post_id=(
            str(row["in_reply_to_post_id"])
            if row.get("in_reply_to_post_id") is not None
            else None
        ),
        in_reply_to_user_id=(
            str(row["in_reply_to_user_id"])
            if row.get("in_reply_to_user_id") is not None
            else None
        ),
        in_reply_to_username=(
            str(row["in_reply_to_username"])
            if row.get("in_reply_to_username") is not None
            else None
        ),
        mentions=tuple(str(value) for value in mentions if value)
        if isinstance(mentions, list)
        else (),
        media=tuple(value for value in media if isinstance(value, dict))
        if isinstance(media, list)
        else (),
        provider=str(row.get("provider") or "twitterapi_io"),
    )


def epoch(value: datetime) -> int:
    return math.floor(value.astimezone(UTC).timestamp())


def iso_epoch(value: int) -> str:
    return datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")


def normalize_username(value: str) -> str:
    username = re.sub(r"^@", "", value.strip())
    if not re.fullmatch(r"[A-Za-z0-9_]{1,15}", username):
        raise PrototypeFailure(f"invalid X username: {value!r}")
    return username


def parse_datetime(value: str) -> datetime:
    raw = value.strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(raw)
        except (TypeError, ValueError) as exc:
            raise PrototypeFailure(f"unsupported timestamp: {value!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def parse_cli_datetime(value: str) -> int:
    try:
        return epoch(parse_datetime(value))
    except PrototypeFailure as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def next_month_start(value: datetime) -> datetime:
    if value.month == 12:
        return datetime(value.year + 1, 1, 1, tzinfo=UTC)
    return datetime(value.year, value.month + 1, 1, tzinfo=UTC)


def year_start(year: int) -> int:
    return epoch(datetime(year, 1, 1, tzinfo=UTC))


def load_env_key(path: Path) -> str:
    values: dict[str, str] = {}
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("\"'")

    import os

    api_key = os.environ.get("TWITTERAPI_IO_API_KEY") or values.get(
        "TWITTERAPI_IO_API_KEY"
    )
    if not api_key:
        raise PrototypeFailure(
            f"TWITTERAPI_IO_API_KEY is missing from the environment or {path}"
        )
    return api_key


def integer(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def normalize_media(tweet: dict[str, Any]) -> tuple[dict[str, Any], ...]:
    containers = [
        tweet.get("extendedEntities"),
        tweet.get("extended_entities"),
        tweet.get("entities"),
    ]
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for container in containers:
        if not isinstance(container, dict):
            continue
        media = container.get("media")
        if not isinstance(media, list):
            continue
        for item in media:
            if not isinstance(item, dict):
                continue
            media_url = str(
                item.get("media_url_https")
                or item.get("mediaUrlHttps")
                or item.get("url")
                or ""
            )
            identity = str(item.get("id_str") or item.get("id") or media_url)
            if not identity or identity in seen:
                continue
            seen.add(identity)
            rows.append(
                {
                    "id": str(item.get("id_str") or item.get("id") or "") or None,
                    "type": item.get("type"),
                    "url": media_url or None,
                    "expanded_url": item.get("expanded_url")
                    or item.get("expandedUrl"),
                    "video_info": item.get("video_info") or item.get("videoInfo"),
                }
            )
    return tuple(rows)


def normalize_post(tweet: dict[str, Any]) -> NormalizedPost:
    author = tweet.get("author") if isinstance(tweet.get("author"), dict) else {}
    entities = tweet.get("entities") if isinstance(tweet.get("entities"), dict) else {}
    raw_mentions = entities.get("user_mentions") or entities.get("userMentions") or []
    mentions = tuple(
        str(row.get("screen_name") or row.get("screenName") or "")
        for row in raw_mentions
        if isinstance(row, dict)
        and (row.get("screen_name") or row.get("screenName"))
    )
    post_id = str(tweet.get("id") or "")
    if not post_id:
        raise PrototypeFailure("TwitterAPI.io returned a tweet without id")
    created_at = tweet.get("createdAt") or tweet.get("created_at")
    if not isinstance(created_at, str):
        raise PrototypeFailure(f"tweet {post_id} has no createdAt")
    username = str(author.get("userName") or author.get("username") or "")
    return NormalizedPost(
        post_id=post_id,
        account_id=(str(author.get("id")) if author.get("id") is not None else None),
        author_username=username,
        created_at=epoch(parse_datetime(created_at)),
        text=str(tweet.get("text") or ""),
        url=str(tweet.get("url") or f"https://x.com/{username}/status/{post_id}"),
        language=tweet.get("lang"),
        reply_count=integer(tweet.get("replyCount")),
        retweet_count=integer(tweet.get("retweetCount")),
        like_count=integer(tweet.get("likeCount")),
        quote_count=integer(tweet.get("quoteCount")),
        view_count=integer(tweet.get("viewCount")),
        conversation_id=(
            str(tweet.get("conversationId"))
            if tweet.get("conversationId") is not None
            else None
        ),
        in_reply_to_post_id=(
            str(tweet.get("inReplyToId"))
            if tweet.get("inReplyToId") is not None
            else None
        ),
        in_reply_to_user_id=(
            str(tweet.get("inReplyToUserId"))
            if tweet.get("inReplyToUserId") is not None
            else None
        ),
        in_reply_to_username=tweet.get("inReplyToUsername"),
        mentions=mentions,
        media=normalize_media(tweet),
    )


class TwitterApiIoClient:
    def __init__(self, args: argparse.Namespace, username: str) -> None:
        self.args = args
        self.username = username
        self.api_key = load_env_key(args.env_file)
        self.request_count = 0
        self.profile_request_count = 0
        self.search_request_count = 0
        self.raw_posts_returned = 0
        self.events: list[WindowResult] = []
        self.cache: dict[tuple[Any, ...], WindowResult] = {}
        self.last_request_finished = 0.0
        shared_path = getattr(args, "shared_rate_limit_file", None)
        shared_interval = getattr(args, "shared_request_interval", None)
        self.shared_rate_limiter = (
            SharedRateLimiter(shared_path, shared_interval)
            if shared_path is not None and shared_interval is not None
            else None
        )

    def estimated_cost_usd(self) -> float:
        """Estimate provider spend using the public per-result rates.

        Search calls have a minimum one-result charge, so empty calls are
        counted as one.  This is a guardrail, not a provider billing receipt.
        """
        billed_search_results = max(self.raw_posts_returned, self.search_request_count)
        return (
            billed_search_results * TWEET_RESULT_RATE_USD
            + self.profile_request_count * PROFILE_RESULT_RATE_USD
        )

    def _wait_for_interval(self) -> None:
        remaining = self.args.request_interval - (
            time.monotonic() - self.last_request_finished
        )
        if remaining > 0:
            time.sleep(remaining)
        if self.shared_rate_limiter is not None:
            self.shared_rate_limiter.wait()

    def _request_json(
        self, path: str, params: dict[str, str], kind: str
    ) -> tuple[int, dict[str, Any]]:
        last_error: str | None = None
        for attempt in range(1, self.args.retries + 2):
            if (
                getattr(self.args, "max_requests", None) is not None
                and self.request_count >= self.args.max_requests
            ):
                raise PrototypeFailure(
                    f"max request budget reached ({self.args.max_requests})"
                )
            if (
                getattr(self.args, "max_estimated_cost_usd", None) is not None
                and self.estimated_cost_usd() >= self.args.max_estimated_cost_usd
            ):
                raise PrototypeFailure(
                    "estimated TwitterAPI.io spend limit reached "
                    f"(${self.estimated_cost_usd():.4f} >= "
                    f"${self.args.max_estimated_cost_usd:.2f})"
                )
            self._wait_for_interval()
            url = f"{API_BASE}{path}?{urllib.parse.urlencode(params)}"
            request = urllib.request.Request(
                url,
                headers={
                    "X-API-Key": self.api_key,
                    "Accept": "application/json",
                    "User-Agent": "STELA-twitterapi-io-prototype/0.1",
                },
            )
            self.request_count += 1
            if kind == "profile":
                self.profile_request_count += 1
            else:
                self.search_request_count += 1
            try:
                with urllib.request.urlopen(
                    request, timeout=self.args.request_timeout
                ) as response:
                    body = json.load(response)
                    self.last_request_finished = time.monotonic()
                    if not isinstance(body, dict):
                        raise PrototypeFailure("TwitterAPI.io response was not an object")
                    if body.get("status") == "error":
                        raise PrototypeFailure(
                            f"TwitterAPI.io error: {body.get('msg') or body.get('message')}"
                        )
                    return response.status, body
            except urllib.error.HTTPError as exc:
                self.last_request_finished = time.monotonic()
                response_body = exc.read().decode("utf-8", "replace")[:500]
                last_error = f"HTTP {exc.code}: {response_body}"
                retryable = exc.code == 429 or 500 <= exc.code < 600
                if not retryable or attempt > self.args.retries:
                    raise PrototypeFailure(last_error) from exc
                retry_after = exc.headers.get("Retry-After")
                try:
                    delay = float(retry_after) if retry_after else 0.0
                except ValueError:
                    delay = 0.0
                delay = max(delay, self.args.retry_base * (2 ** (attempt - 1)))
                delay += random.uniform(0, 0.25)
                self._log(f"RETRY HTTP {exc.code} attempt={attempt + 1} in={delay:.2f}s")
                time.sleep(delay)
            except urllib.error.URLError as exc:
                self.last_request_finished = time.monotonic()
                last_error = f"network error: {exc.reason}"
                if attempt > self.args.retries:
                    raise PrototypeFailure(last_error) from exc
                delay = self.args.retry_base * (2 ** (attempt - 1))
                self._log(f"RETRY network attempt={attempt + 1} in={delay:.2f}s")
                time.sleep(delay)
            except TimeoutError as exc:
                self.last_request_finished = time.monotonic()
                last_error = f"request timeout: {exc}"
                if attempt > self.args.retries:
                    raise PrototypeFailure(last_error) from exc
                delay = self.args.retry_base * (2 ** (attempt - 1))
                self._log(f"RETRY timeout attempt={attempt + 1} in={delay:.2f}s")
                time.sleep(delay)
        raise PrototypeFailure(last_error or "request failed")

    def profile(self) -> dict[str, Any]:
        _, payload = self._request_json(
            "/twitter/user/info", {"userName": self.username}, "profile"
        )
        profile = payload.get("data")
        if not isinstance(profile, dict):
            raise PrototypeFailure("profile response has no data object")
        return profile

    def fetch(self, purpose: str, window: Window) -> WindowResult:
        probe = purpose.startswith("probe_")
        pagination_mode = "probe_one_page" if probe else "bounded_cursor"
        key = (
            pagination_mode,
            window.start,
            window.end,
            self.args.probe_limit,
            self.args.fetch_limit,
            self.args.page_review,
            self.args.page_split,
            self.args.page_ceiling,
        )
        cached = self.cache.get(key)
        if cached is not None:
            return cached

        started = time.perf_counter()
        before = self.request_count
        try:
            query = (
                f"from:{self.username} since_time:{window.start} "
                f"until_time:{window.end}"
            )
            params = {"query": query, "queryType": "Latest"}
            normalized: dict[str, NormalizedPost] = {}
            filtered = 0
            duplicates = 0

            def add_page(rows: list[Any]) -> tuple[int, list[int]]:
                nonlocal filtered, duplicates
                new_count = 0
                page_timestamps: list[int] = []
                for raw in rows:
                    if not isinstance(raw, dict):
                        filtered += 1
                        continue
                    post = normalize_post(raw)
                    if post.author_username.lower() != self.username.lower():
                        filtered += 1
                        continue
                    if not (window.start <= post.created_at < window.end):
                        filtered += 1
                        continue
                    page_timestamps.append(post.created_at)
                    if post.post_id in normalized:
                        duplicates += 1
                    else:
                        normalized[post.post_id] = post
                        new_count += 1
                return new_count, page_timestamps

            pages = 0
            first_page_count = 0
            total_raw_count = 0
            has_next_page: bool | None = None
            next_cursor_present = False
            cursor_pages = 0
            cursor_new_posts = 0
            cursor_repeated = False
            cursor_remaining = False
            review_reached = False
            no_progress_pages = 0
            max_no_progress_seen = 0
            seen_cursors: set[str] = set()
            seen_page_signatures: set[tuple[str, ...]] = set()
            current_cursor: str | None = None
            previous_page_newest: int | None = None
            oldest_observed: int | None = None
            newest_observed: int | None = None
            timestamp_order_anomaly = False
            status = "UNKNOWN"
            reason = "request_error"
            basis: str | None = None
            http_status: int | None = None

            while True:
                request_params = dict(params)
                if current_cursor is not None:
                    request_params["cursor"] = current_cursor
                http_status, payload = self._request_json(
                    "/twitter/tweet/advanced_search", request_params, "search"
                )
                raw_posts = payload.get("tweets") or []
                if not isinstance(raw_posts, list):
                    raise PrototypeFailure("search response tweets was not an array")
                self.raw_posts_returned += len(raw_posts)
                pages += 1
                total_raw_count += len(raw_posts)
                if pages == 1:
                    first_page_count = len(raw_posts)

                signature = tuple(
                    str(row.get("id") or "")
                    for row in raw_posts
                    if isinstance(row, dict)
                )
                if signature and signature in seen_page_signatures:
                    cursor_repeated = True
                    status = "PARTIAL"
                    reason = "repeated_page"
                    break
                if signature:
                    seen_page_signatures.add(signature)

                new_count, page_timestamps = add_page(raw_posts)
                if page_timestamps:
                    page_oldest = min(page_timestamps)
                    page_newest = max(page_timestamps)
                    oldest_observed = (
                        page_oldest
                        if oldest_observed is None
                        else min(oldest_observed, page_oldest)
                    )
                    newest_observed = (
                        page_newest
                        if newest_observed is None
                        else max(newest_observed, page_newest)
                    )
                    if (
                        previous_page_newest is not None
                        and page_newest > previous_page_newest
                    ):
                        timestamp_order_anomaly = True
                    previous_page_newest = page_newest
                if pages > 1:
                    cursor_pages += 1
                    cursor_new_posts += new_count
                if new_count == 0:
                    no_progress_pages += 1
                    max_no_progress_seen = max(max_no_progress_seen, no_progress_pages)
                else:
                    no_progress_pages = 0

                has_next_page = bool(payload.get("has_next_page"))
                next_cursor = payload.get("next_cursor")
                next_cursor_present = bool(next_cursor)
                cursor_remaining = has_next_page and next_cursor_present

                if probe:
                    if len(normalized) >= self.args.probe_limit:
                        status = "PARTIAL"
                        reason = "probe_threshold"
                        basis = None
                    else:
                        status = "RESOLVED"
                        reason = "probe_below_threshold"
                        basis = "one_page_below_probe_threshold"
                    break

                if not has_next_page:
                    status = "RESOLVED"
                    reason = "natural_cursor_exhaustion"
                    basis = "observed_has_next_page_false"
                    cursor_remaining = False
                    break
                if not next_cursor_present:
                    status = "PARTIAL"
                    reason = "missing_next_cursor"
                    basis = None
                    cursor_remaining = False
                    break

                next_value = str(next_cursor)
                if next_value == current_cursor or next_value in seen_cursors:
                    cursor_repeated = True
                    status = "PARTIAL"
                    reason = "repeated_cursor"
                    basis = None
                    break
                seen_cursors.add(next_value)

                if no_progress_pages >= self.args.max_no_progress_pages:
                    status = "PARTIAL"
                    reason = "no_progress_page_limit"
                    basis = None
                    break
                if len(normalized) >= self.args.fetch_limit:
                    status = "PARTIAL"
                    reason = "fetch_limit"
                    basis = None
                    break
                if pages >= self.args.page_review:
                    review_reached = True
                if pages >= self.args.page_ceiling:
                    status = "PARTIAL"
                    reason = "page_ceiling"
                    basis = None
                    break
                if (
                    pages >= self.args.page_split
                    and window.width_seconds > self.args.min_window_seconds
                ):
                    status = "PARTIAL"
                    reason = "page_split"
                    basis = None
                    break
                current_cursor = next_value

            result = WindowResult(
                purpose=purpose,
                window=window,
                status=status,
                termination_reason=reason,
                posts=list(normalized.values()),
                requests=self.request_count - before,
                pages=pages,
                raw_post_count=total_raw_count,
                first_page_raw_post_count=first_page_count,
                filtered_post_count=filtered,
                duplicate_post_count=duplicates,
                elapsed_seconds=time.perf_counter() - started,
                has_next_page=has_next_page,
                next_cursor_present=next_cursor_present,
                cursor_pages=cursor_pages,
                cursor_new_posts=cursor_new_posts,
                cursor_repeated=cursor_repeated,
                cursor_remaining=cursor_remaining,
                review_reached=review_reached,
                no_progress_pages=max_no_progress_seen,
                oldest_observed_timestamp=oldest_observed,
                newest_observed_timestamp=newest_observed,
                cursor_progress_seconds=(
                    max(0, window.end - oldest_observed)
                    if oldest_observed is not None
                    else 0
                ),
                timestamp_order_anomaly=timestamp_order_anomaly,
                resolution_basis=basis,
                http_status=http_status,
            )
        except PrototypeFailure as exc:
            result = WindowResult(
                purpose=purpose,
                window=window,
                status="UNKNOWN",
                termination_reason="request_error",
                posts=list(normalized.values()),
                requests=self.request_count - before,
                pages=pages,
                raw_post_count=total_raw_count,
                first_page_raw_post_count=first_page_count,
                filtered_post_count=filtered,
                duplicate_post_count=duplicates,
                elapsed_seconds=time.perf_counter() - started,
                has_next_page=has_next_page,
                next_cursor_present=next_cursor_present,
                cursor_pages=cursor_pages,
                cursor_new_posts=cursor_new_posts,
                cursor_repeated=cursor_repeated,
                cursor_remaining=cursor_remaining,
                review_reached=review_reached,
                no_progress_pages=max_no_progress_seen,
                oldest_observed_timestamp=oldest_observed,
                newest_observed_timestamp=newest_observed,
                cursor_progress_seconds=(
                    max(0, window.end - oldest_observed)
                    if oldest_observed is not None
                    else 0
                ),
                timestamp_order_anomaly=timestamp_order_anomaly,
                http_status=http_status,
                error=str(exc),
            )

        self.events.append(result)
        if result.status != "UNKNOWN":
            self.cache[key] = result
        return result

    def _log(self, message: str) -> None:
        if not self.args.quiet:
            print(message, flush=True)


class OldestBlockExperiment:
    def __init__(
        self,
        args: argparse.Namespace,
        username: str,
        client: TwitterApiIoClient,
        lower_bound: int,
        snapshot_end: int,
        profile: dict[str, Any] | None = None,
    ) -> None:
        self.args = args
        self.username = username
        self.client = client
        self.lower_bound = lower_bound
        self.snapshot_end = snapshot_end
        self.profile = profile_json(
            profile
            or {
                "id": "",
                "userName": username,
                "name": username,
                "createdAt": iso_epoch(lower_bound),
            }
        )
        self.candidates: dict[str, Candidate] = {}
        self.resolved_intervals: list[Window] = []
        self.probe_count = 0
        self.collect_window_count = 0
        self.split_count = 0
        self.cursor_suffix_reuse_count = 0
        self.density_split_count = 0
        self.half_split_count = 0
        self.collect_span_seconds = args.window_days * SECONDS_PER_DAY
        self.adaptive_reset_to_7_count = 0
        self.discarded_parent_post_count = 0
        self.duplicate_sightings = 0
        self.resumed_from_checkpoint = False
        self.resume_phase = "probe"
        self.resume_collect_start: int | None = None
        self.checkpoint_resume_start: int | None = None
        self.restored_events: dict[tuple[str, int, int], WindowResult] = {}
        self.last_root_collect_result: WindowResult | None = None
        self.last_collect_used_split = False
        self.probe_reentry_count = 0
        self.empty_resolved_streak = 0
        # A re-entry can happen several times inside one calendar year. Keep
        # the year-level result so we do not re-run the same year-tail probe
        # on every seven-day gap.
        self.probe_year_states: dict[int, str] = {}

    @staticmethod
    def _window_from_json(row: dict[str, Any]) -> Window:
        start = row.get("start")
        end = row.get("end")
        if not isinstance(start, str) or not isinstance(end, str):
            raise PrototypeFailure("checkpoint window is missing start or end")
        return Window(epoch(parse_datetime(start)), epoch(parse_datetime(end)))

    @staticmethod
    def _int_or_zero(value: Any) -> int:
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    def _restore_window_event(
        self,
        row: dict[str, Any],
        posts_by_id: dict[str, NormalizedPost],
    ) -> WindowResult:
        window = self._window_from_json(row)
        post_ids = row.get("post_ids")
        posts = [
            posts_by_id[str(post_id)]
            for post_id in post_ids
            if str(post_id) in posts_by_id
        ] if isinstance(post_ids, list) else []
        return WindowResult(
            purpose=str(row.get("phase") or "collect"),
            window=window,
            status=str(row.get("status") or "UNKNOWN"),
            termination_reason=str(row.get("termination_reason") or "unknown"),
            posts=posts,
            requests=self._int_or_zero(row.get("requests")),
            pages=self._int_or_zero(row.get("pages")),
            raw_post_count=self._int_or_zero(row.get("raw_post_count")),
            first_page_raw_post_count=self._int_or_zero(
                row.get("first_page_raw_post_count")
            ),
            filtered_post_count=self._int_or_zero(row.get("filtered_post_count")),
            duplicate_post_count=self._int_or_zero(row.get("duplicate_post_count")),
            elapsed_seconds=float(row.get("elapsed_seconds") or 0),
            has_next_page=row.get("has_next_page"),
            next_cursor_present=bool(row.get("next_cursor_present")),
            cursor_pages=self._int_or_zero(row.get("cursor_pages")),
            cursor_new_posts=self._int_or_zero(row.get("cursor_new_posts")),
            cursor_repeated=bool(row.get("cursor_repeated")),
            cursor_remaining=bool(row.get("cursor_remaining")),
            review_reached=bool(row.get("review_reached")),
            no_progress_pages=self._int_or_zero(row.get("no_progress_pages")),
            oldest_observed_timestamp=(
                epoch(parse_datetime(row["oldest_observed_timestamp"]))
                if isinstance(row.get("oldest_observed_timestamp"), str)
                else None
            ),
            newest_observed_timestamp=(
                epoch(parse_datetime(row["newest_observed_timestamp"]))
                if isinstance(row.get("newest_observed_timestamp"), str)
                else None
            ),
            cursor_progress_seconds=self._int_or_zero(
                row.get("cursor_progress_seconds")
            ),
            timestamp_order_anomaly=bool(row.get("timestamp_order_anomaly")),
            resolution_basis=(
                str(row["resolution_basis"])
                if row.get("resolution_basis") is not None
                else None
            ),
            http_status=(
                self._int_or_zero(row["http_status"])
                if row.get("http_status") is not None
                else None
            ),
            error=(str(row["error"]) if row.get("error") is not None else None),
            attempt=self._int_or_zero(row.get("attempt")) or 1,
        )

    def restore_checkpoint(self) -> bool:
        """Restore completed work from --checkpoint, if that file exists.

        Checkpoints are written at safe window boundaries.  A v1 checkpoint
        therefore resumes at the first uncovered oldest-side timestamp, while
        v2 additionally records that position explicitly.  The persisted
        snapshot boundary is retained so a resumed run cannot silently change
        its coverage target halfway through an experiment.
        """
        checkpoint = getattr(self.args, "checkpoint", None)
        if checkpoint is None or not checkpoint.exists():
            return False
        try:
            raw = json.loads(checkpoint.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PrototypeFailure(f"could not read checkpoint {checkpoint}: {exc}") from exc
        if not isinstance(raw, dict):
            raise PrototypeFailure("checkpoint root must be an object")
        if raw.get("experiment") != "twitterapi_io_oldest_block_checkpoint":
            raise PrototypeFailure("checkpoint experiment does not match this runner")
        checkpoint_username = normalize_username(str(raw.get("username") or ""))
        if checkpoint_username.lower() != self.username.lower():
            raise PrototypeFailure(
                f"checkpoint belongs to @{checkpoint_username}, not @{self.username}"
            )
        checkpoint_lower = raw.get("lower_bound")
        if not isinstance(checkpoint_lower, str):
            raise PrototypeFailure("checkpoint has no lower_bound")
        if epoch(parse_datetime(checkpoint_lower)) != self.lower_bound:
            raise PrototypeFailure(
                "checkpoint lower_bound differs from the current profile; "
                "refusing to mix experiments"
            )
        checkpoint_end = raw.get("snapshot_end")
        if not isinstance(checkpoint_end, str):
            raise PrototypeFailure("checkpoint has no snapshot_end")
        self.snapshot_end = epoch(parse_datetime(checkpoint_end))

        raw_candidates = raw.get("candidates")
        if not isinstance(raw_candidates, list):
            raise PrototypeFailure("checkpoint candidates must be an array")
        for row in raw_candidates:
            if not isinstance(row, dict):
                raise PrototypeFailure("checkpoint candidate must be an object")
            post = normalized_post_from_json(row)
            if not post.post_id:
                raise PrototypeFailure("checkpoint candidate has no post_id")
            self.candidates[post.post_id] = Candidate(
                post=post,
                sightings=max(1, self._int_or_zero(row.get("candidate_sightings"))),
                seen_in_resolved_window=bool(row.get("seen_in_resolved_window")),
                sources={str(value) for value in row.get("sources", [])}
                if isinstance(row.get("sources"), list)
                else {"checkpoint"},
            )

        raw_intervals = raw.get("resolved_intervals")
        if not isinstance(raw_intervals, list):
            raise PrototypeFailure("checkpoint resolved_intervals must be an array")
        self.resolved_intervals = [
            self._window_from_json(row)
            for row in raw_intervals
            if isinstance(row, dict)
        ]

        posts_by_id = {
            post_id: candidate.post for post_id, candidate in self.candidates.items()
        }
        raw_windows = raw.get("windows")
        if not isinstance(raw_windows, list):
            raise PrototypeFailure("checkpoint windows must be an array")
        restored_events = [
            self._restore_window_event(row, posts_by_id)
            for row in raw_windows
            if isinstance(row, dict)
        ]
        self.client.events = restored_events
        self.restored_events = {
            (event.purpose, event.window.start, event.window.end): event
            for event in restored_events
        }

        counters = raw.get("counters")
        counters = counters if isinstance(counters, dict) else {}
        self.probe_count = self._int_or_zero(counters.get("probe_count")) or sum(
            event.purpose.startswith("probe_") for event in restored_events
        )
        self.collect_window_count = self._int_or_zero(
            counters.get("collect_window_count")
        ) or sum(event.purpose == "collect" for event in restored_events)
        self.split_count = self._int_or_zero(counters.get("split_count"))
        self.cursor_suffix_reuse_count = self._int_or_zero(
            counters.get("cursor_suffix_reuse_count")
        )
        self.density_split_count = self._int_or_zero(
            counters.get("density_split_count")
        )
        self.half_split_count = self._int_or_zero(counters.get("half_split_count"))
        self.adaptive_reset_to_7_count = self._int_or_zero(
            counters.get("adaptive_reset_to_7_count")
        )
        self.probe_reentry_count = self._int_or_zero(
            counters.get("probe_reentry_count")
        )
        self.empty_resolved_streak = self._int_or_zero(
            counters.get("empty_resolved_streak")
        )
        raw_probe_year_states = counters.get("probe_year_states")
        if isinstance(raw_probe_year_states, dict):
            self.probe_year_states = {
                int(year): str(status)
                for year, status in raw_probe_year_states.items()
                if str(status) in {"RESOLVED", "PARTIAL"}
            }
        # Backfill the cache for older checkpoints, including the 10-account
        # live test checkpoint format that predates this optimization.
        for event in restored_events:
            if event.purpose != "probe_year":
                continue
            year = datetime.fromtimestamp(event.window.start, UTC).year
            if event.status == "PARTIAL" or year not in self.probe_year_states:
                self.probe_year_states[year] = event.status
        self.discarded_parent_post_count = self._int_or_zero(
            counters.get("discarded_parent_post_count")
        )
        self.duplicate_sightings = self._int_or_zero(
            counters.get("duplicate_sightings")
        )
        profile_requests_before_restore = self.client.profile_request_count
        requests_before_restore = self.client.request_count
        self.client.request_count = self._int_or_zero(
            counters.get("request_count")
        ) or (sum(event.requests for event in restored_events) + requests_before_restore)
        self.client.profile_request_count = self._int_or_zero(
            counters.get("profile_request_count")
        ) or profile_requests_before_restore
        self.client.search_request_count = self._int_or_zero(
            counters.get("search_request_count")
        ) or sum(event.requests for event in restored_events)
        self.client.raw_posts_returned = self._int_or_zero(
            counters.get("raw_posts_returned")
        ) or sum(event.raw_post_count for event in restored_events)

        resume = raw.get("resume")
        resume = resume if isinstance(resume, dict) else {}
        saved_span_seconds = self._int_or_zero(resume.get("collect_span_seconds"))
        saved_span_days = self._int_or_zero(resume.get("collect_span_days"))
        if saved_span_seconds >= 1:
            self.collect_span_seconds = saved_span_seconds
        elif saved_span_days >= 1:
            self.collect_span_seconds = saved_span_days * SECONDS_PER_DAY
        phase = resume.get("phase")
        if phase not in {"probe", "collect"}:
            phase = "collect" if any(event.purpose == "collect" for event in restored_events) else "probe"
        self.resume_phase = phase
        next_start = resume.get("next_collect_start")
        if isinstance(next_start, str):
            self.resume_collect_start = epoch(parse_datetime(next_start))
        elif self.resume_phase == "collect":
            self.resume_collect_start = self.coverage_frontier()
        self.checkpoint_resume_start = self.resume_collect_start
        self.resumed_from_checkpoint = True
        self.client._log(
            f"RESUME checkpoint={checkpoint} candidates={len(self.candidates)} "
            f"windows={len(restored_events)} "
            f"next={iso_epoch(self.resume_collect_start) if self.resume_collect_start is not None else 'probe'}"
        )
        return True

    def save_checkpoint(self) -> None:
        """Persist recoverable progress after each completed API window.

        This is intentionally a lightweight prototype checkpoint rather than a
        job database. It preserves candidates, resolved intervals, counters, and
        window events so a later resume implementation can continue without
        losing the expensive observations already made.
        """
        checkpoint = getattr(self.args, "checkpoint", None)
        if checkpoint is None:
            return
        payload = {
            "schema_version": 3,
            "experiment": "twitterapi_io_oldest_block_checkpoint",
            "username": self.username,
            "lower_bound": iso_epoch(self.lower_bound),
            "snapshot_end": iso_epoch(self.snapshot_end),
            "target_count": self.args.target_count,
            "collection_mode": getattr(self.args, "collection_mode", "prefix_initial"),
            "updated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "counters": {
                "probe_count": self.probe_count,
                "collect_window_count": self.collect_window_count,
                "split_count": self.split_count,
                "cursor_suffix_reuse_count": self.cursor_suffix_reuse_count,
                "density_split_count": self.density_split_count,
                "half_split_count": self.half_split_count,
                "adaptive_reset_to_7_count": self.adaptive_reset_to_7_count,
                "probe_reentry_count": self.probe_reentry_count,
                "empty_resolved_streak": self.empty_resolved_streak,
                "probe_year_states": {
                    str(year): status
                    for year, status in sorted(self.probe_year_states.items())
                },
                "discarded_parent_post_count": self.discarded_parent_post_count,
                "duplicate_sightings": self.duplicate_sightings,
                "request_count": self.client.request_count,
                "profile_request_count": self.client.profile_request_count,
                "search_request_count": self.client.search_request_count,
                "raw_posts_returned": self.client.raw_posts_returned,
            },
            "resume": {
                "phase": self.resume_phase,
                "collect_span_seconds": int(self.collect_span_seconds),
                "collect_span_days": math.ceil(
                    self.collect_span_seconds / SECONDS_PER_DAY
                ),
                "next_collect_start": (
                    iso_epoch(self.resume_collect_start)
                    if self.resume_collect_start is not None
                    else None
                ),
            },
            "resolved_intervals": [
                {"start": iso_epoch(window.start), "end": iso_epoch(window.end)}
                for window in self.resolved_intervals
            ],
            "candidates": [post_json(row) for row in self.candidates.values()],
            "windows": [event.event_json() for event in self.client.events],
        }
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        temporary = checkpoint.with_suffix(checkpoint.suffix + ".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        temporary.replace(checkpoint)
        self.save_progress_snapshot()

    def save_progress_snapshot(self) -> None:
        """Publish a UI-importable snapshot after an atomic checkpoint."""
        progress_output = getattr(self.args, "progress_output", None)
        if progress_output is None:
            return
        resolved = self.resolved_candidates()
        frontier = self.coverage_frontier()
        payload = {
            "schema_version": 1,
            "experiment": "twitterapi_io_oldest_block_progress",
            "username": self.username,
            "profile": self.profile,
            "config": {
                "target_count": self.args.target_count,
                "collection_mode": getattr(self.args, "collection_mode", "prefix_initial"),
                "collect_start": iso_epoch(self.lower_bound),
            },
            "result": {
                "status": "IN_PROGRESS",
                "unique_post_count": len(resolved),
                "coverage_frontier": iso_epoch(frontier),
                "progress_message": (
                    f"採掘中: 確定 {len(resolved)}件 / 候補 {len(self.candidates)}件; "
                    f"カバレッジ {iso_epoch(frontier)}"
                ),
            },
            "metrics": {
                "total_requests": self.client.request_count,
                "total_pages": sum(event.pages for event in self.client.events),
                "raw_posts_returned": self.client.raw_posts_returned,
                "candidate_unique_count": len(self.candidates),
                "duplicate_sightings": self.duplicate_sightings,
            },
            "windows": [event.event_json() for event in self.client.events],
            "candidate_posts": [post_json(row) for row in self.candidates.values()],
        }
        progress_output.parent.mkdir(parents=True, exist_ok=True)
        temporary = progress_output.with_suffix(progress_output.suffix + ".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        temporary.replace(progress_output)
        self.client._log(
            f"PROGRESS covered={len(resolved)} candidates={len(self.candidates)} "
            f"frontier={iso_epoch(frontier)}"
        )

    def add_result(self, result: WindowResult, retain_posts: bool = True) -> None:
        if not retain_posts:
            self.discarded_parent_post_count += result.unique_posts
            self.client._log(
                "DISCARD PARENT "
                f"{result.window.label()} status={result.status} "
                f"pages={result.pages} unique={result.unique_posts} "
                "child windows are authoritative"
            )
            return
        source = (
            f"{result.purpose}:{result.window.start}:{result.window.end}:"
            f"{result.termination_reason}"
        )
        for post in result.posts:
            existing = self.candidates.get(post.post_id)
            if existing is None:
                self.candidates[post.post_id] = Candidate(
                    post=post,
                    seen_in_resolved_window=result.status == "RESOLVED",
                    sources={source},
                )
            else:
                existing.sightings += 1
                existing.sources.add(source)
                existing.seen_in_resolved_window |= result.status == "RESOLVED"
                self.duplicate_sightings += 1
        if result.status == "RESOLVED":
            self.resolved_intervals.append(result.window)

    def coverage_frontier(self) -> int:
        frontier = self.lower_bound
        for window in sorted(self.resolved_intervals):
            if window.end <= frontier:
                continue
            if window.start > frontier:
                break
            frontier = max(frontier, window.end)
        return frontier

    def resolved_candidates(self) -> list[Candidate]:
        frontier = self.coverage_frontier()
        rows = [
            row
            for row in self.candidates.values()
            if self.lower_bound <= row.post.created_at < frontier
        ]
        return sorted(rows, key=lambda row: (row.post.created_at, int(row.post.post_id)))

    def target_reached(self) -> bool:
        return len(self.resolved_candidates()) >= self.args.target_count

    def _fetch_window(
        self, purpose: str, window: Window
    ) -> tuple[WindowResult, bool]:
        """Return a restored probe event or perform a new API fetch."""
        restored = self.restored_events.get((purpose, window.start, window.end))
        if restored is not None:
            return restored, True
        return self.client.fetch(purpose, window), False

    def probe_from(self, probe_start: int) -> int | None:
        """Explore from a known empty frontier until activity is located."""
        if probe_start >= self.snapshot_end:
            return None

        created = datetime.fromtimestamp(probe_start, UTC)
        last = datetime.fromtimestamp(self.snapshot_end - 1, UTC)
        for year in range(created.year, last.year + 1):
            start = max(probe_start, year_start(year))
            end = min(self.snapshot_end, year_start(year + 1))
            if start >= end:
                continue
            year_state = self.probe_year_states.get(year)
            if year_state is None:
                result, restored = self._fetch_window("probe_year", Window(start, end))
                year_state = result.status
                self.probe_year_states[year] = year_state
                if not restored:
                    self.probe_count += 1
                    self.add_result(result)
                    self.save_checkpoint()
                self._log_result("PROBE YEAR", result)
                if result.status == "UNKNOWN":
                    self._raise_unknown(result)
            else:
                self.client._log(
                    f"PROBE YEAR cached year={year} status={year_state}"
                )
            if year_state == "RESOLVED":
                if self.target_reached():
                    return None
                continue

            month = datetime(year, 1, 1, tzinfo=UTC)
            while month.year == year:
                month_end = next_month_start(month)
                month_window_start = max(start, epoch(month))
                month_window_end = min(end, epoch(month_end))
                month = month_end
                if month_window_start >= month_window_end:
                    continue
                month_window = Window(month_window_start, month_window_end)
                result, restored = self._fetch_window("probe_month", month_window)
                if not restored:
                    self.probe_count += 1
                    self.add_result(result)
                    self.save_checkpoint()
                self._log_result("PROBE MONTH", result)
                if result.status == "UNKNOWN":
                    self._raise_unknown(result)
                if result.status == "PARTIAL":
                    return month_window.start
                if self.target_reached():
                    return None
        return None

    def probe_until_collect(self) -> int | None:
        if self.resumed_from_checkpoint and self.resume_phase == "collect":
            if self.target_reached():
                return None
            if self.resume_collect_start is None:
                raise PrototypeFailure("collect checkpoint has no resume position")
            return self.resume_collect_start
        return self.probe_from(self.lower_bound)

    def _next_page_target_span_seconds(
        self, window: Window, pages: int
    ) -> int:
        """Estimate the next width so its page count approaches the target."""
        pages = max(1, pages)
        estimated = int(window.width_seconds * self._split_target_pages() / pages)
        return max(self.args.min_window_seconds, estimated)

    def collect_from(self, collect_start: int) -> None:
        cursor = collect_start
        self.resume_phase = "collect"
        self.resume_collect_start = collect_start
        self.save_checkpoint()
        while cursor < self.snapshot_end and not self.target_reached():
            end = min(
                self.snapshot_end,
                cursor + self.collect_span_seconds,
            )
            window = Window(cursor, end)
            resolved_before = len(self.resolved_candidates())
            resolved = self.resolve_collect_window(window, depth=0)
            unique_new = len(self.resolved_candidates()) - resolved_before
            if resolved and unique_new == 0:
                self.empty_resolved_streak += 1
            else:
                self.empty_resolved_streak = 0
            if resolved and self.empty_resolved_streak >= 2:
                # A fully exhausted empty window is a gap signal, regardless
                # of whether it followed a split. Require two consecutive
                # zero-new resolved windows so one sparse/duplicate window
                # does not trigger an expensive exploration cycle.
                self.probe_reentry_count += 1
                probe_start = self.probe_from(window.end)
                self.collect_span_seconds = self.args.window_days * SECONDS_PER_DAY
                self.empty_resolved_streak = 0
                if probe_start is None:
                    cursor = self.snapshot_end
                    self.resume_collect_start = cursor
                    self.save_checkpoint()
                    self.client._log(
                        "ADAPTIVE empty window reached snapshot end; "
                        "exploration found no later activity"
                    )
                    return
                cursor = probe_start
                self.resume_collect_start = cursor
                self.save_checkpoint()
                self.client._log(
                    f"ADAPTIVE empty window -> PROBE reentry at {iso_epoch(cursor)} "
                    f"next_span_days={self.args.window_days}"
                )
                continue
            if self.last_collect_used_split:
                # Split recovery has already sized each contiguous child from
                # its observed page density. Resume the normal route at the
                # configured initial width after the split range is resolved.
                self.adaptive_reset_to_7_count += 1
                self.collect_span_seconds = self.args.window_days * SECONDS_PER_DAY
                action = "reset_after_split"
                self.last_collect_used_split = False
            else:
                root_result = self.last_root_collect_result
                if root_result is None:
                    raise PrototypeFailure("collect window has no root result")
                self.collect_span_seconds = self._next_page_target_span_seconds(
                    window, root_result.pages
                )
                action = "page_target"
            self.client._log(
                "ADAPTIVE "
                f"span_seconds={self.collect_span_seconds} "
                f"unique_new={unique_new} action={action} "
                f"target_pages={self._split_target_pages()}"
            )
            cursor = window.end
            self.resume_collect_start = cursor
            self.save_checkpoint()
            if self.target_reached():
                return
            if not resolved:
                raise PrototypeFailure(f"window was not resolved: {window.label()}")

    def _record_collect_result(
        self, window: Window, depth: int
    ) -> WindowResult:
        result = self.client.fetch("collect", window)
        self.collect_window_count += 1
        self.add_result(result, retain_posts=result.status == "RESOLVED")
        self._log_result(f"COLLECT depth={depth}", result)
        return result

    def _split_width_seconds(self, result: WindowResult) -> int:
        """Estimate a child width that should consume at most 12 pages.

        A partial result is only a sample. Its posts are discarded, while the
        observed cursor time span and page count provide a cheap local density
        estimate.  The estimate is deliberately based on pages, not on the
        capped parent post count.
        """
        observed_seconds = result.cursor_progress_seconds
        pages = max(1, result.pages)
        if observed_seconds <= 0:
            observed_seconds = result.window.width_seconds
        estimated = int(observed_seconds * self._split_target_pages() / pages)
        return max(self.args.min_window_seconds, estimated)

    def _split_target_pages(self) -> int:
        """Return the page budget used for split-child sizing.

        The existing 20-page ceiling and 0.6 safety factor intentionally yield
        a 12-page operating target, while keeping the relationship configurable.
        """
        page_split = max(2, int(self.args.page_split))
        safety_factor = float(self.args.density_safety_factor)
        return max(1, min(page_split - 1, math.floor(page_split * safety_factor)))

    def _next_split_width_seconds(
        self, result: WindowResult
    ) -> int:
        """Adapt the next contiguous split child from its page density."""
        pages = max(1, result.pages)
        estimated = int(result.window.width_seconds * self._split_target_pages() / pages)
        max_width = SPLIT_RECOVERY_MAX_DAYS * 24 * 60 * 60
        return min(
            max_width,
            max(self.args.min_window_seconds, estimated),
        )

    def _mark_split(self, result: WindowResult, split_width: int, depth: int) -> None:
        self.split_count += 1
        self.density_split_count += 1
        self.client._log(
            f"SPLIT method=page_density depth={depth} "
            f"source={result.window.label()} pages={result.pages} "
            f"progress={result.cursor_progress_seconds}s "
            f"next_width={split_width}s target_pages={self._split_target_pages()}"
        )

    def _resolve_split_range(
        self,
        start: int,
        end: int,
        initial_width: int,
        depth: int,
    ) -> bool:
        """Resolve a split range oldest-first with contiguous child windows.

        A partial child is discarded and replaced by its own adjacent smaller
        children.  The remainder of the parent range stays queued behind the
        oldest child, so a dense newer suffix is never fetched as one giant
        repeated window.
        """
        pending: list[tuple[int, int, int, int]] = [(start, end, initial_width, depth)]
        while pending:
            if self.target_reached():
                return True
            range_start, range_end, width, range_depth = pending.pop(0)
            child_end = min(range_end, range_start + max(1, width))
            child = Window(range_start, child_end)
            result = self._record_collect_result(child, range_depth)

            if result.status == "UNKNOWN":
                self.save_checkpoint()
                self._raise_unknown(result)

            if result.status == "RESOLVED":
                next_width = self._next_split_width_seconds(result)
                self.collect_span_seconds = min(
                    SPLIT_RECOVERY_MAX_DAYS * SECONDS_PER_DAY,
                    max(self.args.min_window_seconds, next_width),
                )
                self.resume_collect_start = child_end
                self.save_checkpoint()
                if child_end < range_end:
                    pending.insert(0, (child_end, range_end, next_width, range_depth))
                continue

            if child.width_seconds <= self.args.min_window_seconds:
                self.save_checkpoint()
                raise PrototypeFailure(
                    "provider page remained saturated at minimum window size; "
                    f"cannot prove coverage for {child.label()}"
                )

            next_width = min(self._split_width_seconds(result), child.width_seconds - 1)
            if next_width <= 0:
                self.save_checkpoint()
                raise PrototypeFailure(f"could not split {child.label()}")
            split_end = child.start + next_width
            older = (child.start, split_end, next_width, range_depth + 1)
            newer = (split_end, child.end, next_width, range_depth + 1)
            self._mark_split(result, next_width, range_depth)
            self.save_checkpoint()
            # Oldest first: process the new small child, then the rest of the
            # partial child, then the range that followed it. The final tail
            # is essential: discarding the saturated parent must not discard
            # the unobserved newer remainder of that parent.
            follow_up = [older]
            if newer[0] < newer[1]:
                follow_up.append(newer)
            if child_end < range_end:
                follow_up.append((child_end, range_end, next_width, range_depth))
            pending[0:0] = follow_up

        return True

    def resolve_collect_window(self, window: Window, depth: int) -> bool:
        result = self._record_collect_result(window, depth)
        if depth == 0:
            self.last_root_collect_result = result
        if result.status == "RESOLVED":
            self.save_checkpoint()
            return True
        if result.status == "UNKNOWN":
            self.save_checkpoint()
            self._raise_unknown(result)
        if window.width_seconds <= self.args.min_window_seconds:
            self.save_checkpoint()
            raise PrototypeFailure(
                "provider page remained saturated at minimum window size; "
                f"cannot prove coverage for {window.label()}"
            )

        split_width = min(self._split_width_seconds(result), window.width_seconds - 1)
        if split_width <= 0:
            self.save_checkpoint()
            raise PrototypeFailure(f"could not split {window.label()}")
        self._mark_split(result, split_width, depth)
        self.last_collect_used_split = True
        self.save_checkpoint()
        return self._resolve_split_range(
            window.start,
            window.end,
            split_width,
            depth + 1,
        )

    def _reuse_cursor_suffix(
        self, result: WindowResult, depth: int
    ) -> Window | None:
        """Keep a well-behaved cursor-covered suffix and fetch only older time.

        The boundary second remains in the older retry window, with additional
        overlap, so same-timestamp posts cannot fall into a gap.  This is an
        operational coverage claim based on monotonic cursor traversal, not a
        provider-level proof.
        """
        if result.termination_reason not in {"page_split", "fetch_limit"}:
            return None
        if not result.cursor_remaining or result.cursor_repeated:
            return None
        if result.timestamp_order_anomaly or result.oldest_observed_timestamp is None:
            return None
        progress_ratio = result.cursor_progress_seconds / result.window.width_seconds
        if progress_ratio < self.args.cursor_suffix_reuse_min_ratio:
            return None

        boundary = result.oldest_observed_timestamp
        suffix_start = boundary + 1
        older_end = min(
            result.window.end,
            boundary + self.args.boundary_overlap_seconds,
        )
        if (
            suffix_start >= result.window.end
            or older_end <= result.window.start
            or older_end >= result.window.end
        ):
            return None

        suffix = Window(suffix_start, result.window.end)
        older = Window(result.window.start, older_end)
        self.resolved_intervals.append(suffix)
        for candidate in self.candidates.values():
            if suffix.start <= candidate.post.created_at < suffix.end:
                candidate.seen_in_resolved_window = True
        self.split_count += 1
        self.cursor_suffix_reuse_count += 1
        self.client._log(
            f"REUSE CURSOR SUFFIX depth={depth} progress={progress_ratio:.1%} "
            f"covered={suffix.label()} unresolved_older={older.label()}"
        )
        return older

    def _raise_unknown(self, result: WindowResult) -> None:
        raise PrototypeFailure(
            f"UNKNOWN window {result.window.label()} "
            f"reason={result.termination_reason} error={result.error}"
        )

    def _log_result(self, prefix: str, result: WindowResult) -> None:
        self.client._log(
            f"{prefix} {result.window.label()} status={result.status} "
            f"termination={result.termination_reason} requests={result.requests} "
            f"pages={result.pages} cursor_pages={result.cursor_pages} "
            f"raw={result.raw_post_count} unique={result.unique_posts} "
            f"has_next={result.has_next_page} elapsed={result.elapsed_seconds:.2f}s"
        )


def post_json(candidate: Candidate) -> dict[str, Any]:
    row = asdict(candidate.post)
    row["created_at"] = iso_epoch(candidate.post.created_at)
    row["mentions"] = list(candidate.post.mentions)
    row["media"] = list(candidate.post.media)
    row["candidate_sightings"] = candidate.sightings
    row["seen_in_resolved_window"] = candidate.seen_in_resolved_window
    return row


def profile_json(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "account_id": (
            str(profile.get("id")) if profile.get("id") is not None else None
        ),
        "username": profile.get("userName"),
        "display_name": profile.get("name"),
        "avatar_url": profile.get("profilePicture"),
        "cover_url": profile.get("coverPicture"),
        "description": profile.get("description"),
        "created_at": profile.get("createdAt"),
        "protected": profile.get("protected"),
        "followers_count": profile.get("followers"),
        "following_count": profile.get("following"),
        "statuses_count": profile.get("statusesCount"),
    }


def default_output(username: str) -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return Path("results/twitterapi-io-1000") / f"{username}-{stamp}.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Measure oldest-side collection through bounded TwitterAPI.io cursor "
            "pagination and calendar-aligned time windows."
        )
    )
    parser.add_argument("username", help="X username, with or without @")
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--target-count", type=int, default=1000)
    parser.add_argument(
        "--collection-mode",
        choices=("prefix_initial", "prefix_extend", "date_range"),
        default="prefix_initial",
        help="prefix_extend collects only from --collect-start onward",
    )
    parser.add_argument(
        "--collect-start",
        type=parse_cli_datetime,
        help="inclusive UTC lower bound for a prefix extension",
    )
    parser.add_argument(
        "--collect-end",
        type=parse_cli_datetime,
        help="exclusive UTC upper bound for date_range collection",
    )
    parser.add_argument(
        "--window-days",
        type=int,
        default=7,
        help="initial collection-window width before 30/120/year-end expansion (default: 7 days)",
    )
    parser.add_argument("--probe-limit", type=int, default=10)
    parser.add_argument(
        "--fetch-limit",
        type=int,
        default=1000,
        help="soft unique-post cap per collect window, independent of target count",
    )
    parser.add_argument("--page-review", type=int, default=10)
    parser.add_argument("--page-split", type=int, default=20)
    parser.add_argument("--page-ceiling", type=int, default=30)
    parser.add_argument("--max-no-progress-pages", type=int, default=3)
    parser.add_argument(
        "--cursor-suffix-reuse-min-ratio",
        type=float,
        default=5 / 7,
        help="reuse a monotonic cursor-covered suffix after this share of a window",
    )
    parser.add_argument(
        "--density-safety-factor",
        type=float,
        default=0.6,
        help="size density-based child windows below the observed page capacity",
    )
    parser.add_argument(
        "--boundary-overlap-seconds",
        type=int,
        default=60,
        help="overlap retained cursor suffix and older retry window",
    )
    parser.add_argument("--min-window-seconds", type=int, default=1)
    parser.add_argument(
        "--max-requests", type=int,
        help="optional explicit request budget; omitted means no request-count stop",
    )
    parser.add_argument(
        "--max-estimated-cost-usd",
        type=float,
        help="optional explicit estimated-spend budget; omitted means no cost stop",
    )
    parser.add_argument(
        "--checkpoint",
        type=Path,
        help="write an incremental checkpoint after each window (default: alongside output)",
    )
    parser.add_argument(
        "--progress-output",
        type=Path,
        help="write a UI-importable progress snapshot after each checkpoint",
    )
    parser.add_argument("--request-timeout", type=float, default=30.0)
    # A 0.7-second completion-to-completion interval is still far below the
    # provider's advertised throughput, while avoiding needless idle time.
    # Keep this configurable; production concurrency will need one shared
    # limiter rather than per-worker sleeps.
    parser.add_argument("--request-interval", type=float, default=0.7)
    parser.add_argument(
        "--shared-rate-limit-file",
        type=Path,
        help="coordinate request starts with sibling account workers",
    )
    parser.add_argument(
        "--shared-request-interval",
        type=float,
        help="minimum seconds between starts across sibling workers",
    )
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--retry-base", type=float, default=6.0)
    parser.add_argument("--snapshot-lag-seconds", type=int, default=60)
    parser.add_argument("--single-window-start", type=parse_cli_datetime)
    parser.add_argument("--single-window-end", type=parse_cli_datetime)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()
    if args.target_count < 1:
        parser.error("--target-count must be at least 1")
    if args.collection_mode == "prefix_extend" and args.collect_start is None:
        parser.error("prefix_extend requires --collect-start")
    if args.collection_mode == "date_range" and (
        args.collect_start is None or args.collect_end is None
    ):
        parser.error("date_range requires --collect-start and --collect-end")
    if args.collection_mode == "prefix_initial" and (
        args.collect_start is not None or args.collect_end is not None
    ):
        parser.error("collection bounds require prefix_extend or date_range")
    if args.collection_mode == "prefix_extend" and args.collect_end is not None:
        parser.error("--collect-end is only valid for date_range")
    if args.collect_start is not None and args.collect_end is not None and args.collect_start >= args.collect_end:
        parser.error("--collect-start must be before --collect-end")
    if args.window_days < 1:
        parser.error("--window-days must be at least 1")
    if args.probe_limit < 1:
        parser.error("--probe-limit must be at least 1")
    if args.request_interval < 0:
        parser.error("--request-interval cannot be negative")
    if args.shared_request_interval is not None and args.shared_request_interval <= 0:
        parser.error("--shared-request-interval must be positive")
    if (args.shared_rate_limit_file is None) != (args.shared_request_interval is None):
        parser.error("shared rate limit file and interval must be provided together")
    if args.fetch_limit < 1:
        parser.error("--fetch-limit must be at least 1")
    if not (1 <= args.page_review <= args.page_split <= args.page_ceiling):
        parser.error("page thresholds must satisfy review <= split <= ceiling")
    if args.max_no_progress_pages < 1:
        parser.error("--max-no-progress-pages must be at least 1")
    if not (0 < args.cursor_suffix_reuse_min_ratio < 1):
        parser.error("--cursor-suffix-reuse-min-ratio must be between 0 and 1")
    if not (0 < args.density_safety_factor < 1):
        parser.error("--density-safety-factor must be between 0 and 1")
    if args.boundary_overlap_seconds < 1:
        parser.error("--boundary-overlap-seconds must be at least 1")
    if args.min_window_seconds < 1:
        parser.error("--min-window-seconds must be at least 1")
    if args.max_requests is not None and args.max_requests < 1:
        parser.error("--max-requests must be at least 1")
    if args.max_estimated_cost_usd is not None and args.max_estimated_cost_usd <= 0:
        parser.error("--max-estimated-cost-usd must be positive")
    if args.request_interval < 0:
        parser.error("--request-interval cannot be negative")
    if (args.single_window_start is None) != (args.single_window_end is None):
        parser.error("single-window start and end must be supplied together")
    if (
        args.single_window_start is not None
        and args.single_window_start >= args.single_window_end
    ):
        parser.error("single-window start must be before end")
    return args


def run_single_window(
    args: argparse.Namespace,
    username: str,
    client: TwitterApiIoClient,
    profile: dict[str, Any],
) -> int:
    window = Window(args.single_window_start, args.single_window_end)
    result = client.fetch("single_window", window)
    if result.status == "UNKNOWN":
        raise PrototypeFailure(result.error or "single-window request failed")
    posts = sorted(result.posts, key=lambda post: (post.created_at, int(post.post_id)))
    payload = {
        "schema_version": 1,
        "experiment": "twitterapi_io_single_window",
        "coverage_assurance": "OBSERVED_CURSOR_EXHAUSTION_OR_HEURISTIC_PROBE",
        "username": username,
        "profile": profile_json(profile),
        "window": result.event_json(),
        "posts": [
            post_json(
                Candidate(
                    post=post,
                    seen_in_resolved_window=result.status == "RESOLVED",
                )
            )
            for post in posts
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\nTwitterAPI.io single-window measurement finished")
    print(f"Status: {result.status}")
    print(f"Unique post count: {len(posts)}")
    print(f"Has next page: {result.has_next_page} (not used as completeness proof)")
    print(f"Oldest: {iso_epoch(posts[0].created_at) if posts else 'n/a'}")
    print(f"Newest: {iso_epoch(posts[-1].created_at) if posts else 'n/a'}")
    print(f"Requests: {client.request_count}")
    print(f"JSON: {args.output.resolve()}")
    return 0


def run(args: argparse.Namespace) -> int:
    started = time.perf_counter()
    username = normalize_username(args.username)
    args.output = (args.output or default_output(username)).expanduser()
    if args.checkpoint is None and args.single_window_start is None:
        args.checkpoint = args.output.with_suffix(args.output.suffix + ".checkpoint.json")
    if args.progress_output is None and args.single_window_start is None:
        args.progress_output = args.output.with_suffix(args.output.suffix + ".progress.json")
    client = TwitterApiIoClient(args, username)
    profile = client.profile()
    profile_created = profile.get("createdAt")
    if not isinstance(profile_created, str):
        raise PrototypeFailure("profile response has no createdAt")
    if profile.get("protected") is True:
        raise PrototypeFailure("account is protected/private; skipping paid search")
    profile_lower_bound = epoch(parse_datetime(profile_created))
    lower_bound = (
        args.collect_start
        if args.collect_start is not None
        else profile_lower_bound
    )
    if lower_bound < profile_lower_bound:
        raise PrototypeFailure("collect-start cannot precede account creation")
    print(
        f"TwitterAPI.io; @{username}; created={iso_epoch(profile_lower_bound)}; "
        f"collection={args.collection_mode}; lower_bound={iso_epoch(lower_bound)}; "
        f"probe_limit={args.probe_limit}; collect_spans="
        f"page-target={SPLIT_RECOVERY_MAX_DAYS}d-recovery; "
        f"dense_threshold={COLLECT_DENSE_POST_THRESHOLD}; fetch_limit={args.fetch_limit}; "
        f"page_review/split/ceiling="
        f"{args.page_review}/{args.page_split}/{args.page_ceiling}",
        flush=True,
    )

    if args.single_window_start is not None:
        return run_single_window(args, username, client, profile)

    snapshot_end = (
        args.collect_end
        if args.collection_mode == "date_range"
        else epoch(datetime.now(UTC) - timedelta(seconds=args.snapshot_lag_seconds))
    )
    if lower_bound >= snapshot_end:
        raise PrototypeFailure("collect-start must be before the acquisition snapshot")
    experiment = OldestBlockExperiment(
        args, username, client, lower_bound, snapshot_end, profile
    )
    resumed = experiment.restore_checkpoint()
    failure: str | None = None
    try:
        collect_start = experiment.probe_until_collect()
        if collect_start is not None and not experiment.target_reached():
            client._log(f"COLLECT START {iso_epoch(collect_start)}")
            experiment.collect_from(collect_start)
    except PrototypeFailure as exc:
        failure = str(exc)
        client._log(f"STOP INCOMPLETE: {failure}")

    resolved = experiment.resolved_candidates()
    selected = resolved[: args.target_count]
    all_candidates = sorted(
        experiment.candidates.values(),
        key=lambda row: (row.post.created_at, int(row.post.post_id)),
    )
    frontier = experiment.coverage_frontier()
    if failure is None and len(selected) >= args.target_count:
        status = "EXPERIMENTAL_SUCCESS"
    elif failure is None and frontier >= snapshot_end:
        status = "EXPERIMENTAL_ACCOUNT_HAS_LESS_THAN_TARGET"
    else:
        status = "INCOMPLETE"
    elapsed = time.perf_counter() - started
    payload = {
        "schema_version": 1,
        "experiment": "twitterapi_io_oldest_block",
        "coverage_assurance": "OBSERVED_CURSOR_EXHAUSTION_PLUS_HEURISTIC_PROBES",
        "username": username,
        "profile": profile_json(profile),
        "config": {
            "target_count": args.target_count,
            "collection_mode": args.collection_mode,
            "collect_start": iso_epoch(lower_bound),
            "collect_end": iso_epoch(snapshot_end) if args.collection_mode == "date_range" else None,
            "window_days": args.window_days,
            "page_target_pages": experiment._split_target_pages(),
            "probe_limit": args.probe_limit,
            "collect_dense_post_threshold": COLLECT_DENSE_POST_THRESHOLD,
            "fetch_limit": args.fetch_limit,
            "page_review": args.page_review,
            "page_split": args.page_split,
            "page_ceiling": args.page_ceiling,
            "max_no_progress_pages": args.max_no_progress_pages,
            "cursor_suffix_reuse_min_ratio": args.cursor_suffix_reuse_min_ratio,
            "density_safety_factor": args.density_safety_factor,
            "boundary_overlap_seconds": args.boundary_overlap_seconds,
            "min_window_seconds": args.min_window_seconds,
            "max_requests": args.max_requests,
            "max_estimated_cost_usd": args.max_estimated_cost_usd,
        },
        "result": {
            "status": status,
            "error": failure,
            "unique_post_count": len(selected),
            "resolved_prefix_unique_count": len(resolved),
            "coverage_frontier": iso_epoch(frontier),
            "oldest_timestamp": iso_epoch(selected[0].post.created_at) if selected else None,
            "newest_timestamp": iso_epoch(selected[-1].post.created_at) if selected else None,
        },
        "metrics": {
            "total_requests": client.request_count,
            "profile_requests": client.profile_request_count,
            "search_requests": client.search_request_count,
            "total_pages": sum(event.pages for event in client.events),
            "raw_posts_returned": client.raw_posts_returned,
            "probe_count": experiment.probe_count,
            "collect_window_count": experiment.collect_window_count,
            "split_count": experiment.split_count,
            "cursor_suffix_reuse_count": experiment.cursor_suffix_reuse_count,
            "density_split_count": experiment.density_split_count,
            "half_split_count": experiment.half_split_count,
            "collect_span_days_at_stop": math.ceil(
                experiment.collect_span_seconds / SECONDS_PER_DAY
            ),
            "collect_span_seconds_at_stop": experiment.collect_span_seconds,
            "adaptive_reset_to_7_count": experiment.adaptive_reset_to_7_count,
            "probe_reentry_count": experiment.probe_reentry_count,
            "empty_resolved_streak_at_stop": experiment.empty_resolved_streak,
            "discarded_parent_post_count": experiment.discarded_parent_post_count,
            "candidate_unique_count": len(experiment.candidates),
            "duplicate_sightings": experiment.duplicate_sightings,
            "resolved_window_count": len(experiment.resolved_intervals),
            "partial_window_count": sum(
                event.status == "PARTIAL" for event in client.events
            ),
            "unknown_window_count": sum(
                event.status == "UNKNOWN" for event in client.events
            ),
            "cursor_pages": sum(event.cursor_pages for event in client.events),
            "cursor_new_posts": sum(
                event.cursor_new_posts for event in client.events
            ),
            "cursor_repeated_windows": sum(
                event.cursor_repeated for event in client.events
            ),
            "elapsed_seconds": round(elapsed, 3),
            "estimated_cost_usd": round(client.estimated_cost_usd(), 6),
            "resumed_from_checkpoint": resumed,
            "checkpoint_resume_start": (
                iso_epoch(experiment.checkpoint_resume_start)
                if experiment.checkpoint_resume_start is not None
                else None
            ),
        },
        "windows": [event.event_json() for event in client.events],
        "posts": [post_json(row) for row in selected],
        "candidate_posts": [post_json(row) for row in all_candidates],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\nTwitterAPI.io oldest-side measurement finished")
    print(f"Status: {status}")
    if failure:
        print(f"Error: {failure}")
    print(f"Unique post count: {len(selected)}")
    print(f"Candidate unique count: {len(experiment.candidates)}")
    print(f"Requests: {client.request_count}")
    print(f"Estimated provider cost: ${client.estimated_cost_usd():.4f}")
    print(f"Raw posts returned: {client.raw_posts_returned}")
    print(f"Split count: {experiment.split_count}")
    print(f"Oldest: {payload['result']['oldest_timestamp'] or 'n/a'}")
    print(f"Newest: {payload['result']['newest_timestamp'] or 'n/a'}")
    print(f"Elapsed: {elapsed:.2f}s")
    print(f"JSON: {args.output.resolve()}")
    return 0 if status != "INCOMPLETE" else 2


def main() -> int:
    try:
        return run(parse_args())
    except KeyboardInterrupt:
        print("Interrupted", file=sys.stderr)
        return 130
    except PrototypeFailure as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
