'use strict';

const DEFAULT_MSGS = [
  'fix: handle edge case',
  'chore: update activity notes',
  'docs: tweak readme wording',
  'refactor: tidy up module',
  'style: format code',
  'perf: minor optimization',
  'test: extend coverage',
  'build: bump dependency',
  'chore: routine maintenance',
  'fix: correct typo',
  'chore: sync changes',
  'feat: small improvement',
  'fix: guard against empty input',
  'docs: clarify setup steps',
  'refactor: simplify helper'
];

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PRESET_KEY = 'mgg-preset';
const PRESET_FIELDS = [
  'startDate', 'endDate', 'freqSlider', 'randomDays', 'randomCount', 'minPerDay',
  'maxPerDay', 'randomMsgs', 'msgPool', 'logFile', 'branch', 'userName', 'userEmail', 'autoPush'
];
const CHIP_ORDER = [1, 2, 3, 4, 5, 6, 0];
const FREQ_DESC = [
  'barely active',
  'a couple of days a week',
  'a few days a week',
  'fairly active',
  'like a normal work week',
  'almost every day',
  'every single day — full green'
];
const MAX_PREVIEW_COLS = 53;

// Everything below the configuration block of green.py, kept in sync with that file.
const PY_BODY = String.raw`# ==================== END OF CONFIGURATION ====================

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


def make_commit(day, index, message, log_file):
    stamp = datetime.datetime.combine(
        day, datetime.time(random.randint(9, 20), random.randint(0, 59), random.randint(0, 59))
    ).strftime("%Y-%m-%dT%H:%M:%S")
    with open(log_file, "a", encoding="utf-8") as fh:
        fh.write(f"[{day.isoformat()}] entry #{index} - {message}\n")
    git("add", "--", log_file)
    env = dict(os.environ, GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)
    git("commit", "--quiet", "--no-verify", "-m", message, env=env)


# --------------------------- planning --------------------------

def build_plan(start, end, fixed_days, per_week, low, high):
    """Return one date per commit, in chronological order."""
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
            plan.extend([day] * random.randint(low, high))
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
    for index, day in enumerate(plan, 1):
        if messages:
            message = random.choice(messages)
        else:
            message = f"chore({day.isoformat()}): update {LOG_FILE} (entry #{index})"
        make_commit(day, index, message, LOG_FILE)
        print_progress(index, total, chars)
    print()
    print(f"Done. {total} commit(s) across {len(set(plan))} active day(s).")

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
`;

const state = {
  seed: (Math.random() * 2147483647) | 0,
  script: ''
};

function $(id) {
  return document.getElementById(id);
}

