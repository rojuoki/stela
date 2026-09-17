#!/usr/bin/env python3
"""Run many TwitterAPI.io oldest-post checks with bounded retries.

The batch has one aggregate cost budget. There is no fixed per-account cost
ceiling: aggregate-budget runs pass only the remaining batch budget to the
next sequential worker. A transient failure is retried once; the batch then
moves on so one problematic account cannot block the rest of the survey.
"""

from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
import json
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


UTC = timezone.utc
DEFAULT_ACCOUNTS = (
    "BarackObama",
    "elonmusk",
    "sama",
    "BillGates",
    "tim_cook",
    "SpaceX",
    "Tesla",
    "OpenAI",
    "Google",
    "Microsoft",
    "Apple",
    "YouTube",
    "Netflix",
    "Spotify",
    "Wikipedia",
    "github",
    "nytimes",
    "CNN",
    "BBCWorld",
    "Reuters",
    "AP",
    "WIRED",
    "TechCrunch",
    "TheEconomist",
    "NatGeo",
    "neiltyson",
    "BillNye",
    "naval",
    "MrBeast",
    "realDonaldTrump",
    "TaylorSwift13",
    "Cristiano",
)


@dataclass
class AccountSummary:
    username: str
    status: str
    attempts: int
    exit_codes: list[int]
    unique_posts: int | None = None
    estimated_cost_usd: float = 0.0
    error: str | None = None
    output: str | None = None
    metrics: dict[str, object] | None = None
    termination_reasons: dict[str, int] | None = None
    wall_elapsed_seconds: float = 0.0


def run_account(
    index: int,
    total_accounts: int,
    username: str,
    args: argparse.Namespace,
    root: Path,
    runner: Path,
    output_directory: Path,
    shared_rate_limit_file: Path,
    remaining_budget: float | None,
) -> AccountSummary:
    """Run one account without sharing mutable excavation state.

    Cursor pagination inside one account remains sequential. Aggregate-budget
    runs are scheduled one account at a time so the remaining budget can be
    passed as one hard guard without overshooting it.
    """
    account_started = time.perf_counter()
    output = output_directory / f"{username.lower()}.json"
    checkpoint = output.with_suffix(output.suffix + ".checkpoint.json")
    log_path = output.with_suffix(output.suffix + ".log")
    exit_codes: list[int] = []
    status: str | None = None
    unique_posts: int | None = None
    cost = 0.0
    error: str | None = None
    metrics: dict[str, object] | None = None
    termination_reasons: dict[str, int] = {}
    print(f"[{index}/{total_accounts}] @{username} starting", flush=True)

    for attempt in range(1, args.max_retries + 2):
        attempt_budget = None
        if remaining_budget is not None:
            # A retry resumes the checkpoint and therefore must only receive
            # the aggregate budget left after the previous attempt's spend.
            attempt_budget = remaining_budget - cost
            if attempt_budget <= 1e-9:
                break
        command = [
            sys.executable,
            str(runner),
            username,
            "--env-file",
            str((root / args.env_file).resolve()),
            "--output",
            str(output),
            "--checkpoint",
            str(checkpoint),
            "--target-count",
            str(args.target_count),
            "--max-requests",
            str(args.max_requests),
            "--request-interval",
            str(args.request_interval),
            "--shared-rate-limit-file",
            str(shared_rate_limit_file),
            "--shared-request-interval",
            str(1.0 / args.provider_request_rate),
            "--quiet",
        ]
        if attempt_budget is not None:
            command.extend(["--max-estimated-cost-usd", str(attempt_budget)])
        completed = subprocess.run(
            command,
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
        exit_codes.append(completed.returncode)
        log_path.write_text(
            f"attempt={attempt} exit_code={completed.returncode}\n{completed.stdout}",
            encoding="utf-8",
        )
        (
            status,
            unique_posts,
            cost,
            error,
            metrics,
            termination_reasons,
        ) = read_result(output, checkpoint)
        if completed.returncode == 0 and status is not None:
            break
        if attempt <= args.max_retries:
            print(
                f"[{index}/{total_accounts}] @{username} retrying "
                f"(attempt {attempt + 1})",
                flush=True,
            )

    if status in {"EXPERIMENTAL_SUCCESS", "EXPERIMENTAL_ACCOUNT_HAS_LESS_THAN_TARGET"}:
        final_status = status
    elif status is not None:
        final_status = f"{status}_SKIPPED"
    else:
        final_status = "FAILED"
    summary = AccountSummary(
        username=username,
        status=final_status,
        attempts=len(exit_codes),
        exit_codes=exit_codes,
        unique_posts=unique_posts,
        estimated_cost_usd=cost,
        error=error,
        output=str(output),
        metrics=metrics,
        termination_reasons=termination_reasons,
        wall_elapsed_seconds=round(time.perf_counter() - account_started, 3),
    )
    print(
        f"[{index}/{total_accounts}] @{username} {final_status} "
        f"posts={unique_posts if unique_posts is not None else 'n/a'} "
        f"cost=${cost:.4f}",
        flush=True,
    )
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--accounts",
        nargs="*",
        default=list(DEFAULT_ACCOUNTS),
        help="usernames to check; defaults to a broad public-account sample",
    )
    parser.add_argument("--target-count", type=int, default=100)
    parser.add_argument(
        "--total-cost-limit",
        type=float,
        default=None,
        help="aggregate estimated provider spend ceiling for the whole batch",
    )
    parser.add_argument("--max-requests", type=int, default=100)
    parser.add_argument("--request-interval", type=float, default=0.7)
    parser.add_argument(
        "--concurrency",
        type=int,
        default=4,
        help="number of accounts to excavate concurrently (default: 4)",
    )
    parser.add_argument(
        "--provider-request-rate",
        type=float,
        default=6.0,
        help="shared maximum request-start rate across account workers",
    )
    parser.add_argument(
        "--output-directory",
        type=Path,
        default=Path("results/twitterapi-io-batch"),
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=1,
        help="additional attempts after the first failure (default: 1)",
    )
    parser.add_argument("--runner", type=Path, default=Path("scripts/measure_twitterapi_io_1000.py"))
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    args = parser.parse_args()
    if (
        args.target_count < 1
        or args.max_requests < 1
        or (args.total_cost_limit is not None and args.total_cost_limit <= 0)
    ):
        parser.error("target count and max requests must be positive")
    if args.max_retries < 0:
        parser.error("max retries cannot be negative")
    if args.concurrency < 1:
        parser.error("concurrency must be at least 1")
    if args.provider_request_rate <= 0:
        parser.error("provider request rate must be positive")
    return args


