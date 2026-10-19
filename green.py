#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
makeGithubgreen -- backdate commits to paint your GitHub contribution graph.

Cross-platform (Windows, macOS, Linux). Python 3.6+, standard library only.
Run it from inside the git repository you want to fill.

Examples:
  python green.py --start 2026-01-01 --end 2026-06-30 --days mon,wed,fri --commits 1-3 --push
  python green.py --days random --commits 2
  python green.py --messages messages.txt
  python green.py --interactive
"""

# ============================================================
#  CONFIGURATION -- defaults used when a flag is not given
# ============================================================

START_DATE = "2026-01-01"        # --start   YYYY-MM-DD
END_DATE = "2026-07-30"          # --end     YYYY-MM-DD
DAYS = "mon,tue,wed,thu,fri"     # --days    e.g. "mon,wed,fri" or "random"
DAYS_PER_WEEK = 5                # how many weekdays get commits when DAYS is "random"
COMMITS = "1"                    # --commits e.g. "3" or a random range like "1-5"
BRANCH = "main"                  # --branch
AUTO_PUSH = False                # --push
GIT_NAME = ""                    # --name    (empty = keep current git config)
GIT_EMAIL = ""                   # --email   (must be an email on your GitHub account)
MESSAGES_FILE = ""               # --messages path to a .txt file, one message per line
LOG_FILE = "activity_log.txt"    # file that gets a new line for every commit
RANDOM_MESSAGES = True           # False -> "chore(<date>): update <LOG_FILE> (entry #n)"
INTERACTIVE_IF_NO_ARGS = True    # prompt for settings when run without any flags

# Built-in message pool (used when no --messages file is given)
MESSAGES = [
    "fix: handle edge case",
    "chore: update activity notes",
    "docs: tweak readme wording",
    "refactor: tidy up module",
    "style: format code",
    "perf: minor optimization",
    "test: extend coverage",
    "build: bump dependency",
    "chore: routine maintenance",
    "fix: correct typo",
    "chore: sync changes",
    "feat: small improvement",
    "fix: guard against empty input",
    "docs: clarify setup steps",
    "refactor: simplify helper",
]

# ==================== END OF CONFIGURATION ====================

import argparse
import datetime
import os
import random
import shutil
import subprocess
import sys

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


class GreenError(Exception):
    """A user-facing error, printed without a traceback."""


# --------------------------- parsing ---------------------------

def parse_date(value, label):
    try:
        return datetime.datetime.strptime(str(value).strip(), "%Y-%m-%d").date()
    except ValueError:
        raise GreenError(f"Invalid {label} date {value!r} -- expected YYYY-MM-DD, e.g. 2026-01-31.")


def parse_days(value):
    """Return a set of weekday numbers (Mon=0 .. Sun=6), or None for random days."""
    text = str(value or "").strip().lower()
    if text == "random":
        return None
    days = set()
    for part in text.replace(" ", "").split(","):
        if not part:
            continue
        key = part[:3]
        if key not in WEEKDAYS:
            raise GreenError(f"Unknown weekday {part!r} -- use mon,tue,wed,thu,fri,sat,sun or 'random'.")
        days.add(WEEKDAYS.index(key))
    if not days:
        raise GreenError("--days needs at least one weekday, e.g. mon,wed,fri (or 'random').")
    return days


def parse_commits(value):
    """Return (low, high) commits per active day."""
    text = str(value).strip()
    try:
        if "-" in text:
            low, high = (int(x) for x in text.split("-", 1))
        else:
            low = high = int(text)
    except ValueError:
        raise GreenError(f"Invalid --commits {value!r} -- use a number like 3 or a range like 1-5.")
    if low < 1 or high < low:
        raise GreenError(f"Invalid --commits {value!r} -- numbers must be >= 1 and min <= max.")
    return low, high


def load_messages(path):
    if not path:
        return list(MESSAGES)
    try:
        with open(path, encoding="utf-8") as fh:
            messages = [line.strip() for line in fh if line.strip()]
    except OSError as exc:
        raise GreenError(f"Could not read messages file {path!r}: {exc.strerror or exc}")
    if not messages:
        print(f"warning: {path} is empty -- using the built-in messages.")
        return list(MESSAGES)
    return messages


# ----------------------------- git -----------------------------

def git(*args, env=None, check=True):
    try:
        result = subprocess.run(
            ["git"] + list(args),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        raise GreenError(f"Could not run git: {exc}")
    if check and result.returncode != 0:
        output = (result.stderr or result.stdout).strip()
        raise GreenError(f"'git {' '.join(args)}' failed:\n{output}")
    return result


def check_git():
    if shutil.which("git") is None:
        raise GreenError(
            "git was not found on your PATH.\n"
            "Install it from https://git-scm.com/downloads, then open a new terminal and try again."
        )
    inside = git("rev-parse", "--is-inside-work-tree", check=False)
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        raise GreenError(
            "This folder is not a git repository.\n"
            "Run 'git init' and 'git remote add origin <url>' first, or cd into your repo."
        )


def ensure_branch(branch):
    current = git("symbolic-ref", "--quiet", "--short", "HEAD", check=False).stdout.strip()
    if current == branch:
        return
    has_commits = git("rev-parse", "--verify", "--quiet", "HEAD", check=False).returncode == 0
    if not has_commits:
        # Fresh repo with no commits yet: just point HEAD at the target branch.
        git("symbolic-ref", "HEAD", "refs/heads/" + branch)
    elif git("rev-parse", "--verify", "--quiet", "refs/heads/" + branch, check=False).returncode == 0:
        git("checkout", "--quiet", branch)
    else:
        git("checkout", "--quiet", "-b", branch)
    print(f"Switched to branch '{branch}'.")


def make_commit(when, index, message, log_file):
    day = when.date()
    stamp = when.strftime("%Y-%m-%dT%H:%M:%S")
    with open(log_file, "a", encoding="utf-8") as fh:
        fh.write(f"[{day.isoformat()}] entry #{index} - {message}\n")
    git("add", "--", log_file)
    env = dict(os.environ, GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)
    git("commit", "--quiet", "--no-verify", "-m", message, env=env)


# --------------------------- planning --------------------------

def build_plan(start, end, fixed_days, per_week, low, high):
    """Return one datetime per commit, in chronological order (09:00-20:59 each day)."""
    plan = []
    week = None
    selected = set()
    day = start
    one_day = datetime.timedelta(days=1)
    while day <= end:
        iso_week = day.isocalendar()[:2]
        if iso_week != week:
            week = iso_week
            selected = fixed_days if fixed_days is not None else set(random.sample(range(7), per_week))
        if day.weekday() in selected:
            seconds = sorted(random.sample(range(9 * 3600, 21 * 3600), random.randint(low, high)))
            midnight = datetime.datetime.combine(day, datetime.time())
            plan.extend(midnight + datetime.timedelta(seconds=sec) for sec in seconds)
        day += one_day
    return plan


# ----------------------------- ui ------------------------------

def bar_chars():
    encoding = getattr(sys.stdout, "encoding", None) or "ascii"
    try:
        "█░".encode(encoding)
        return "█", "░"
    except (LookupError, UnicodeEncodeError):
        return "#", "-"


def print_progress(done, total, chars, width=30):
    full, empty = chars
    ratio = done / total if total else 1.0
    filled = int(round(width * ratio))
    bar = full * filled + empty * (width - filled)
    sys.stdout.write(f"\r[{bar}] {int(ratio * 100):3d}% {done}/{total} commits")
    sys.stdout.flush()


def ask(prompt, default):
    try:
        answer = input(f"{prompt} [{default}]: ").strip()
    except EOFError:
        answer = ""
    return answer or str(default)


def ask_yes_no(prompt, default):
    answer = ask(prompt, "Y/n" if default else "y/N").lower()
    if answer == "y/n":  # Enter pressed: keep the default
        return default
    return answer.startswith("y")


def interactive(args):
    print("makeGithubgreen -- press Enter to keep the value in [brackets].\n")
    args.start = ask("Start date (YYYY-MM-DD)", args.start)
    args.end = ask("End date (YYYY-MM-DD)", args.end)
    args.days = ask("Weekdays (e.g. mon,wed,fri) or 'random'", args.days)
    args.commits = ask("Commits per day (e.g. 3 or 1-5)", args.commits)
    args.branch = ask("Branch", args.branch)
    args.name = ask("git user.name (blank = keep current)", args.name or "")
    args.email = ask("git user.email (blank = keep current)", args.email or "")
    args.messages = ask("Messages file (blank = built-in)", args.messages or "")
    args.push = ask_yes_no("Push when done?", args.push)
    print()


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Backdate commits to paint your GitHub contribution graph green.",
        epilog="Run inside your git repository. Python 3.6+, no extra packages needed.",
    )
    parser.add_argument("--start", default=START_DATE, help="start date, YYYY-MM-DD")
    parser.add_argument("--end", default=END_DATE, help="end date, YYYY-MM-DD")
    parser.add_argument("--days", default=DAYS, help="weekdays to commit, e.g. mon,wed,fri -- or 'random'")
    parser.add_argument("--commits", default=COMMITS, help="commits per active day, e.g. 3 -- or a range like 1-5")
    parser.add_argument("--branch", default=BRANCH, help="target branch (default: " + BRANCH + ")")
    parser.add_argument("--push", action="store_true", default=AUTO_PUSH, help="git push when finished")
    parser.add_argument("--name", default=GIT_NAME, help="override git user.name for this repo")
    parser.add_argument("--email", default=GIT_EMAIL, help="override git user.email for this repo")
    parser.add_argument("--messages", default=MESSAGES_FILE, metavar="FILE",
                        help="text file with one commit message per line")
    parser.add_argument("--interactive", action="store_true", help="prompt for every setting")
    return parser.parse_args(argv)


# ----------------------------- main ----------------------------

def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    args = parse_args(argv)
    if args.interactive or (not argv and INTERACTIVE_IF_NO_ARGS):
        interactive(args)

    start = parse_date(args.start, "start")
    end = parse_date(args.end, "end")
    if start > end:
        raise GreenError(f"Start date {start} is after end date {end}.")
    fixed_days = parse_days(args.days)
    low, high = parse_commits(args.commits)
    per_week = max(1, min(7, int(DAYS_PER_WEEK)))
    messages = load_messages(args.messages) if (args.messages or RANDOM_MESSAGES) else None

    check_git()
    if args.name:
        git("config", "user.name", args.name)
    if args.email:
        git("config", "user.email", args.email)
    ensure_branch(args.branch)

    plan = build_plan(start, end, fixed_days, per_week, low, high)
    total = len(plan)
    if not total:
        print("Nothing to do -- no commit days fall inside that date range.")
        return 0

    print(f"Creating {total} backdated commit(s) from {start} to {end} on '{args.branch}'...")
    chars = bar_chars()
    print_progress(0, total, chars)
    for index, when in enumerate(plan, 1):
        if messages:
            message = random.choice(messages)
        else:
            message = f"chore({when.date().isoformat()}): update {LOG_FILE} (entry #{index})"
        make_commit(when, index, message, LOG_FILE)
        print_progress(index, total, chars)
    print()
    print(f"Done. {total} commit(s) across {len(set(w.date() for w in plan))} active day(s).")

    if args.push:
        print(f"Pushing to origin/{args.branch}...")
        try:
            code = subprocess.call(["git", "push", "-u", "origin", args.branch])
        except OSError as exc:
            raise GreenError(f"Could not run git push: {exc}")
        if code != 0:
            raise GreenError(f"git push failed (exit code {code}). Check your remote and credentials, then run:\n"
                             f"  git push -u origin {args.branch}")
        print("Pushed. Squares should turn green within a few minutes.")
    else:
        print("Squares turn green after pushing:")
        print(f"  git push -u origin {args.branch}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except GreenError as exc:
        print(f"\nerror: {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrupted -- commits created so far are kept.", file=sys.stderr)
        sys.exit(130)
