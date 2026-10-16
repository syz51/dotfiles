-- Load the bundled settings before extending their cleanup.
vim.cmd("runtime! ftplugin/ghostty.vim")

vim.keymap.set("n", "K", function()
  local key = vim.api.nvim_get_current_line():match("^%s*([%w-]+)%s*=")
  if not key then
    return
  end
  local contents, err, level = require("config.ghostty-docs").get(key)
  if not contents then
    vim.notify(assert(err), level)
    return
  end
  vim.lsp.util.open_floating_preview(contents, "markdown", {
    border = "rounded",
    focus_id = "ghostty_docs",
  })
end, { buffer = true, desc = "Ghostty option documentation" })

local undo = vim.b.undo_ftplugin
vim.b.undo_ftplugin = (undo and undo .. " | " or "") .. "silent! nunmap <buffer> K"
