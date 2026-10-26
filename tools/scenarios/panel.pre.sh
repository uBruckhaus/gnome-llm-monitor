# Test-only patch of the copied extension: screenshot the bar, open the panel and
# screenshot it, then disable and enable the extension (like locking the screen).
cat >> "$EXT/extension.js" <<'JS'
import Shell from 'gi://Shell';
const _origEnable = LlmMonitorExtension.prototype.enable;
LlmMonitorExtension.prototype.enable = function () {
    _origEnable.call(this);
    if (globalThis._lmTestStarted)
        return;
    globalThis._lmTestStarted = true;
    const shot = (name, then) => {
        const file = Gio.File.new_for_path(`${GLib.getenv('LM_SHOT_DIR')}/${name}.png`);
        const stream = file.replace(null, false, 0, null);
        new Shell.Screenshot().screenshot(false, stream, (s, r) => {
            s.screenshot_finish(r); stream.close(null);
            console.log(`[LLM Monitor] screenshot ${name} written`);
            then?.();
        });
    };
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 9000, () => {
        Main.overview.hide();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            const ind = this._indicator;
            console.log(`[LLM Monitor] bar text "${ind._label.text}", active ${ind._stats.active}, runtimes ${(ind._stats.runtimes || []).length}`);
            shot('bar', () => {
                ind.menu.open(false);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
                    shot('panel', () => ind.menu.close(false));
                    return GLib.SOURCE_REMOVE;
                });
            });
            return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
    });
};
JS
export LM_SHOT_DIR="${LM_SHOT_DIR:-$ROOT/dist/screenshots}"; mkdir -p "$LM_SHOT_DIR"
