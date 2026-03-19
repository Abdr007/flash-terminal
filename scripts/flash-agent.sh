#!/bin/bash
# Flash Agent — Background runner with tmux
#
# Usage:
#   ./scripts/flash-agent.sh          # Start agent in background
#   ./scripts/flash-agent.sh attach   # Reconnect to running agent
#   ./scripts/flash-agent.sh stop     # Stop the agent
#   ./scripts/flash-agent.sh status   # Check if running

SESSION="flash-agent"

case "${1:-start}" in
  start)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "Agent already running. Use: ./scripts/flash-agent.sh attach"
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

    tmux new-session -d -s "$SESSION" "flash"
    sleep 3

    # Send simulation mode selection + agent start
    tmux send-keys -t "$SESSION" "2" Enter
    sleep 2
    tmux send-keys -t "$SESSION" "agent start --live" Enter

    echo "Agent started. Running in background."
    echo "Mac will stay awake (caffeinate pid: $CAFFEINE_PID)"
    ;;

  attach)
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "No agent session running. Start with: ./scripts/flash-agent.sh"
      exit 1
    fi
    echo "Attaching to agent session. Press Ctrl+B then D to detach again."
    tmux attach -t "$SESSION"
    ;;

  stop)
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "No agent session running."
      exit 0
    fi
    tmux send-keys -t "$SESSION" "agent stop" Enter
    sleep 3
    tmux send-keys -t "$SESSION" "exit" Enter
    sleep 2
    tmux kill-session -t "$SESSION" 2>/dev/null
    # Kill caffeinate
    pkill -f "caffeinate -s" 2>/dev/null
    echo "Agent stopped."
    ;;

  status)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "Agent is RUNNING in tmux session '$SESSION'"
      echo "  Attach: ./scripts/flash-agent.sh attach"
      echo "  Stop:   ./scripts/flash-agent.sh stop"
    else
      echo "Agent is NOT running."
    fi
    ;;

  *)
    echo "Usage: ./scripts/flash-agent.sh [start|attach|stop|status]"
    ;;
esac
