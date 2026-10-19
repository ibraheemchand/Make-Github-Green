'use strict';

// Logic for rewrite.html: preview + rewrite_history.py generator.
// The planning code below mirrors plan_offsets() in the generated Python
// (same PRNG + same seed), so the preview shows exactly what the script does.

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_PREVIEW_COLS = 53;
const DAY = 86400;

const state = {
  seed: (Math.random() * 2147483647) | 0,
  pattern: 'even',
  script: ''
};

// Everything below the configuration block of rewrite_history.py.
const PY_BODY = String.raw`# ==================== END OF CONFIGURATION ====================

import datetime
import os
import re
import shutil
import subprocess
import sys

DAY = 86400
MASK = 0xFFFFFFFF
PROGRESS_RE = re.compile(r"\((\d+)/(\d+)\)")


class RewriteError(Exception):
    """A user-facing error, printed without a traceback."""


# --------------------------- planning --------------------------

def mulberry32(seed):
    """Same small PRNG as the web preview, so SEED reproduces the preview layout."""
    state = [seed & MASK]

    def rng():
        state[0] = (state[0] + 0x6D2B79F5) & MASK
        a = state[0]
        t = ((a ^ (a >> 15)) * (1 | a)) & MASK
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & MASK)) & MASK) ^ t
        return ((t ^ (t >> 14)) & MASK) / 4294967296.0

    return rng


def parse_date(value, label):
    try:
        return datetime.datetime.strptime(str(value).strip(), "%Y-%m-%d").date()
    except ValueError:
        raise RewriteError(f"Invalid {label} date {value!r} -- expected YYYY-MM-DD, e.g. 2026-01-31.")


def parse_time(value):
    parts = str(value).strip().split(":")
    try:
        nums = [int(p) for p in parts] + [0] * (3 - len(parts))
        hours, minutes, seconds = nums[:3]
    except ValueError:
        raise RewriteError(f"Invalid FIXED_TIME {value!r} -- expected HH:MM:SS, e.g. 12:00:00.")
    if len(parts) > 3 or not (0 <= hours < 24 and 0 <= minutes < 60 and 0 <= seconds < 60):
        raise RewriteError(f"Invalid FIXED_TIME {value!r} -- expected HH:MM:SS, e.g. 12:00:00.")
    return hours * 3600 + minutes * 60 + seconds


def plan_offsets(count, start, end, rng):
    """Seconds after START_DATE 00:00 for each commit -- ascending, no two in the same second."""
    total_days = (end - start).days + 1
    weighted = set(WEIGHTED_DAYS)
    heavy, light = [], []
    for i in range(total_days):
        dow = ((start + datetime.timedelta(days=i)).weekday() + 1) % 7  # 0=Sun .. 6=Sat
        (heavy if dow in weighted else light).append(i)
    fixed = parse_time(FIXED_TIME)

    offsets = []
    for i in range(count):
        if PATTERN == "random":
            day = int(rng() * total_days)
        elif PATTERN == "weighted":
            use_heavy = rng() < 0.8
            pool = heavy if (use_heavy and heavy) or not light else light
            day = pool[int(rng() * len(pool))]
        else:  # even
            day = i * total_days // count
        if RANDOM_TIMES:
            sec = 9 * 3600 + int(rng() * 9 * 3600)  # 09:00:00 .. 17:59:59
        else:
            sec = fixed
        offsets.append(day * DAY + sec)

    offsets.sort()
    for i in range(1, len(offsets)):
        if offsets[i] <= offsets[i - 1]:
            offsets[i] = offsets[i - 1] + 1
    return offsets


# ----------------------------- git -----------------------------

def git(*args, check=True):
    try:
        result = subprocess.run(
            ["git"] + list(args),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        raise RewriteError(f"Could not run git: {exc}")
    if check and result.returncode != 0:
        output = (result.stderr or result.stdout).strip()
        raise RewriteError(f"'git {' '.join(args)}' failed:\n{output}")
    return result


def check_git():
    if shutil.which("git") is None:
        raise RewriteError(
            "git was not found on your PATH.\n"
            "Install it from https://git-scm.com/downloads, then open a new terminal and try again."
        )
    inside = git("rev-parse", "--is-inside-work-tree", check=False)
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        raise RewriteError(
            "This folder is not a git repository.\n"
            "cd into the repo whose history you want to rewrite, then run this script again."
        )


def sh_quote(text):
    return "'" + text.replace("'", "'\\''") + "'"


def env_filter(map_path):
    """Shell snippet run by filter-branch for every commit: look up its new date in the map file."""
    path = sh_quote(map_path.replace("\\", "/"))
    lines = [
        'd=$(grep "^$GIT_COMMIT " ' + path + ' | cut -d" " -f2)',
        'if [ -n "$d" ]; then',
        '  export GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d"',
        'fi',
    ]
    if GIT_USER_NAME:
        name = sh_quote(GIT_USER_NAME)
        lines.append("export GIT_AUTHOR_NAME=" + name + " GIT_COMMITTER_NAME=" + name)
    if GIT_USER_EMAIL:
        email = sh_quote(GIT_USER_EMAIL)
        lines.append("export GIT_AUTHOR_EMAIL=" + email + " GIT_COMMITTER_EMAIL=" + email)
    return "\n".join(lines) + "\n"


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


def confirm(question):
    try:
        answer = input(question + " [y/N]: ").strip().lower()
    except EOFError:
        answer = ""
    return answer in ("y", "yes")


# --------------------------- rewrite ---------------------------

def run_filter_branch(git_dir, map_path, total):
    script = env_filter(map_path)
    cmd = ["git", "filter-branch", "-f", "--env-filter", script, "--", BRANCH]
    env = dict(os.environ, FILTER_BRANCH_SQUELCH_WARNING="1")
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    except OSError as exc:
        raise RewriteError(f"Could not run git filter-branch: {exc}")

    # filter-branch reports "Rewrite <sha> (n/N) ..." using \r -- turn that into our progress bar.
    chars = bar_chars()
    print_progress(0, total, chars)
    output = []
    buf = b""
    while True:
        ch = proc.stdout.read(1)
        if not ch:
            break
        if ch in (b"\r", b"\n"):
            line = buf.decode("utf-8", "replace").strip()
            buf = b""
            if not line:
                continue
            output.append(line)
            match = PROGRESS_RE.search(line)
            if match:
                print_progress(int(match.group(1)), int(match.group(2)), chars)
        else:
            buf += ch
    if buf.strip():
        output.append(buf.decode("utf-8", "replace").strip())
    code = proc.wait()
    print()

    if code != 0:
        filter_file = os.path.join(git_dir, "rewrite_env_filter.sh")
        with open(filter_file, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(script)
        details = "\n".join(line for line in output if not PROGRESS_RE.search(line))[-2000:]
        raise RewriteError(
            f"git filter-branch failed (exit code {code}):\n{details}\n\n"
            "Nothing was pushed. To retry by hand (Git Bash on Windows, or any terminal on Mac/Linux):\n"
            f"  FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f "
            f"--env-filter \"$(cat '{filter_file}')\" -- {BRANCH}\n"
            f"The date map it reads is {map_path}"
        )


# ----------------------------- main ----------------------------

def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__)
        return 0
    assume_yes = "-y" in argv or "--yes" in argv

    start = parse_date(START_DATE, "start")
    end = parse_date(END_DATE, "end")
    if start > end:
        raise RewriteError(f"START_DATE {start} is after END_DATE {end}.")
    if PATTERN not in ("even", "random", "weighted"):
        raise RewriteError(f"Unknown PATTERN {PATTERN!r} -- use 'even', 'random' or 'weighted'.")
    parse_time(FIXED_TIME)

    check_git()
    if git("rev-parse", "--verify", "--quiet", "refs/heads/" + BRANCH, check=False).returncode != 0:
        raise RewriteError(f"Branch '{BRANCH}' does not exist here. Set BRANCH at the top of this script.")
    if git("status", "--porcelain", "--untracked-files=no").stdout.strip():
        raise RewriteError("You have uncommitted changes. Commit or stash them first, then run this again.")

    hashes = git("log", "--reverse", "--format=%H", BRANCH, "--").stdout.split()
    if not hashes:
        raise RewriteError(f"No commits found on '{BRANCH}' -- there is nothing to rewrite.")
    total = len(hashes)

    offsets = plan_offsets(total, start, end, mulberry32(SEED))
    base = datetime.datetime.combine(start, datetime.time())
    dates = [(base + datetime.timedelta(seconds=o)).strftime("%Y-%m-%dT%H:%M:%S") for o in offsets]
    days_used = len(set(o // DAY for o in offsets))

    print(f"Found {total} commit(s) on '{BRANCH}' -- will be spread across {days_used} day(s) "
          f"({dates[0][:10]} to {dates[-1][:10]}, pattern: {PATTERN}).")
    print("This rewrites git history: every commit gets a new hash.")
    if FORCE_PUSH:
        print(f"Afterwards it will force push to origin/{BRANCH}.")
    if not assume_yes and not confirm("Continue?"):
        print("Aborted -- nothing was changed.")
        return 1

    git_dir = os.path.abspath(git("rev-parse", "--git-dir").stdout.strip())
    map_path = os.path.join(git_dir, "rewrite_dates.map")
    with open(map_path, "w", encoding="utf-8", newline="\n") as fh:
        for commit, date in zip(hashes, dates):
            fh.write(f"{commit} {date}\n")

    run_filter_branch(git_dir, map_path, total)
    os.remove(map_path)

    print(f"Done. Rewrote {total} commits. Date range: {START_DATE} to {END_DATE}")
    print(f"Old history is backed up at refs/original/refs/heads/{BRANCH}")
    print(f"  undo (before pushing): git reset --hard refs/original/refs/heads/{BRANCH}")

    if FORCE_PUSH:
        print(f"Force pushing to origin/{BRANCH}...")
        try:
            code = subprocess.call(["git", "push", "--force", "origin", BRANCH])
        except OSError as exc:
            raise RewriteError(f"Could not run git push: {exc}")
        if code != 0:
            raise RewriteError(f"git push failed (exit code {code}). Check your remote and credentials, then run:\n"
                               f"  git push --force origin {BRANCH}")
        print("Pushed. Check your GitHub profile -- squares update within a few minutes.")
    else:
        print("Push the new history with:")
        print(f"  git push --force origin {BRANCH}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except RewriteError as exc:
        print(f"\nerror: {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)
`;

