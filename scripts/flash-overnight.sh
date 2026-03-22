#!/bin/bash
set -euo pipefail
SESSION="flash-night"
PROJECT_DIR="$HOME/flash-ai-terminal"
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

case "${1:-start}" in
  start)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "Already running. Attach: $0 attach"
      exit 0
    fi
    tmux has-session -t "flash-agent" 2>/dev/null && tmux kill-session -t "flash-agent" 2>/dev/null || true
    pkill -f caffeinate 2>/dev/null || true
    tmux new-session -d -s "$SESSION" "cd $PROJECT_DIR && flash"
    caffeinate -dims &
    echo $! > "$LOG_DIR/caffeinate.pid"
    sleep 4
    tmux send-keys -t "$SESSION" "2" Enter
    sleep 3
    tmux send-keys -t "$SESSION" "agent start --live" Enter
    sleep 5
    tmux send-keys -t "$SESSION" "agent validate" Enter
    echo "Started. Attach: $0 attach | Stop: $0 stop"
    ;;
  attach) tmux attach -t "$SESSION" ;;
  stop)
    tmux send-keys -t "$SESSION" "agent stop" Enter 2>/dev/null || true
    sleep 3
    tmux send-keys -t "$SESSION" "exit" Enter 2>/dev/null || true
    sleep 2
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    [ -f "$LOG_DIR/caffeinate.pid" ] && kill "$(cat "$LOG_DIR/caffeinate.pid")" 2>/dev/null || true
    pkill -f caffeinate 2>/dev/null || true
    echo "Stopped."
    ;;
  status) tmux has-session -t "$SESSION" 2>/dev/null && echo "RUNNING" || echo "NOT RUNNING" ;;
  *) echo "Usage: $0 [start|attach|stop|status]" ;;
esac
