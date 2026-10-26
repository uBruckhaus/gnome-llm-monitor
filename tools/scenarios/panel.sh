# Collectors of this test shell only: their path is inside the test's data folder.
collectors() { pgrep -fc "$EXT/scripts/llm-monitor.py"; }
sleep 20
echo "--- disable / enable (like locking and unlocking)"
gnome-extensions disable $UUID; sleep 1
if [ "$(collectors)" = 0 ]; then echo "collector stopped with the extension"; else echo "FAIL: collector still running after disable"; FAILED=1; fi
gnome-extensions enable $UUID; sleep 3
gnome-extensions info $UUID | grep State
[ "$(collectors)" = 1 ] && echo "one collector running" || { echo "FAIL: $(collectors) collectors running"; FAILED=1; }