function $(id) {
  return document.getElementById(id);
}

function parseDateVal(v) {
  if (!v) return null;
  const d = new Date(v + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

function isoDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
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

function pyStr(s) {
  return JSON.stringify(String(s));
}

function pyBool(b) {
  return b ? 'True' : 'False';
}

function fixedTimeSeconds(v) {
  const p = String(v || '12:00').split(':').map(n => parseInt(n, 10) || 0);
  return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
}

function fixedTimeStr(v) {
  const s = fixedTimeSeconds(v);
  const pad = n => String(n).padStart(2, '0');
  return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
}

function readConfig() {
  return {
    start: $('startDate').value,
    end: $('endDate').value,
    pattern: state.pattern,
    weightedDays: Array.from(document.querySelectorAll('#dayChips .chip.on'))
      .map(c => parseInt(c.dataset.dow, 10))
      .sort((a, b) => a - b),
    randomTimes: $('randomTimes').checked,
    fixedTime: fixedTimeStr($('fixedTime').value),
    branch: $('branch').value.trim() || 'main',
    forcePush: $('forcePush').checked,
    userName: $('userName').value.trim(),
    userEmail: $('userEmail').value.trim(),
    commitCount: Math.max(1, Math.min(5000, parseInt($('commitCount').value, 10) || 1))
  };
}

function configValid(cfg) {
  const s = parseDateVal(cfg.start);
  const e = parseDateVal(cfg.end);
  return !!(s && e && s <= e);
}

// Mirror of plan_offsets() in the Python script.
function planOffsets(cfg, count, start, end, rng) {
  const totalDays = Math.round((end - start) / (DAY * 1000)) + 1;
  const weighted = new Set(cfg.weightedDays);
  const heavy = [];
  const light = [];
  for (let i = 0; i < totalDays; i++) {
    (weighted.has(addDays(start, i).getDay()) ? heavy : light).push(i);
  }
  const fixed = fixedTimeSeconds(cfg.fixedTime);

  const offsets = [];
  for (let i = 0; i < count; i++) {
    let day;
    if (cfg.pattern === 'random') {
      day = Math.floor(rng() * totalDays);
    } else if (cfg.pattern === 'weighted') {
      const useHeavy = rng() < 0.8;
      const pool = ((useHeavy && heavy.length) || !light.length) ? heavy : light;
      day = pool[Math.floor(rng() * pool.length)];
    } else {
      day = Math.floor(i * totalDays / count);
    }
    const sec = cfg.randomTimes ? 9 * 3600 + Math.floor(rng() * 9 * 3600) : fixed;
    offsets.push(day * DAY + sec);
  }

  offsets.sort((a, b) => a - b);
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i] <= offsets[i - 1]) offsets[i] = offsets[i - 1] + 1;
  }
  return offsets;
}

