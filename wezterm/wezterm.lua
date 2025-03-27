local wezterm = require("wezterm")

local config = wezterm.config_builder()

config.color_scheme = "Catppuccin Frappe"

config.window_padding = {
	left = "0.5cell",
	right = "0.5cell",
	top = 0,
	bottom = 0,
}

if wezterm.target_triple == "x86_64-pc-windows-msvc" then
	config.default_prog = { "pwsh" }
end

return config
