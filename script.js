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
  'update: refine details'
];

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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

function shEsc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
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
    maxPerDay: parseInt($('maxPerDay').value, 10),
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
        ? 1 + Math.floor(rng() * Math.max(1, cfg.maxPerDay))
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
        ? count + ' commit' + (count > 1 ? 's' : '')
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
  const daysMode = cfg.randomDays
    ? 'random ' + cfg.perWeek + ' weekday(s) each week'
    : 'fixed days: ' + (cfg.weekdays.length ? cfg.weekdays : [1])
        .slice()
        .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
        .map(x => DOW_NAMES[x])
        .join(', ');
  const countMode = cfg.randomCommits
    ? 'random 1..' + cfg.maxPerDay + ' commit(s) per active day'
    : 'exactly 1 commit per active day';
  const msgMode = cfg.randomMsgs ? 'random messages from pool' : 'conventional messages';
  const fixedDays = (cfg.weekdays.length ? cfg.weekdays : [1]).join(' ');
  const pool = (cfg.messages.length ? cfg.messages : DEFAULT_MSGS)
    .map(shEsc)
    .join('\n');

  return `#!/usr/bin/env bash
#
# ============================================================
#  makeGithubgreen.sh  --  auto-generated by makeGithubgreen
#  Generated : ${today}
#  Range     : ${cfg.start} -> ${cfg.end}
#  Pattern   : ${cfg.perWeek} commit day(s) / week | ${daysMode}
#              ${countMode} | ${msgMode}
#  Estimate  : ~${stats.totalCommits} commit(s) across ~${stats.activeDays} active day(s)
# ============================================================
#
# HOW TO USE
#   1. Place this file inside your git repository (with a remote configured).
#   2. Run:  bash makeGithubgreen.sh
#   3. Push: git push origin ${shEsc(cfg.branch)}
#
# WHY SQUARES TURN GREEN ON GITHUB
#   * Commit email must be one of the emails on your GitHub account.
#   * Commits must reach the default branch and be pushed.
#   * Repo public (or private contributions enabled in settings).
#
# REQUIREMENTS
#   * GNU date (Linux, WSL, Git Bash on Windows).
#     macOS: brew install coreutils, then replace "date" with "gdate".

set -e

# ------------------------- configuration -------------------------

LOGFILE="${shEsc(cfg.logFile)}"
START_DATE="${cfg.start}"
END_DATE="${cfg.end}"
BRANCH="${shEsc(cfg.branch)}"

# How many days per week should get commits (1..7)
COMMITS_PER_WEEK=${cfg.perWeek}

# true  -> shuffle WHICH weekdays get commits, every week
# false -> always commit on FIXED_DAYS (0=Sun 1=Mon 2=Tue ... 6=Sat)
RANDOM_DAYS=${cfg.randomDays}
FIXED_DAYS="${fixedDays}"

# true -> every chosen day gets a random 1..MAX_COMMITS_PER_DAY commits
RANDOM_COMMITS_PER_DAY=${cfg.randomCommits}
MAX_COMMITS_PER_DAY=${cfg.maxPerDay}

# true -> pick a random commit message from MSG_POOL below
RANDOM_MESSAGES=${cfg.randomMsgs}

# Optional repo-local identity for these commits (empty = keep current config)
GIT_USER_NAME="${shEsc(cfg.userName)}"
GIT_USER_EMAIL="${shEsc(cfg.userEmail)}"

# true -> automatically run "git push origin BRANCH" when finished
AUTO_PUSH=${cfg.autoPush}

# Commit message pool, one message per line (used when RANDOM_MESSAGES=true)
MSG_POOL="${pool}"

# --------------------------- helpers -----------------------------

pick_msg() {
  if [ "$RANDOM_MESSAGES" != "true" ]; then
    printf '%s\n' "chore($COMMIT_DATE): update $LOGFILE (entry #$DAY_NUMBER)"
    return
  fi
  total=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    total=$((total + 1))
  done <<POOL_EOF
$MSG_POOL
POOL_EOF
  if [ "$total" -eq 0 ]; then
    printf '%s\n' "chore($COMMIT_DATE): update $LOGFILE (entry #$DAY_NUMBER)"
    return
  fi
  wanted=$(( (RANDOM % total) + 1 ))
  idx=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    idx=$((idx + 1))
    if [ "$idx" -eq "$wanted" ]; then
      printf '%s\n' "$line"
      return
    fi
  done <<POOL_EOF
$MSG_POOL
POOL_EOF
}

select_week_days() {
  if [ "$RANDOM_DAYS" = "true" ]; then
    SELECTED_DAYS=""
    while [ "$(set -- $SELECTED_DAYS; echo $#)" -lt "$COMMITS_PER_WEEK" ]; do
      d=$((RANDOM % 7))
      case " $SELECTED_DAYS " in
        *" $d "*) ;;
        *) SELECTED_DAYS="$SELECTED_DAYS $d" ;;
      esac
    done
  else
    SELECTED_DAYS="$FIXED_DAYS"
  fi
}

# ----------------------------- go --------------------------------

touch "$LOGFILE"

if [ -n "$GIT_USER_NAME" ]; then
  git config user.name "$GIT_USER_NAME"
fi
if [ -n "$GIT_USER_EMAIL" ]; then
  git config user.email "$GIT_USER_EMAIL"
fi

CURRENT_WEEK=""
DAY_NUMBER=0
TOTAL_COMMITS=0
ACTIVE_DAYS=0

current_date="$START_DATE"
end_epoch=$(date -d "$END_DATE" +%s)

while [ "$(date -d "$current_date" +%s)" -le "$end_epoch" ]; do
  dow=$(date -d "$current_date" +%w)
  week=$(date -d "$current_date" +%G-%V)

  if [ "$week" != "$CURRENT_WEEK" ]; then
    CURRENT_WEEK="$week"
    select_week_days
  fi

  case " $SELECTED_DAYS " in
    *" $dow "*)
      commits_today=1
      if [ "$RANDOM_COMMITS_PER_DAY" = "true" ] && [ "$MAX_COMMITS_PER_DAY" -gt 1 ]; then
        commits_today=$(( (RANDOM % MAX_COMMITS_PER_DAY) + 1 ))
      fi

      ACTIVE_DAYS=$((ACTIVE_DAYS + 1))
      i=1
      while [ "$i" -le "$commits_today" ]; do
        DAY_NUMBER=$((DAY_NUMBER + 1))
        TOTAL_COMMITS=$((TOTAL_COMMITS + 1))
        COMMIT_DATE="$current_date"
        msg="$(pick_msg)"

        echo "[$COMMIT_DATE] entry #$DAY_NUMBER - $msg" >> "$LOGFILE"
        git add "$LOGFILE"

        GIT_AUTHOR_DATE="$COMMIT_DATE 12:00:00" \\
        GIT_COMMITTER_DATE="$COMMIT_DATE 12:00:00" \\
        git commit -m "$msg" --quiet

        printf '  ok  %s  #%s  "%s"\\n' "$COMMIT_DATE" "$DAY_NUMBER" "$msg"
        i=$((i + 1))
      done
      ;;
  esac

  current_date=$(date -I -d "$current_date + 1 day")
done

echo ""
echo "Done. $TOTAL_COMMITS backdated commit(s) created across $ACTIVE_DAYS active day(s)."
echo "Squares turn green after pushing."
if [ "$AUTO_PUSH" = "true" ]; then
  git push origin "$BRANCH"
else
  echo "Push now with:"
  echo "  git push origin $BRANCH"
fi
`;
}