function parseDateVal(v) {
  if (!v) return null;
  const d = new Date(v + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickRandomDays(rng, n) {
  const set = new Set();
  n = Math.max(0, Math.min(7, n | 0));
  let guard = 0;
  while (set.size < n && guard < 500) {
    set.add(Math.floor(rng() * 7));
    guard++;
  }
  return set;
}

function pyStr(s) {
  return JSON.stringify(String(s));
}

function pyBool(b) {
  return b ? 'True' : 'False';
}

function clampInt(v, lo, hi, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : Math.max(lo, Math.min(hi, n));
}

function readConfig() {
  return {
    start: $('startDate').value,
    end: $('endDate').value,
    perWeek: parseInt($('freqSlider').value, 10),
    weekdays: Array.from(document.querySelectorAll('#dayChips .chip.on'))
      .map(c => parseInt(c.dataset.dow, 10)),
    randomDays: $('randomDays').checked,
    randomCommits: $('randomCount').checked,
    minPerDay: clampInt($('minPerDay').value, 1, 50, 1),
    maxPerDay: Math.max(clampInt($('minPerDay').value, 1, 50, 1), clampInt($('maxPerDay').value, 1, 50, 5)),
    randomMsgs: $('randomMsgs').checked,
    messages: $('msgPool').value.split('\n').map(s => s.trim()).filter(Boolean),
    logFile: $('logFile').value.trim() || 'activity_log.txt',
    branch: $('branch').value.trim() || 'main',
    userName: $('userName').value.trim(),
    userEmail: $('userEmail').value.trim(),
    autoPush: $('autoPush').checked
  };
}

function configValid(cfg) {
  const s = parseDateVal(cfg.start);
  const e = parseDateVal(cfg.end);
  return !!(s && e && s <= e);
}

function renderPreview(cfg) {
  const grid = $('graphGrid');
  const monthsEl = $('graphMonths');
  const statsEl = $('stats');
  grid.innerHTML = '';
  monthsEl.innerHTML = '';

  const start = parseDateVal(cfg.start);
  const end = parseDateVal(cfg.end);

  if (!configValid(cfg)) {
    $('dateError').textContent = 'Pick a valid range — start date must be on or before end date.';
    statsEl.textContent = '';
    return { totalCommits: 0, activeDays: 0, weeks: 0, capped: false };
  }
  $('dateError').textContent = '';

  const firstSun = new Date(start);
  firstSun.setDate(firstSun.getDate() - firstSun.getDay());

  const rng = mulberry32(state.seed);
  const cells = [];
  const monthByCol = [];
  let selected = new Set(cfg.weekdays);
  let totalCommits = 0;
  let activeDays = 0;
  let col = 0;
  let capped = false;

  const d = new Date(firstSun);
  while (d <= end) {
    if (col >= MAX_PREVIEW_COLS) { capped = true; break; }
    if (d.getDay() === 0) {
      selected = cfg.randomDays
        ? pickRandomDays(rng, cfg.perWeek)
        : new Set(cfg.weekdays);
      monthByCol.push(d.getMonth());
    }
    if (d >= start && selected.has(d.getDay())) {
      const count = cfg.randomCommits
        ? cfg.minPerDay + Math.floor(rng() * (cfg.maxPerDay - cfg.minPerDay + 1))
        : 1;
      activeDays += 1;
      totalCommits += count;
      cells.push({ date: new Date(d), count: count, inRange: true });
    } else {
      cells.push({ date: new Date(d), count: 0, inRange: d >= start });
    }
    if (d.getDay() === 6) col++;
    d.setDate(d.getDate() + 1);
  }

  cells.forEach(c => {
    const el = document.createElement('div');
    let level = 0;
    if (c.count >= 3) level = 4;
    else if (c.count === 2) level = 3;
    else if (c.count === 1) level = 2;
    el.className = 'cell lv' + level;
    if (c.inRange) {
      el.title = (c.count > 0
        ? c.count + ' commit' + (c.count > 1 ? 's' : '')
        : 'No commits') + ' · ' + fmtDate(c.date);
    }
    grid.appendChild(el);
  });

  const starts = [];
  monthByCol.forEach((m, i) => {
    if (i === 0 || m !== monthByCol[i - 1]) starts.push(i);
  });
  starts.forEach((st, idx) => {
    const next = idx + 1 < starts.length ? starts[idx + 1] : monthByCol.length;
    const span = Math.max(1, next - st);
    const s = document.createElement('span');
    s.textContent = new Date(2026, monthByCol[st], 1)
      .toLocaleString('en-US', { month: 'short' });
    s.style.gridColumn = (st + 1) + ' / span ' + span;
    monthsEl.appendChild(s);
  });

  statsEl.textContent = '≈ ' + totalCommits + ' commit' + (totalCommits === 1 ? '' : 's') +
    ' · ' + activeDays + ' active day' + (activeDays === 1 ? '' : 's') +
    ' · ' + monthByCol.length + ' week' + (monthByCol.length === 1 ? '' : 's') +
    (capped ? ' · preview limited to the first year' : '');

  return { totalCommits: totalCommits, activeDays: activeDays, weeks: monthByCol.length, capped: capped };
}

function generateScript(cfg, stats) {
  const today = new Date().toISOString().slice(0, 10);
  const weekdays = (cfg.weekdays.length ? cfg.weekdays : [1])
    .slice()
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const days = cfg.randomDays
    ? 'random'
    : weekdays.map(x => DOW_NAMES[x].toLowerCase()).join(',');
  const commits = cfg.randomCommits
    ? (cfg.minPerDay === cfg.maxPerDay ? String(cfg.minPerDay) : cfg.minPerDay + '-' + cfg.maxPerDay)
    : '1';
  const daysMode = cfg.randomDays
    ? 'random ' + cfg.perWeek + ' weekday(s) each week'
    : 'fixed days: ' + weekdays.map(x => DOW_NAMES[x]).join(', ');
  const countMode = cfg.randomCommits
    ? 'random ' + cfg.minPerDay + '..' + cfg.maxPerDay + ' commit(s) per active day'
    : 'exactly 1 commit per active day';
  const msgMode = cfg.randomMsgs ? 'random messages from pool' : 'conventional messages';
  const pool = (cfg.messages.length ? cfg.messages : DEFAULT_MSGS)
    .map(m => '    ' + pyStr(m) + ',')
    .join('\n');

  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
makeGithubgreen.py -- auto-generated by makeGithubgreen
  Generated : ${today}
  Range     : ${cfg.start} -> ${cfg.end}
  Pattern   : ${cfg.perWeek} commit day(s) / week | ${daysMode}
              ${countMode} | ${msgMode}
  Estimate  : ~${stats.totalCommits} commit(s) across ~${stats.activeDays} active day(s)

HOW TO USE
  1. Place this file inside your git repository (with a remote configured).
  2. Run:  python makeGithubgreen.py      (python3 on some Mac/Linux systems)
  3. Push: git push origin ${cfg.branch}   (or set AUTO_PUSH = True below)

Every setting below can also be overridden with a flag, e.g.
  python makeGithubgreen.py --start 2026-01-01 --days mon,wed,fri --commits 1-3 --push
Run with --help for all options. Works on Windows, macOS and Linux (Python 3.6+).

WHY SQUARES TURN GREEN ON GITHUB
  * Commit email must be one of the emails on your GitHub account.
  * Commits must reach the default branch and be pushed.
  * Repo public (or private contributions enabled in settings).
"""

# ============================================================
#  CONFIGURATION -- defaults used when a flag is not given
# ============================================================

START_DATE = ${pyStr(cfg.start)}        # --start   YYYY-MM-DD
END_DATE = ${pyStr(cfg.end)}          # --end     YYYY-MM-DD
DAYS = ${pyStr(days)}     # --days    e.g. "mon,wed,fri" or "random"
DAYS_PER_WEEK = ${cfg.perWeek}                # how many weekdays get commits when DAYS is "random"
COMMITS = ${pyStr(commits)}                    # --commits e.g. "3" or a random range like "1-5"
BRANCH = ${pyStr(cfg.branch)}                  # --branch
AUTO_PUSH = ${pyBool(cfg.autoPush)}                # --push
GIT_NAME = ${pyStr(cfg.userName)}                    # --name    (empty = keep current git config)
GIT_EMAIL = ${pyStr(cfg.userEmail)}                   # --email   (must be an email on your GitHub account)
MESSAGES_FILE = ""               # --messages path to a .txt file, one message per line
LOG_FILE = ${pyStr(cfg.logFile)}    # file that gets a new line for every commit
RANDOM_MESSAGES = ${pyBool(cfg.randomMsgs)}           # False -> "chore(<date>): update <LOG_FILE> (entry #n)"
INTERACTIVE_IF_NO_ARGS = False   # True -> prompt for settings when run without any flags

# Message pool (used when no --messages file is given)
MESSAGES = [
${pool}
]

` + PY_BODY;
}

function highlight(src) {
  const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let inDoc = false;
  return esc.split('\n').map(line => {
    const quotes = (line.match(/"""/g) || []).length;
    if (inDoc || quotes === 1) {
      if (quotes % 2 === 1) inDoc = !inDoc;
      return '<span class="tk-s">' + line + '</span>';
    }
    if (/^\s*#/.test(line)) return '<span class="tk-c">' + line + '</span>';
    const strs = [];
    let t = line.replace(/("[^"]*"|'[^']*')/g, m => {
      strs.push('<span class="tk-s">' + m + '</span>');
      return '\x00' + (strs.length - 1) + '\x00';
    });
    const hash = t.indexOf('#');
    let tail = '';
    if (hash !== -1) {
      tail = '<span class="tk-c">' + t.slice(hash) + '</span>';
      t = t.slice(0, hash);
    }
    t = t.replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, m => '\x01V' + m + '\x02');
    t = t.replace(/\b(def|class|return|if|elif|else|for|while|in|not|and|or|is|import|from|try|except|raise|with|as|pass|lambda|True|False|None)\b/g,
      '<span class="tk-k">$1</span>');
    t = t.replace(/\x01V/g, '<span class="tk-v">').replace(/\x02/g, '</span>');
    t += tail;
    t = t.replace(/\x00(\d+)\x00/g, (m, i) => strs[+i]);
    return t;
  }).join('\n');
}

