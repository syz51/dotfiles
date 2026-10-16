-- Run from ~/.config/nvim: nvim --headless -u NONE -l tests/ghostty-docs.lua
-- API replacements are intentional test doubles and are restored below.
---@diagnostic disable: duplicate-set-field
vim.cmd("filetype plugin on")
vim.bo.filetype = "ghostty"
dofile("ftplugin/ghostty.lua")
local readfile, preview, notify = vim.fn.readfile, vim.lsp.util.open_floating_preview, vim.notify
local shown, message, fail
vim.fn.readfile = function()
  assert(not fail, "Documentation unavailable")
  return {
    "**`font-family`**",
    ":   The font families to use.",
    "    ",
    "        ghostty +list-fonts",
    "**`font-family-bold`**",
    "",
    "**`theme`**",
    ":   Select a theme.",
  }
end
vim.lsp.util.open_floating_preview = function(lines, syntax)
  assert(syntax == "markdown")
  shown = table.concat(lines, "\n")
end
vim.notify = function(text)
  message = text
end

local function hover(line)
  shown, message = nil, nil
  vim.api.nvim_buf_set_lines(0, 0, -1, false, { line })
  vim.api.nvim_win_set_cursor(0, { 1, #line - 1 })
  vim.fn.maparg("K", "n", false, true).callback()
end

local ok, err = pcall(function()
  hover("font-family = Menlo")
  assert(shown:find("The font families to use", 1, true))
  assert(shown:find("    ghostty +list-fonts", 1, true), "Code block indentation was lost")
  assert(not shown:find("Select a theme", 1, true), "Next option leaked into hover")
  hover("font-family-bold = Menlo")
  assert(shown:find("The font families to use", 1, true), "Alias documentation missing")
  hover("theme = Catppuccin Frappe")
  assert(shown:find("Select a theme", 1, true))
  hover("# theme = Catppuccin Frappe")
  assert(not shown and not message, "Comments should not trigger documentation")
  hover("unknown-option = true")
  assert(not shown and message:find("No bundled documentation", 1, true))
  fail = true
  hover("theme = Catppuccin Frappe")
  assert(not shown and message:find("Could not read", 1, true))
  vim.bo.filetype = "text"
  assert(vim.fn.maparg("K", "n", false, true).buffer ~= 1, "Ghostty mapping leaked to another filetype")
end)
vim.fn.readfile, vim.lsp.util.open_floating_preview, vim.notify = readfile, preview, notify
assert(ok, err)
print("Ghostty documentation checks passed")
