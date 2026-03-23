#!/bin/bash
# Flash Agent — Background runner with tmux
#
# Usage:
#   ./scripts/flash-agent.sh          # Start agent in background
#   ./scripts/flash-agent.sh attach   # Reconnect to running agent
#   ./scripts/flash-agent.sh stop     # Stop the agent
#   ./scripts/flash-agent.sh status   # Check if running

FLASH_DIR="$HOME/.flash"
PID_FILE="$FLASH_DIR/agent.pid"

# Check both session names (flash-night is the live session, flash-agent is legacy)
detect_session() {
  for name in flash-night flash-agent; do
    if tmux has-session -t "$name" 2>/dev/null; then
      echo "$name"
      return 0
    fi
  done
  return 1
}

# Default session name for NEW sessions
SESSION="${FLASH_AGENT_SESSION:-flash-night}"

case "${1:-start}" in
  start)
    EXISTING=$(detect_session)
    if [ -n "$EXISTING" ]; then
      echo "Agent already running in session '$EXISTING'."
      echo "  Attach: ./scripts/flash-agent.sh attach"
      echo "  Stop:   ./scripts/flash-agent.sh stop"
      exit 0
    fi

    # Prevent Mac from sleeping while agent runs
    caffeinate -s &
    CAFFEINE_PID=$!

    echo "Starting Flash Agent in background..."
    echo "  Session: $SESSION"
    echo "  Reconnect: ./scripts/flash-agent.sh attach"
    echo "  Stop:      ./scripts/flash-agent.sh stop"
    echo ""

    # Ensure flash dir exists
    mkdir -p "$FLASH_DIR"

    tmux new-session -d -s "$SESSION" "flash"
    sleep 3

    # Send simulation mode selection + agent start
    tmux send-keys -t "$SESSION" "2" Enter
    sleep 2
    tmux send-keys -t "$SESSION" "agent start --live" Enter

    # Write PID file (tmux server PID as reference)
    echo $$ > "$PID_FILE"

    echo "Agent started. Running in background."
    echo "Mac will stay awake (caffeinate pid: $CAFFEINE_PID)"
    ;;

  attach)
    EXISTING=$(detect_session)
    if [ -z "$EXISTING" ]; then
      echo "No agent session running. Start with: ./scripts/flash-agent.sh"
      exit 1
    fi
    echo "Attaching to agent session '$EXISTING'. Press Ctrl+B then D to detach again."
    tmux attach -t "$EXISTING"
    ;;

  stop)
    EXISTING=$(detect_session)
    if [ -z "$EXISTING" ]; then
      echo "No agent session running."
      # Clean stale PID file
      rm -f "$PID_FILE"
      exit 0
    fi
    echo "Stopping agent in session '$EXISTING'..."
    tmux send-keys -t "$EXISTING" "agent stop" Enter
    sleep 3
    tmux send-keys -t "$EXISTING" "exit" Enter
    sleep 2
    tmux kill-session -t "$EXISTING" 2>/dev/null
    # Clean PID file
    rm -f "$PID_FILE"
    # Kill caffeinate
    pkill -f "caffeinate -s" 2>/dev/null
    echo "Agent stopped."
    ;;

  status)
    EXISTING=$(detect_session)
    if [ -n "$EXISTING" ]; then
      echo "Agent is RUNNING in tmux session '$EXISTING'"
      # Show heartbeat if available
      if [ -f "$FLASH_DIR/agent-heartbeat.json" ]; then
        HB_TS=$(python3 -c "import json; print(json.load(open('$FLASH_DIR/agent-heartbeat.json'))['timestamp'])" 2>/dev/null)
        if [ -n "$HB_TS" ]; then
          NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null)
          AGO=$(( (NOW_MS - HB_TS) / 1000 ))
          echo "  Heartbeat: ${AGO}s ago"
        fi
      fi
      echo "  Attach: ./scripts/flash-agent.sh attach"
      echo "  Stop:   ./scripts/flash-agent.sh stop"
    else
      echo "Agent is NOT running."
      if [ -f "$FLASH_DIR/agent-state.json" ]; then
        SIZE=$(wc -c < "$FLASH_DIR/agent-state.json" | tr -d ' ')
        echo "  Learning state preserved (${SIZE} bytes) — safe to start."
      fi
    fi
    ;;

  logs)
    EXISTING=$(detect_session)
    if [ -z "$EXISTING" ]; then
      echo "No agent session running."
      exit 1
    fi
    tmux capture-pane -t "$EXISTING" -p -S -200
    ;;

  *)
    echo "Usage: ./scripts/flash-agent.sh [start|attach|stop|status|logs]"
    ;;
esac