function updateFreqLabel(cfg) {
  const n = cfg.perWeek;
  $('freqLabel').textContent = n + ' day' + (n > 1 ? 's' : '') + ' per week — ' + FREQ_DESC[n - 1];
}

function update() {
  const cfg = readConfig();
  updateFreqLabel(cfg);
  $('minMaxWrap').hidden = !cfg.randomCommits;
  $('dayChips').classList.toggle('disabled', cfg.randomDays);
  $('msgPool').classList.toggle('muted', !cfg.randomMsgs);
  const stats = renderPreview(cfg);
  if (configValid(cfg)) {
    state.script = generateScript(cfg, stats);
    $('scriptCode').innerHTML = highlight(state.script);
  } else {
    state.script = '';
    $('scriptCode').textContent = '# Pick a valid start/end date range first.';
  }
}

function applySliderToChips() {
  const n = parseInt($('freqSlider').value, 10);
  document.querySelectorAll('#dayChips .chip').forEach(c => {
    c.classList.toggle('on', CHIP_ORDER.indexOf(parseInt(c.dataset.dow, 10)) < n);
  });
}

function syncSliderFromChips() {
  $('freqSlider').value = document.querySelectorAll('#dayChips .chip.on').length;
}

function onChipClick(e) {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if (chip.classList.contains('on')) {
    if (document.querySelectorAll('#dayChips .chip.on').length <= 1) return;
    chip.classList.remove('on');
  } else {
    chip.classList.add('on');
  }
  syncSliderFromChips();
  update();
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

// The <code> block is contenteditable, so copy/download whatever the user sees.
function currentScript() {
  if (!state.script) return '';
  return $('scriptCode').innerText || state.script;
}

function copyScript() {
  const text = currentScript();
  if (!text) return;
  const btn = $('copyBtn');
  const feedback = ok => {
    btn.textContent = ok ? 'Copied!' : 'Press Ctrl+C';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => feedback(true))
      .catch(() => feedback(fallbackCopy(text)));
  } else {
    feedback(fallbackCopy(text));
  }
}