def read_result(
    path: Path,
    checkpoint_path: Path | None = None,
) -> tuple[
    str | None,
    int | None,
    float,
    str | None,
    dict[str, object] | None,
    dict[str, int],
]:
    if not path.exists():
        if checkpoint_path is not None and checkpoint_path.exists():
            try:
                checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                checkpoint = None
            if isinstance(checkpoint, dict):
                counters = checkpoint.get("counters")
                counters = counters if isinstance(counters, dict) else {}
                candidates = checkpoint.get("candidates")
                candidates = candidates if isinstance(candidates, list) else []
                raw_posts = counters.get("raw_posts_returned", 0)
                search_requests = counters.get("search_request_count", 0)
                profile_requests = counters.get("profile_request_count", 0)
                try:
                    estimated_cost = (
                        max(float(raw_posts), float(search_requests)) * 0.00015
                        + float(profile_requests) * 0.00018
                    )
                except (TypeError, ValueError):
                    estimated_cost = 0.0
                termination_reasons: dict[str, int] = {}
                windows = checkpoint.get("windows")
                if isinstance(windows, list):
                    for window in windows:
                        if not isinstance(window, dict):
                            continue
                        reason = window.get("termination_reason")
                        if isinstance(reason, str):
                            termination_reasons[reason] = termination_reasons.get(reason, 0) + 1
                metrics = {
                    "total_requests": counters.get("request_count", 0),
                    "profile_requests": counters.get("profile_request_count", 0),
                    "search_requests": counters.get("search_request_count", 0),
                    "raw_posts_returned": counters.get("raw_posts_returned", 0),
                    "duplicate_sightings": counters.get("duplicate_sightings", 0),
                    "candidate_unique_count": len(candidates),
                    "adaptive_step_to_30_count": counters.get(
                        "adaptive_step_to_30_count", 0
                    ),
                    "adaptive_step_to_120_count": counters.get(
                        "adaptive_step_to_120_count", 0
                    ),
                    "adaptive_step_to_year_end_count": counters.get(
                        "adaptive_step_to_year_end_count", 0
                    ),
                    "adaptive_keep_dense_count": counters.get(
                        "adaptive_keep_dense_count", 0
                    ),
                    "adaptive_reset_to_7_count": counters.get(
                        "adaptive_reset_to_7_count", 0
                    ),
                    "discarded_parent_post_count": counters.get(
                        "discarded_parent_post_count", 0
                    ),
                }
                if isinstance(windows, list):
                    metrics["resolved_window_count"] = sum(
                        isinstance(window, dict) and window.get("status") == "RESOLVED"
                        for window in windows
                    )
                    metrics["partial_window_count"] = sum(
                        isinstance(window, dict) and window.get("status") == "PARTIAL"
                        for window in windows
                    )
                    metrics["unknown_window_count"] = sum(
                        isinstance(window, dict) and window.get("status") == "UNKNOWN"
                        for window in windows
                    )
                metrics["estimated_cost_usd"] = round(estimated_cost, 6)
                return (
                    "INCOMPLETE_CHECKPOINT",
                    len(candidates),
                    estimated_cost,
                    "no final result; checkpoint preserved",
                    metrics,
                    termination_reasons,
                )
        return None, None, 0.0, None, None, {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, None, 0.0, "result JSON could not be read", None, {}
    result = payload.get("result") if isinstance(payload, dict) else None
    metrics = payload.get("metrics") if isinstance(payload, dict) else None
    if not isinstance(result, dict):
        return None, None, 0.0, "result JSON has no result object", None, {}
    status = result.get("status") if isinstance(result.get("status"), str) else None
    unique_posts = result.get("unique_post_count")
    unique_posts = int(unique_posts) if isinstance(unique_posts, int) else None
    cost = metrics.get("estimated_cost_usd", 0.0) if isinstance(metrics, dict) else 0.0
    try:
        cost = float(cost)
    except (TypeError, ValueError):
        cost = 0.0
    error = result.get("error") if isinstance(result.get("error"), str) else None
    metric_keys = (
        "total_requests",
        "profile_requests",
        "search_requests",
        "raw_posts_returned",
        "candidate_unique_count",
        "duplicate_sightings",
        "resolved_window_count",
        "partial_window_count",
        "unknown_window_count",
        "cursor_pages",
        "cursor_new_posts",
        "probe_reentry_count",
        "split_count",
        "density_split_count",
        "half_split_count",
        "adaptive_step_to_30_count",
        "adaptive_step_to_120_count",
        "adaptive_step_to_year_end_count",
        "adaptive_keep_dense_count",
        "adaptive_reset_to_7_count",
        "discarded_parent_post_count",
        "elapsed_seconds",
        "estimated_cost_usd",
    )
    selected_metrics = {
        key: metrics[key]
        for key in metric_keys
        if isinstance(metrics, dict) and key in metrics
    }
    termination_reasons: dict[str, int] = {}
    windows = payload.get("windows") if isinstance(payload, dict) else None
    if isinstance(windows, list):
        for window in windows:
            if not isinstance(window, dict):
                continue
            reason = window.get("termination_reason")
            if isinstance(reason, str):
                termination_reasons[reason] = termination_reasons.get(reason, 0) + 1
    return status, unique_posts, cost, error, selected_metrics, termination_reasons


def main() -> int:
    batch_started = time.perf_counter()
    args = parse_args()
    root = Path.cwd()
    runner = (root / args.runner).resolve()
    output_directory = (root / args.output_directory).resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    summaries: list[AccountSummary] = []
    total_estimated_cost = 0.0
    shared_rate_limit_file = output_directory / ".twitterapi-io-rate-limit"
    pending_index = 0
    reserved_cost = 0.0
    futures: dict[Future[AccountSummary], tuple[int, float | None]] = {}

    # A shared aggregate budget cannot be enforced safely by independently
    # running several children: all of them could spend the old balance before
    # the parent observes their results. Keep explicit aggregate-budget mode
    # sequential. The no-budget mode retains configurable concurrency.
    effective_concurrency = 1 if args.total_cost_limit is not None else args.concurrency

    with ThreadPoolExecutor(max_workers=effective_concurrency) as executor:
        while pending_index < len(args.accounts) or futures:
            while pending_index < len(args.accounts) and len(futures) < effective_concurrency:
                username = args.accounts[pending_index]
                remaining_budget = None
                if args.total_cost_limit is not None:
                    remaining_budget = args.total_cost_limit - total_estimated_cost
                    if remaining_budget <= 1e-9:
                        print(
                            f"BATCH COST STOP before @{username}: aggregate budget "
                            f"${args.total_cost_limit:.2f} exhausted "
                            f"(spent=${total_estimated_cost:.4f})",
                            flush=True,
                        )
                        pending_index = len(args.accounts)
                        break
                future = executor.submit(
                    run_account,
                    pending_index + 1,
                    len(args.accounts),
                    username,
                    args,
                    root,
                    runner,
                    output_directory,
                    shared_rate_limit_file,
                    remaining_budget,
                )
                futures[future] = (pending_index, remaining_budget)
                pending_index += 1

            if not futures:
                break
            completed_future = next(as_completed(futures))
            _, reservation = futures.pop(completed_future)
            summary = completed_future.result()
            summaries.append(summary)
            total_estimated_cost += summary.estimated_cost_usd

    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    batch_elapsed_seconds = round(time.perf_counter() - batch_started, 3)
    summary_path = output_directory / f"batch-summary-{stamp}.json"
    summary_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "target_count": args.target_count,
                "adaptive_policy": "page-target-with-probe-reentry",
                "total_cost_limit": args.total_cost_limit,
                "concurrency": effective_concurrency,
                "provider_request_rate": args.provider_request_rate,
                "request_interval": args.request_interval,
                "batch_elapsed_seconds": batch_elapsed_seconds,
                "accounts": [summary.__dict__ for summary in summaries],
                "total_estimated_cost_usd": round(total_estimated_cost, 6),
                "aggregate": {
                    "status_counts": {
                        status: sum(summary.status == status for summary in summaries)
                        for status in sorted({summary.status for summary in summaries})
                    },
                    "metric_totals": {
                        key: sum(
                            float(summary.metrics.get(key, 0))
                            for summary in summaries
                            if summary.metrics is not None
                            and isinstance(summary.metrics.get(key, 0), (int, float))
                        )
                        for key in (
                            "total_requests",
                            "raw_posts_returned",
                            "candidate_unique_count",
                            "duplicate_sightings",
                            "resolved_window_count",
                            "partial_window_count",
                            "unknown_window_count",
                            "cursor_pages",
                            "cursor_new_posts",
                            "probe_reentry_count",
                            "split_count",
                            "density_split_count",
                            "half_split_count",
                            "adaptive_step_to_30_count",
                            "adaptive_step_to_120_count",
                            "adaptive_step_to_year_end_count",
                            "adaptive_keep_dense_count",
                            "adaptive_reset_to_7_count",
                            "discarded_parent_post_count",
                            "elapsed_seconds",
                        )
                    },
                    "termination_reason_counts": {
                        reason: sum(
                            summary.termination_reasons.get(reason, 0)
                            for summary in summaries
                            if summary.termination_reasons is not None
                        )
                        for reason in sorted(
                            {
                                reason
                                for summary in summaries
                                if summary.termination_reasons is not None
                                for reason in summary.termination_reasons
                            }
                        )
                    },
                },
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    succeeded = sum(
        summary.status
        in {"EXPERIMENTAL_SUCCESS", "EXPERIMENTAL_ACCOUNT_HAS_LESS_THAN_TARGET"}
        for summary in summaries
    )
    print(
        f"BATCH DONE accounts={len(summaries)} succeeded={succeeded} "
        f"estimated_cost=${total_estimated_cost:.4f} "
        f"elapsed={batch_elapsed_seconds:.2f}s "
        f"summary={summary_path}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
