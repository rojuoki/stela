#!/usr/bin/env python3
"""Offline fixture checks for the TwitterAPI.io checkpoint resume path."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from argparse import Namespace
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "scripts" / "measure_twitterapi_io_1000.py"
CHECKPOINT_PATH = ROOT / "results" / "twitterapi-io-1000" / "benchmark-nasa.json.checkpoint.json"


def load_runner():
    spec = importlib.util.spec_from_file_location("twitterapi_io_runner", RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError("could not load runner module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FixtureClient:
    def __init__(self, runner) -> None:
        self.runner = runner
        self.events = []
        self.request_count = 0
        self.profile_request_count = 0
        self.search_request_count = 0
        self.raw_posts_returned = 0
        self.calls = []
        self.posts_per_window = 1

    def _log(self, _message: str) -> None:
        pass

    def pages_for_window(self, window) -> int:
        return 1

    def fetch(self, purpose, window):
        self.calls.append((purpose, window))
        pages = self.pages_for_window(window)
        posts = []
        for index in range(self.posts_per_window):
            post_id = f"999999999999{len(self.calls):04d}{index:03d}"
            posts.append(
                self.runner.NormalizedPost(
                    post_id=post_id,
                    account_id="fixture-account",
                    author_username="nasa",
                    created_at=window.start + index + 1,
                    text="fixture post",
                    url=f"https://x.com/nasa/status/{post_id}",
                    language="en",
                    reply_count=0,
                    retweet_count=0,
                    like_count=0,
                    quote_count=0,
                    view_count=0,
                    conversation_id=None,
                    in_reply_to_post_id=None,
                    in_reply_to_user_id=None,
                    in_reply_to_username=None,
                    mentions=(),
                    media=(),
                )
            )
        self.request_count += pages
        self.search_request_count += pages
        self.raw_posts_returned += len(posts)
        return self.runner.WindowResult(
            purpose=purpose,
            window=window,
            status="RESOLVED",
            termination_reason="natural_cursor_exhaustion",
            posts=posts,
            requests=pages,
            pages=pages,
            raw_post_count=len(posts),
            first_page_raw_post_count=len(posts),
            has_next_page=False,
            resolution_basis="fixture",
        )


class ParentDiscardFixtureClient(FixtureClient):
    def fetch(self, purpose, window):
        if not self.calls:
            self.calls.append((purpose, window))
            posts = []
            for index in range(2):
                post_id = f"parent-{index}"
                posts.append(
                    self.runner.NormalizedPost(
                        post_id=post_id,
                        account_id="fixture-account",
                        author_username="nasa",
                        created_at=window.start + index + 1,
                        text="parent fixture post",
                        url=f"https://x.com/nasa/status/{post_id}",
                        language="en",
                        reply_count=0,
                        retweet_count=0,
                        like_count=0,
                        quote_count=0,
                        view_count=0,
                        conversation_id=None,
                        in_reply_to_post_id=None,
                        in_reply_to_user_id=None,
                        in_reply_to_username=None,
                        mentions=(),
                        media=(),
                    )
                )
            self.request_count += 20
            self.search_request_count += 20
            self.raw_posts_returned += 2
            return self.runner.WindowResult(
                purpose=purpose,
                window=window,
                status="PARTIAL",
                termination_reason="page_split",
                posts=posts,
                requests=20,
                pages=20,
                raw_post_count=2,
                first_page_raw_post_count=1,
                has_next_page=True,
                next_cursor_present=True,
                cursor_remaining=True,
                oldest_observed_timestamp=window.start + window.width_seconds // 2,
                newest_observed_timestamp=window.end - 1,
                cursor_progress_seconds=window.width_seconds // 2,
            )
        return super().fetch(purpose, window)


class SplitRecoveryFixtureClient(FixtureClient):
    """A dense parent followed by sparse children with measurable page cost."""

    def fetch(self, purpose, window):
        if not self.calls:
            self.calls.append((purpose, window))
            self.request_count += 20
            self.search_request_count += 20
            return self.runner.WindowResult(
                purpose=purpose,
                window=window,
                status="PARTIAL",
                termination_reason="page_split",
                posts=[],
                requests=20,
                pages=20,
                raw_post_count=0,
                first_page_raw_post_count=0,
                has_next_page=True,
                next_cursor_present=True,
                cursor_remaining=True,
                oldest_observed_timestamp=window.end - 2 * 24 * 60 * 60,
                newest_observed_timestamp=window.end - 1,
                cursor_progress_seconds=2 * 24 * 60 * 60,
            )

        result = super().fetch(purpose, window)
        # Two API pages for a roughly one-day child make the next estimate
        # expand to the seven-day recovery cap.
        self.request_count += 1
        self.search_request_count += 1
        result.requests = 2
        result.pages = 2
        return result


class GapReentryFixtureClient(FixtureClient):
    """Repeated empty collects that find activity through year/month probes."""

    def __init__(self, runner) -> None:
        super().__init__(runner)
        self.empty_collects = 0

    def fetch(self, purpose, window):
        if purpose == "collect" and self.empty_collects < 2:
            self.empty_collects += 1
            self.calls.append((purpose, window))
            self.request_count += 1
            self.search_request_count += 1
            return self.runner.WindowResult(
                purpose=purpose,
                window=window,
                status="RESOLVED",
                termination_reason="natural_cursor_exhaustion",
                posts=[],
                requests=1,
                pages=1,
                raw_post_count=0,
                first_page_raw_post_count=0,
                has_next_page=False,
                resolution_basis="fixture-empty",
            )
        if purpose == "collect":
            return super().fetch(purpose, window)
        self.calls.append((purpose, window))
        if purpose == "probe_year":
            self.request_count += 1
            self.search_request_count += 1
            return self.runner.WindowResult(
                purpose=purpose,
                window=window,
                status="PARTIAL",
                termination_reason="probe_threshold",
                posts=[],
                requests=1,
                pages=1,
                raw_post_count=0,
                first_page_raw_post_count=0,
                has_next_page=True,
                next_cursor_present=True,
                cursor_remaining=True,
                resolution_basis="fixture-year-active",
            )
        if purpose == "probe_month":
            self.request_count += 1
            self.search_request_count += 1
            return self.runner.WindowResult(
                purpose=purpose,
                window=window,
                status="PARTIAL",
                termination_reason="probe_threshold",
                posts=[],
                requests=1,
                pages=1,
                raw_post_count=0,
                first_page_raw_post_count=0,
                has_next_page=True,
                next_cursor_present=True,
                cursor_remaining=True,
                resolution_basis="fixture-month-active",
            )
        return super().fetch(purpose, window)


class DenseFixtureClient(FixtureClient):
    def __init__(self, runner) -> None:
        super().__init__(runner)
        self.posts_per_window = 100


def make_args(checkpoint: Path) -> Namespace:
    return Namespace(
        checkpoint=checkpoint,
        target_count=297,
        window_days=7,
        probe_limit=10,
        fetch_limit=1000,
        page_review=10,
        page_split=20,
        page_ceiling=30,
        max_no_progress_pages=3,
        cursor_suffix_reuse_min_ratio=5 / 7,
        density_safety_factor=0.6,
        boundary_overlap_seconds=60,
        min_window_seconds=1,
        max_requests=500,
        quiet=True,
        progress_output=checkpoint.with_suffix(".progress.json"),
    )


def main() -> int:
    runner = load_runner()
    with tempfile.TemporaryDirectory(prefix="stela-resume-fixture-") as directory:
        checkpoint = Path(directory) / "nasa.checkpoint.json"
        current = json.loads(CHECKPOINT_PATH.read_text(encoding="utf-8"))
        resume_boundary = "2008-05-15T00:00:00Z"
        original = dict(current)
        original["schema_version"] = 1
        original["candidates"] = [
            row
            for row in current["candidates"]
            if row["created_at"] < resume_boundary
        ]
        original["resolved_intervals"] = current["resolved_intervals"][:24]
        original["windows"] = current["windows"][:25]
        original["counters"] = {
            "probe_count": 2,
            "collect_window_count": 24,
            "split_count": 0,
            "cursor_suffix_reuse_count": 0,
            "density_split_count": 0,
            "half_split_count": 0,
            "duplicate_sightings": 32,
        }
        original.pop("resume", None)
        assert len(original["candidates"]) == 296
        checkpoint.write_text(json.dumps(original), encoding="utf-8")
        client = FixtureClient(runner)
        lower_bound = runner.epoch(runner.parse_datetime(original["lower_bound"]))
        snapshot_end = runner.epoch(runner.parse_datetime(original["snapshot_end"]))
        experiment = runner.OldestBlockExperiment(
            make_args(checkpoint), "nasa", client, lower_bound, snapshot_end
        )

        assert experiment.restore_checkpoint() is True
        assert len(experiment.candidates) == 296
        assert experiment.coverage_frontier() == runner.epoch(
            runner.parse_datetime("2008-05-15T00:00:00Z")
        )
        resume_start = experiment.probe_until_collect()
        assert resume_start == experiment.coverage_frontier()
        assert experiment.checkpoint_resume_start == resume_start

        experiment.collect_from(resume_start)
        assert len(client.calls) == 1, client.calls
        purpose, window = client.calls[0]
        assert purpose == "collect"
        assert window.start == resume_start
        assert len(experiment.candidates) == 297

        saved = json.loads(checkpoint.read_text(encoding="utf-8"))
        assert saved["schema_version"] == 3
        assert saved["resume"]["phase"] == "collect"
        assert saved["resume"]["next_collect_start"] == "2008-05-22T00:00:00Z"
        assert all(call_window.start >= resume_start for _, call_window in client.calls)
        progress = json.loads(
            make_args(checkpoint).progress_output.read_text(encoding="utf-8")
        )
        assert progress["result"]["status"] == "IN_PROGRESS"
        assert progress["result"]["unique_post_count"] == 297
        assert progress["candidate_posts"]

        sparse_checkpoint = Path(directory) / "sparse.checkpoint.json"
        sparse_args = make_args(sparse_checkpoint)
        sparse_args.target_count = 3
        sparse_client = FixtureClient(runner)
        sparse_start = runner.epoch(
            runner.parse_datetime("2008-05-01T00:00:00Z")
        )
        sparse_end = runner.epoch(
            runner.parse_datetime("2009-02-01T00:00:00Z")
        )
        sparse_experiment = runner.OldestBlockExperiment(
            sparse_args,
            "nasa",
            sparse_client,
            sparse_start,
            sparse_end,
        )
        sparse_experiment.collect_from(sparse_start)
        assert len(sparse_experiment.candidates) == 3, (
            len(sparse_experiment.candidates),
            sparse_client.calls,
        )
        assert len(sparse_client.calls) == 3, sparse_client.calls
        assert sparse_client.calls[0][1].width_seconds == 7 * 24 * 60 * 60
        assert sparse_client.calls[1][1].width_seconds == 84 * 24 * 60 * 60
        assert sparse_client.calls[2][1].end == sparse_end

        dense_checkpoint = Path(directory) / "dense.checkpoint.json"
        dense_args = make_args(dense_checkpoint)
        dense_args.target_count = 101
        dense_client = DenseFixtureClient(runner)
        dense_start = runner.epoch(
            runner.parse_datetime("2008-05-01T00:00:00Z")
        )
        dense_experiment = runner.OldestBlockExperiment(
            dense_args,
            "nasa",
            dense_client,
            dense_start,
            sparse_end,
        )
        dense_experiment.collect_from(dense_start)
        assert len(dense_client.calls) == 2, dense_client.calls
        assert dense_client.calls[0][1].width_seconds == 7 * 24 * 60 * 60
        assert dense_client.calls[1][1].width_seconds == 84 * 24 * 60 * 60

        discard_checkpoint = Path(directory) / "discard-parent.checkpoint.json"
        discard_args = make_args(discard_checkpoint)
        discard_args.target_count = 2
        discard_client = ParentDiscardFixtureClient(runner)
        discard_start = runner.epoch(
            runner.parse_datetime("2008-05-01T00:00:00Z")
        )
        discard_end = runner.epoch(
            runner.parse_datetime("2008-05-15T00:00:00Z")
        )
        discard_experiment = runner.OldestBlockExperiment(
            discard_args,
            "nasa",
            discard_client,
            discard_start,
            discard_end,
        )
        assert discard_experiment.resolve_collect_window(
            runner.Window(discard_start, discard_end), depth=0
        ) is True
        assert discard_experiment.split_count == 1
        assert discard_experiment.discarded_parent_post_count == 2
        assert "parent-0" not in discard_experiment.candidates
        assert "parent-1" not in discard_experiment.candidates
        assert len(discard_experiment.resolved_candidates()) == 2

        recovery_checkpoint = Path(directory) / "split-recovery.checkpoint.json"
        recovery_args = make_args(recovery_checkpoint)
        recovery_args.target_count = 100
        recovery_client = SplitRecoveryFixtureClient(runner)
        recovery_start = runner.epoch(
            runner.parse_datetime("2008-05-01T00:00:00Z")
        )
        recovery_end = runner.epoch(
            runner.parse_datetime("2008-06-01T00:00:00Z")
        )
        recovery_experiment = runner.OldestBlockExperiment(
            recovery_args,
            "nasa",
            recovery_client,
            recovery_start,
            recovery_end,
        )
        assert recovery_experiment.resolve_collect_window(
            runner.Window(recovery_start, recovery_end), depth=0
        ) is True
        assert len(recovery_client.calls) == 7, recovery_client.calls
        _, first_child = recovery_client.calls[1]
        _, second_child = recovery_client.calls[2]
        assert first_child.start == recovery_start
        assert second_child.start == first_child.end
        assert first_child.width_seconds == int(2 * 24 * 60 * 60 * 12 / 20)
        assert second_child.width_seconds == 7 * 24 * 60 * 60
        assert recovery_experiment.last_collect_used_split is True
        resolved_children = sorted(
            [window for purpose, window in recovery_client.calls[1:]
             if purpose == "collect"],
            key=lambda window: window.start,
        )
        coverage_cursor = recovery_start
        for child in resolved_children:
            assert child.start == coverage_cursor, (coverage_cursor, child)
            coverage_cursor = child.end
        assert coverage_cursor == recovery_end

        gap_checkpoint = Path(directory) / "gap-reentry.checkpoint.json"
        gap_args = make_args(gap_checkpoint)
        gap_args.window_days = 1
        gap_args.target_count = 1
        gap_client = GapReentryFixtureClient(runner)
        gap_start = runner.epoch(runner.parse_datetime("2008-05-01T00:00:00Z"))
        gap_end = runner.epoch(runner.parse_datetime("2008-06-01T00:00:00Z"))
        gap_experiment = runner.OldestBlockExperiment(
            gap_args, "nasa", gap_client, gap_start, gap_end
        )
        gap_experiment.collect_from(gap_start)
        collect_calls = [window for purpose, window in gap_client.calls if purpose == "collect"]
        assert len(collect_calls) == 3, gap_client.calls
        assert collect_calls[1].start == collect_calls[0].end
        assert gap_experiment.probe_reentry_count == 1
        assert len(
            [purpose for purpose, _ in gap_client.calls if purpose == "probe_year"]
        ) == 1, gap_client.calls

    print(
        "twitterapi.io resume fixture: PASS "
        "(296 restored; page-target adaptive; split parent discarded)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
