# /// script
# dependencies = ["pynvim==0.6.0"]
# ///
"""Run `uv run --script tests/dashboard.py` with the locked plugins installed.

Capture every visible Neovim UI frame, including the first startup frame.
Only config/state are copied; existing installed plugins are reused.
"""

from pathlib import Path
import shutil
import tempfile

import pynvim


class Screen:
    def __init__(self, nvim):
        self.nvim = nvim
        self.grid = []
        self.header_rows = []

    def notify(self, method, args):
        if method == "dashboard_test_done":
            self.nvim.stop_loop()
            return
        if method != "redraw":
            return
        for name, *events in args:
            for event in events:
                if name == "grid_resize" and event[0] == 1:
                    self.grid = [[" "] * event[1] for _ in range(event[2])]
                elif name == "grid_clear" and event[0] == 1:
                    self.grid = [[" "] * len(row) for row in self.grid]
                elif name == "grid_line" and event[0] == 1:
                    _, row, col, cells, *_ = event
                    for cell in cells:
                        for _ in range(cell[2] if len(cell) > 2 else 1):
                            self.grid[row][col] = cell[0]
                            col += 1
                elif name == "grid_scroll" and event[0] == 1:
                    _, top, bottom, left, right, rows, cols = event
                    old = [row[:] for row in self.grid]
                    for row in range(top, bottom):
                        for col in range(left, right):
                            self.grid[row][col] = (
                                old[row + rows][col + cols]
                                if top <= row + rows < bottom and left <= col + cols < right
                                else " "
                            )
                elif name == "flush":
                    for row, cells in enumerate(self.grid, start=1):
                        if "██╗      █████╗" in "".join(cells):
                            self.header_rows.append(row)
                            break

    def collect(self):
        def setup():
            self.nvim.exec_lua(
                'if package.loaded["persistence"] then require("persistence").stop() end'
            )
            self.nvim.exec_lua(
                "local channel = ...; vim.defer_fn(function() "
                'vim.rpcnotify(channel, "dashboard_test_done") end, 700)',
                self.nvim.channel_id,
            )

        self.nvim.run_loop(None, self.notify, setup)


def check(config, state, width, height, *, noice=True, file=None):
    argv = [
        "env",
        f"XDG_CONFIG_HOME={config.parent}",
        f"XDG_STATE_HOME={state}",
        f"TMPDIR={state.parent}",
        "nvim",
        "--embed",
        "-i",
        "NONE",
        "--cmd",
        "set noswapfile",
    ]
    if file:
        argv.append(str(file))
    nvim = pynvim.attach("child", argv=argv)
    try:
        screen = Screen(nvim)
        nvim.ui_attach(width, height, rgb=True, ext_linegrid=True)
        screen.collect()
        assert nvim.options["cmdheight"] == (0 if noice else 1)
        if file:
            assert Path(nvim.current.buffer.name).resolve() == file.resolve(), nvim.current.buffer.name
            assert not screen.header_rows, "Dashboard opened over a file"
        else:
            assert screen.header_rows, "No visible startup dashboard frame captured"
            first_row = screen.header_rows[0]
            dashboard = nvim.current.window.handle
            for _ in range(2):
                nvim.input(" e")
                screen.collect()
                assert nvim.api.win_get_width(dashboard) < width, "Explorer did not open"
                nvim.input(" e")
                screen.collect()
                assert nvim.api.win_get_width(dashboard) == width, "Explorer did not close"
            assert set(screen.header_rows) == {first_row}, (
                f"Dashboard shifted at {width}x{height}: {screen.header_rows}"
            )
        messages = nvim.command_output("messages")
        assert not messages, messages
        print(f"PASS {width}x{height}, noice={noice}, file={bool(file)}")
    finally:
        try:
            nvim.command("qa!")
        except EOFError:
            pass  # A successful quit closes the RPC connection.
        nvim.close()


def main():
    source = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="dashboard-frames-") as directory:
        task = Path(directory)
        config = task / "enabled" / "nvim"
        shutil.copytree(source, config)
        for width, height in [(140, 44), (140, 45), (140, 46), (100, 44), (80, 30)]:
            check(config, task / "state", width, height)
        example = task / "example.txt"
        example.write_text("Ordinary file startup\n")
        check(config, task / "state", 140, 44, file=example)
        disabled = task / "disabled" / "nvim"
        shutil.copytree(source, disabled)
        (disabled / "lua/plugins/test-noice-disabled.lua").write_text(
            'return { "folke/noice.nvim", enabled = false }\n'
        )
        check(disabled, task / "disabled-state", 140, 44, noice=False)


if __name__ == "__main__":
    main()