function renderPreview(cfg) {
  const grid = $('graphGrid');
  const monthsEl = $('graphMonths');
  grid.innerHTML = '';
  monthsEl.innerHTML = '';

  if (!configValid(cfg)) {
    $('dateError').textContent = 'Pick a valid range — start date must be on or before end date.';
    $('foundLine').textContent = '';
    $('stats').textContent = '';
    return { daysUsed: 0 };
  }
  $('dateError').textContent = '';

  const start = parseDateVal(cfg.start);
  const end = parseDateVal(cfg.end);
  const offsets = planOffsets(cfg, cfg.commitCount, start, end, mulberry32(state.seed));
  const perDay = {};
  offsets.forEach(o => {
    const key = isoDate(addDays(start, Math.floor(o / DAY)));
    perDay[key] = (perDay[key] || 0) + 1;
  });
  const daysUsed = Object.keys(perDay).length;
  const maxPerDay = Math.max.apply(null, Object.values(perDay));

  $('foundLine').textContent = 'Found ' + cfg.commitCount + ' commit' + (cfg.commitCount === 1 ? '' : 's') +
    ' — will be spread across ' + daysUsed + ' day' + (daysUsed === 1 ? '' : 's');

  const firstSun = addDays(start, -start.getDay());
  const monthByCol = [];
  let col = 0;
  let capped = false;
  const d = new Date(firstSun);
  while (d <= end) {
    if (col >= MAX_PREVIEW_COLS) { capped = true; break; }
    if (d.getDay() === 0) monthByCol.push(d.getMonth());
    const inRange = d >= start;
    const count = inRange ? (perDay[isoDate(d)] || 0) : 0;
    let level = 0;
    if (count >= 4) level = 4;
    else if (count === 3) level = 3;
    else if (count === 2) level = 2;
    else if (count === 1) level = 1;
    // With few commits per day, use the brighter shades so the graph stays readable.
    if (count > 0 && maxPerDay <= 2) level = Math.min(4, level + 1);
    const el = document.createElement('div');
    el.className = 'cell lv' + level;
    if (inRange) {
      el.title = (count > 0 ? count + ' commit' + (count > 1 ? 's' : '') : 'No commits') + ' · ' + fmtDate(d);
    }
    grid.appendChild(el);
    if (d.getDay() === 6) col++;
    d.setDate(d.getDate() + 1);
  }

  const starts = [];
  monthByCol.forEach((m, i) => {
    if (i === 0 || m !== monthByCol[i - 1]) starts.push(i);
  });
  starts.forEach((st, idx) => {
    const next = idx + 1 < starts.length ? starts[idx + 1] : monthByCol.length;
    const span = Math.max(1, next - st);
    // A one-week month followed by another label has no room for its text.
    if (span < 2 && next < monthByCol.length) return;
    const s = document.createElement('span');
    s.textContent = new Date(2026, monthByCol[st], 1).toLocaleString('en-US', { month: 'short' });
    s.style.gridColumn = (st + 1) + ' / span ' + span;
    monthsEl.appendChild(s);
  });

  $('stats').textContent = 'Pattern: ' + cfg.pattern +
    ' · up to ' + maxPerDay + ' commit' + (maxPerDay === 1 ? '' : 's') + ' on one day' +
    (capped ? ' · preview limited to the first year' : '');

  return { daysUsed: daysUsed };
}

