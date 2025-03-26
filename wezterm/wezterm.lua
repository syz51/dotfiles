local wezterm = require("wezterm")

local config = wezterm.config_builder()

config.default_prog = { "powershell.exe" }
config.color_scheme = "Catppuccin Frappe"

config.window_padding = {
	left = "0.5cell",
	right = "0.5cell",
	top = 0,
	bottom = 0,
}

return config