function downloadScript() {
  const text = currentScript();
  if (!text) return;
  const blob = new Blob([text], { type: 'text/x-python' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'makeGithubgreen.py';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function flashLabel(btn, text) {
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, 1500);
}

function savePreset() {
  const fields = {};
  PRESET_FIELDS.forEach(id => {
    const el = $(id);
    fields[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  const preset = {
    fields: fields,
    weekdays: Array.from(document.querySelectorAll('#dayChips .chip.on'))
      .map(c => parseInt(c.dataset.dow, 10))
  };
  let ok = true;
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(preset));
  } catch (e) {
    ok = false;
  }
  flashLabel($('savePresetBtn'), ok ? 'Saved!' : 'Save failed');
}

function loadPreset() {
  let preset = null;
  try {
    preset = JSON.parse(localStorage.getItem(PRESET_KEY) || 'null');
  } catch (e) {
    preset = null;
  }
  if (!preset || !preset.fields) {
    flashLabel($('loadPresetBtn'), 'No preset saved');
    return;
  }
  PRESET_FIELDS.forEach(id => {
    if (!(id in preset.fields)) return;
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!preset.fields[id];
    else el.value = preset.fields[id];
  });
  if (Array.isArray(preset.weekdays) && preset.weekdays.length) {
    document.querySelectorAll('#dayChips .chip').forEach(c => {
      c.classList.toggle('on', preset.weekdays.indexOf(parseInt(c.dataset.dow, 10)) !== -1);
    });
  }
  update();
  flashLabel($('loadPresetBtn'), 'Loaded!');
}

function init() {
  const inputs = [
    'startDate', 'endDate', 'randomDays', 'randomCount', 'minPerDay', 'maxPerDay',
    'randomMsgs', 'msgPool', 'logFile', 'branch', 'userName', 'userEmail', 'autoPush'
  ];
  inputs.forEach(id => {
    $(id).addEventListener('input', update);
    $(id).addEventListener('change', update);
  });

  $('freqSlider').addEventListener('input', () => {
    applySliderToChips();
    update();
  });

  $('dayChips').addEventListener('click', onChipClick);

  $('generateBtn').addEventListener('click', () => {
    update();
    const card = $('scriptCard');
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  $('rerollBtn').addEventListener('click', () => {
    state.seed = (Math.random() * 2147483647) | 0;
    update();
  });

  $('copyBtn').addEventListener('click', copyScript);
  $('downloadBtn').addEventListener('click', downloadScript);
  $('savePresetBtn').addEventListener('click', savePreset);
  $('loadPresetBtn').addEventListener('click', loadPreset);

  $('msgPool').value = DEFAULT_MSGS.join('\n');

  update();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateScript: generateScript };
}