function generateScript(cfg, stats) {
  const today = isoDate(new Date());
  const patternDesc = {
    even: 'even -- commits spread evenly across the range',
    random: 'random -- commits on random dates in the range',
    weighted: 'weighted -- 80% of commits on ' +
      (cfg.weightedDays.length ? cfg.weightedDays.map(x => DOW_NAMES[x]).join(', ') : '(no days)') +
      ', 20% on the other days'
  }[cfg.pattern];
  const timeDesc = cfg.randomTimes ? 'random times between 09:00 and 18:00' : 'every commit at ' + cfg.fixedTime;

  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rewrite_history.py -- generated by makeGithubgreen (rewrite.html)
  Generated : ${today}
  Range     : ${cfg.start} -> ${cfg.end}
  Pattern   : ${patternDesc}
  Times     : ${timeDesc}
  Preview   : made for ${cfg.commitCount} commit(s) over ~${stats.daysUsed} day(s); the script uses
              however many commits the branch really has.

Rewrites the author + committer date of EVERY commit on BRANCH so they are
spread across the range above, then (optionally) force pushes.

HOW TO USE
  1. Put this file in your repo folder. Commit or stash your changes first.
  2. Run:  python rewrite_history.py      (python3 on some Mac/Linux systems)
     Add --yes to skip the confirmation question.
  3. Check your GitHub profile -- squares update within a few minutes.

UNDO (before pushing):  git reset --hard refs/original/refs/heads/${cfg.branch}

Anyone sharing this repo must run "git pull --rebase" or re-clone after the force push.
Requires Python 3.6+ and git. Works on Windows, macOS and Linux.
"""

# ============================================================
#  CONFIGURATION
# ============================================================

START_DATE = ${pyStr(cfg.start)}
END_DATE   = ${pyStr(cfg.end)}
PATTERN    = ${pyStr(cfg.pattern)}   # even | random | weighted
BRANCH     = ${pyStr(cfg.branch)}
FORCE_PUSH = ${pyBool(cfg.forcePush)}          # run "git push --force origin BRANCH" when done
RANDOM_TIMES = ${pyBool(cfg.randomTimes)}        # True -> random time between 09:00 and 18:00
FIXED_TIME   = ${pyStr(cfg.fixedTime)}  # used when RANDOM_TIMES is False
GIT_USER_NAME  = ${pyStr(cfg.userName)}       # optional: also rewrite author/committer name
GIT_USER_EMAIL = ${pyStr(cfg.userEmail)}       # optional: also rewrite author/committer email
WEIGHTED_DAYS  = [${cfg.weightedDays.join(', ')}]  # "weighted": 80% of commits land on these (0=Sun .. 6=Sat)
SEED = ${state.seed}           # same seed as the web preview -> same layout

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

function update() {
  const cfg = readConfig();
  $('dayChipsWrap').hidden = cfg.pattern !== 'weighted';
  $('fixedTimeWrap').hidden = cfg.randomTimes;
  const stats = renderPreview(cfg);
  if (configValid(cfg)) {
    state.script = generateScript(cfg, stats);
    $('scriptCode').innerHTML = highlight(state.script);
  } else {
    state.script = '';
    $('scriptCode').textContent = '# Pick a valid start/end date range first.';
  }
}

function onPatternClick(e) {
  const btn = e.target.closest('[data-pattern]');
  if (!btn) return;
  state.pattern = btn.dataset.pattern;
  document.querySelectorAll('#patternSeg [data-pattern]').forEach(b => {
    const on = b === btn;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  update();
}

function onChipClick(e) {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if (chip.classList.contains('on') && document.querySelectorAll('#dayChips .chip.on').length <= 1) return;
  chip.classList.toggle('on');
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

function copyScript() {
  if (!state.script) return;
  const btn = $('copyBtn');
  const feedback = ok => {
    btn.textContent = ok ? 'Copied!' : 'Press Ctrl+C';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(state.script)
      .then(() => feedback(true))
      .catch(() => feedback(fallbackCopy(state.script)));
  } else {
    feedback(fallbackCopy(state.script));
  }
}

function downloadScript() {
  if (!state.script) return;
  const blob = new Blob([state.script], { type: 'text/x-python' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'rewrite_history.py';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function init() {
  $('endDate').value = isoDate(new Date());

  const inputs = [
    'startDate', 'endDate', 'randomTimes', 'fixedTime', 'branch',
    'forcePush', 'userName', 'userEmail', 'commitCount'
  ];
  inputs.forEach(id => {
    $(id).addEventListener('input', update);
    $(id).addEventListener('change', update);
  });

  $('patternSeg').addEventListener('click', onPatternClick);
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

  update();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
