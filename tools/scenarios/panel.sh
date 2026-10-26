sleep 20
echo "--- disable / enable (like locking and unlocking)"
gnome-extensions disable $UUID; sleep 1
pgrep -f "$UUID/scripts/llm-monitor.py" >/dev/null && echo "collector still running after disable" || echo "collector stopped with the extension"
gnome-extensions enable $UUID; sleep 3
gnome-extensions info $UUID | grep State
pgrep -fc "$UUID/scripts/llm-monitor.py" | sed 's/^/collectors running: /'
