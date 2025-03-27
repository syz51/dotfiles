-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

vim.filetype.add({ extension = { "templ" } })

if jit.os == "Windows" then
  local win_sh = nil
  if vim.fn.executable("pwsh") then
    win_sh = "pwsh"
  elseif vim.fn.executable("powershell") then
    win_sh = "powershell"
  end
  if win_sh then
    LazyVim.terminal.setup(win_sh)
  end
end
