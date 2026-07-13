#!/bin/bash
# ============================================================================
# HEADLESS CANVA PRODUCE — run after the pipeline has written
# canva_brief_*.json files (agents/agent3c-canva.js does that).
#
# Runs the /canva-produce skill in headless Claude Code (claude -p) with the
# Canva MCP connected. For every unprocessed brief it: opens YOUR saved brand
# template (from config.visual.canva_templates), fills the text, QA-checks the
# export, saves PNGs to output/pending/canva/, and writes a .done marker with
# the Canva edit URL next to each brief.
#
# Schedule it (cron/launchd) shortly after your pipeline run, or invoke by hand.
# This script builds visuals only — it never schedules or publishes anything.
#
# On failure -> agents/alerts.js fires an email so a silent morning never
# happens. Log: logs/canva-produce-headless.log
# ============================================================================
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/logs/canva-produce-headless.log"
BRIEFS="$ROOT/output/pending/canva/briefs"
mkdir -p "$ROOT/logs" "$BRIEFS"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "[$(date -u +%FT%TZ)] ===== headless canva-produce start =====" >> "$LOG"

# Anything to build? (briefs without .done markers)
TODO=0
for f in "$BRIEFS"/canva_brief_*.json; do
  [ -e "$f" ] || continue
  base="${f%.json}"
  [ -e "${base}.done" ] || TODO=$((TODO+1))
done
if [ "$TODO" -eq 0 ]; then
  echo "[$(date -u +%FT%TZ)] no unprocessed briefs — nothing to do" >> "$LOG"
  exit 0
fi
echo "[$(date -u +%FT%TZ)] $TODO unprocessed brief(s) — launching claude -p /canva-produce" >> "$LOG"

cd "$ROOT"
claude -p "/canva-produce" \
  --allowedTools "Skill,Read,Write,Glob,Grep,Bash,mcp__claude_ai_Canva__create-design-from-brand-template,mcp__claude_ai_Canva__start-editing-transaction,mcp__claude_ai_Canva__perform-editing-operations,mcp__claude_ai_Canva__commit-editing-transaction,mcp__claude_ai_Canva__cancel-editing-transaction,mcp__claude_ai_Canva__export-design,mcp__claude_ai_Canva__get-design,mcp__claude_ai_Canva__get-design-pages,mcp__claude_ai_Canva__get-export-formats,mcp__claude_ai_Canva__search-brand-templates,mcp__claude_ai_Canva__upload-asset-from-url" \
  --output-format text >> "$LOG" 2>&1
STATUS=$?

if [ $STATUS -ne 0 ]; then
  echo "[$(date -u +%FT%TZ)] FAILED exit=$STATUS — alerting" >> "$LOG"
  node "$ROOT/agents/alerts.js" --send "Canva visual build failed" "headless canva-produce failed (exit $STATUS) — today's visuals were not built. Run /canva-produce manually in Claude Code, or check logs/canva-produce-headless.log" >> "$LOG" 2>&1 || true
else
  BUILT=$(ls "$BRIEFS"/canva_brief_*.done 2>/dev/null | wc -l | tr -d ' ')
  echo "[$(date -u +%FT%TZ)] OK — done markers now: $BUILT" >> "$LOG"
fi
echo "[$(date -u +%FT%TZ)] ===== headless canva-produce end =====" >> "$LOG"
