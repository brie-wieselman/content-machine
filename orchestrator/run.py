#!/usr/bin/env python3
"""Orchestrator — single entry point for every scheduled agent.

    python3 orchestrator/run.py <agent>        run one agent now
    python3 orchestrator/run.py status         human-readable state summary
    python3 orchestrator/run.py gen-plists     write launchd plists from schedule.json
    python3 orchestrator/run.py approve <manifest.json>   approve an experiment
    python3 orchestrator/run.py list           list runnable agents

Design principles (the interesting part):
- Agents run as SCHEDULED BATCH JOBS only — nothing runs continuously.
- Existing agents are WRAPPED, not rewritten: the proven pipeline stays the
  sole content entry point; granular entries exist for manual runs and
  experiments.
- state.json tracks per-agent graduation (approval-queue vs auto). Publisher
  graduation ALWAYS requires the operator's explicit flag flip — this script
  never auto-graduates anything (see check_graduation()). That is the whole
  safety model: the machine can earn trust, but only a human grants it.
- Mock mode: ORCH_MOCK=1 substitutes every agent with a deterministic mock
  (orchestrator/mocks.py) so the full engine dry-runs with zero credentials
  and zero network. Mock artifacts land in orchestrator/mockrun/.
- Experiment agents (exp-*) are CONFIGS executed by shared code — never
  novel code. See experiments.py.
"""
import json
import os
import subprocess
import sys
import time
from datetime import date, datetime

ORCH = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(ORCH)  # repo root
LOGS = os.path.join(ORCH, "logs")
LOCKS = os.path.join(ORCH, "locks")
STATE_FILE = os.path.join(ORCH, "state.json")
SCHEDULE_FILE = os.path.join(ORCH, "schedule.json")
AGENTS_FILE = os.path.join(ORCH, "agents.json")
MOCK = os.environ.get("ORCH_MOCK") == "1"

for d in (LOGS, LOCKS):
    os.makedirs(d, exist_ok=True)


def _load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


def load_state():
    return _load(STATE_FILE, {"agents": {}, "experiments": {"active": [], "history": []}})


def save_state(state):
    _save(STATE_FILE, state)


def registry():
    return _load(AGENTS_FILE, {})


def log_path(agent):
    return os.path.join(LOGS, "%s-%s.log" % (date.today().isoformat(), agent))


def log_line(agent, msg):
    line = "[%s] %s\n" % (datetime.now().isoformat(timespec="seconds"), msg)
    with open(log_path(agent), "a") as f:
        f.write(line)
    sys.stdout.write(line)


# ---------------------------------------------------------------------------
# Running one agent
# ---------------------------------------------------------------------------
def resolve_command(agent):
    """Return (argv, env_extra) for an agent, honoring mock mode and exp-* configs."""
    if agent.startswith("exp-"):
        # Experiment agents: config-only, executed by shared experiment runner.
        return ([sys.executable, os.path.join(ORCH, "experiments.py"), "run", agent], {})
    reg = registry()
    if agent not in reg:
        raise SystemExit("unknown agent %r — try: %s" % (agent, ", ".join(sorted(reg))))
    spec = reg[agent]
    # Node agents get substituted by deterministic mocks under ORCH_MOCK=1;
    # the Python agents (analyst, storefront) run their REAL code, which
    # honors ORCH_MOCK internally (mock analytics, no network, no email).
    NODE_MOCKED = {"pipeline", "scout", "maker", "grader", "publisher-queue",
                   "brand-voice", "weekly-analyst-legacy"}
    if MOCK and agent in NODE_MOCKED:
        return ([sys.executable, os.path.join(ORCH, "mocks.py"), agent], {})
    return (spec["cmd"], spec.get("env", {}))


def acquire_lock(agent):
    lock = os.path.join(LOCKS, agent + ".lock")
    if os.path.exists(lock):
        try:
            pid = int(open(lock).read().strip())
            os.kill(pid, 0)  # raises if pid gone
            return None  # genuinely running
        except (ValueError, ProcessLookupError, PermissionError):
            os.unlink(lock)  # stale
    with open(lock, "w") as f:
        f.write(str(os.getpid()))
    return lock