function highlight(src) {
  const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split('\n').map(line => {
    if (/^\s*#/.test(line)) return '<span class="tk-c">' + line + '</span>';
    const strs = [];
    let t = line.replace(/("[^"]*"|'[^']*')/g, m => {
      strs.push('<span class="tk-s">' + m + '</span>');
      return '\x00' + (strs.length - 1) + '\x00';
    });
    t = t.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, m => '\x01V' + m + '\x02');
    t = t.replace(/\b(if|then|elif|else|fi|for|while|do|done|case|esac|function|return|local|set|echo|printf|true|false)\b/g,
      '<span class="tk-k">$1</span>');
    t = t.replace(/\x01V/g, '<span class="tk-v">').replace(/\x02/g, '</span>');
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
  $('maxPerDayWrap').classList.toggle('muted', !cfg.randomCommits);
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
  const blob = new Blob([state.script], { type: 'text/x-shellscript' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'makeGithubgreen.sh';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function init() {
  const inputs = [
    'startDate', 'endDate', 'randomDays', 'randomCount', 'maxPerDay',
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

  $('randomDays').addEventListener('change', () => {
    $('dayChips').classList.toggle('disabled', $('randomDays').checked);
  });

  $('randomMsgs').addEventListener('change', () => {
    $('msgPool').classList.toggle('muted', !$('randomMsgs').checked);
  });

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

  $('msgPool').value = DEFAULT_MSGS.join('\n');
  $('msgPool').classList.add('muted');

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