def run_agent(agent):
    lock = acquire_lock(agent)
    if lock is None:
        log_line(agent, "SKIP — previous run still in progress (lock held)")
        return 0
    argv, env_extra = resolve_command(agent)
    env = dict(os.environ)
    env.update(env_extra)
    env.setdefault("CM_SUPPRESS_EMAIL", "0")  # standalone runs keep their own email behavior
    log_line(agent, "START %s%s" % (" ".join(map(str, argv)), " [MOCK]" if MOCK else ""))
    t0 = time.time()
    try:
        with open(log_path(agent), "a") as lf:
            rc = subprocess.call(argv, cwd=ROOT, stdout=lf, stderr=subprocess.STDOUT,
                                 env=env, timeout=90 * 60)
    except subprocess.TimeoutExpired:
        rc = -9
        log_line(agent, "TIMEOUT after 90m — killed")
    except Exception as e:  # noqa: BLE001 — record, never crash the scheduler
        rc = -1
        log_line(agent, "ERROR launching: %s" % e)
    finally:
        try:
            os.unlink(lock)
        except OSError:
            pass
    dur = round(time.time() - t0, 1)
    # RELOAD state AFTER the subprocess: the child (analyst retirements,
    # experiment post counters) may have written state.json while it ran —
    # a pre-spawn snapshot here silently clobbered those writes. Load fresh,
    # then add only our last_run key.
    state = load_state()
    entry = state["agents"].setdefault(agent, {"mode": "approval-queue"})
    entry["last_run"] = {"ts": datetime.now().isoformat(timespec="seconds"),
                         "exit": rc, "duration_s": dur, "log": os.path.basename(log_path(agent)),
                         "mock": MOCK}
    save_state(state)
    log_line(agent, "END exit=%s duration=%ss" % (rc, dur))
    check_graduation(agent, state)
    return rc


def check_graduation(agent, state):
    """Report (never act on) graduation readiness. Graduation is ALWAYS a
    manual flag flip by the operator in state.json — this only surfaces
    eligibility. The orchestrator never promotes an agent to auto on its own."""
    entry = state["agents"].get(agent, {})
    crit = entry.get("graduation_criteria")
    if not crit or entry.get("non_graduating") or entry.get("mode") == "auto":
        return
    stats = entry.get("approval_stats", {})
    ok_rate = stats.get("unedited_approval_rate")
    weeks = stats.get("weeks_observed", 0)
    if ok_rate is not None and weeks >= crit.get("weeks", 2) and ok_rate >= crit.get("unedited_approval_rate", 0.9):
        log_line(agent, "GRADUATION-ELIGIBLE: %s weeks observed, %.0f%% unedited approvals — "
                        "flip agents.%s.mode to \"auto\" in state.json yourself if you agree. "
                        "The orchestrator never flips this flag." % (weeks, ok_rate * 100, agent))


# ---------------------------------------------------------------------------
# launchd plist generation (run gen-plists ON the target machine so absolute
# paths are correct there)
# ---------------------------------------------------------------------------
PLIST_TMPL = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string>
    <string>{run_py}</string>
    <string>{agent}</string>
  </array>
  <key>StartCalendarInterval</key>{intervals}
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
  <key>WorkingDirectory</key><string>{root}</string>
</dict></plist>
"""


def gen_plists():
    sched = _load(SCHEDULE_FILE, [])
    outdir = os.path.join(ORCH, "launchd")
    os.makedirs(outdir, exist_ok=True)
    written = []
    for job in sched:
        if not job.get("enabled", True):
            continue
        agent = job["agent"]
        label = "com.contentmachine.orchestrator.%s" % agent
        ivs = job["when"] if isinstance(job["when"], list) else [job["when"]]
        if len(ivs) == 1:
            intervals = "<dict>%s</dict>" % _ivdict(ivs[0])
        else:
            intervals = "<array>%s</array>" % "".join("<dict>%s</dict>" % _ivdict(iv) for iv in ivs)
        p = os.path.join(outdir, label + ".plist")
        with open(p, "w") as f:
            f.write(PLIST_TMPL.format(label=label, run_py=os.path.abspath(__file__), agent=agent,
                                      intervals=intervals, root=ROOT,
                                      log=os.path.join(LOGS, "launchd-%s.log" % agent)))
        written.append(p)
    print("wrote %d plists to %s" % (len(written), outdir))
    for p in written:
        print("  " + os.path.basename(p))


def _ivdict(iv):
    keys = {"weekday": "Weekday", "hour": "Hour", "minute": "Minute", "day": "Day"}
    return "".join("<key>%s</key><integer>%d</integer>" % (keys[k], v) for k, v in iv.items() if k in keys)


# ---------------------------------------------------------------------------
def status():
    state = load_state()
    print("AGENTS:")
    for name, e in sorted(state["agents"].items()):
        lr = e.get("last_run", {})
        print("  %-18s mode=%-15s non_grad=%-5s last=%s exit=%s%s" % (
            name, e.get("mode", "?"), e.get("non_graduating", False),
            lr.get("ts", "never"), lr.get("exit", "-"), " [mock]" if lr.get("mock") else ""))
    ex = state.get("experiments", {})
    print("EXPERIMENTS: %d active (max 2), %d in history" % (len(ex.get("active", [])), len(ex.get("history", []))))
    for e in ex.get("active", []):
        print("  %-18s started=%s ends=%s" % (e.get("id"), e.get("started"), e.get("ends")))


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cmd = sys.argv[1]
    if cmd == "status":
        status()
    elif cmd == "list":
        print("\n".join(sorted(registry())))
    elif cmd == "gen-plists":
        gen_plists()
    elif cmd == "approve":
        import experiments
        experiments.approve(sys.argv[2])
    else:
        sys.exit(run_agent(cmd))


if __name__ == "__main__":
    main()
