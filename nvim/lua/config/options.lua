-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

if (vim.env.SSH_CONNECTION or "") ~= "" or (vim.env.SSH_TTY or "") ~= "" then
  -- Full-line highlighting triggers cursor flashes through TUIOS over SSH.
  vim.opt.cursorlineopt = "number"

  -- Send both registers to the client clipboard; paste locally without OSC 52 reads.
  local copy = require("vim.ui.clipboard.osc52").copy("+")
  local clipboard = { name = "OSC 52", copy = {}, paste = {}, cache_enabled = 0 }
  for _, register in ipairs({ "+", "*" }) do
    local cached = { { "" }, "v" }
    clipboard.copy[register] = function(lines, regtype)
      cached = { lines, regtype }
      copy(lines)
    end
    clipboard.paste[register] = function()
      return cached
    end
  end
  vim.g.clipboard = clipboard
  vim.opt.clipboard = "unnamedplus"
end

vim.filetype.add({ extension = { "templ" } })

vim.g.vimtex_compiler_method = "tectonic"

if jit.os == "OSX" then
  vim.g.vimtex_view_method = "skim"
  vim.g.vimtex_view_skim_sync = 0
  -- Protect notes before both automatic and manual compilation can replace the PDF.
  vim.cmd([[let g:vimtex_compiler_tectonic = {'start': function('config#vimtex#start')}]])
end

if jit.os == "Windows" then
  vim.o.shell = "pwsh"

  vim.o.shellcmdflag =
    "-NoLogo -NoProfile -ExecutionPolicy RemoteSigned -Command [Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();$PSStyle.OutputRendering='PlainText';Remove-Alias -Force -ErrorAction SilentlyContinue tee;"

  -- Setting shell redirection
  vim.o.shellredir = '2>&1 | %%{ "$_" } | Out-File -Encoding UTF8 %s; exit $LastExitCode'

  -- Setting shell pipe
  vim.o.shellpipe = '2>&1 | %%{ "$_" } | tee %s; exit $LastExitCode'

  -- Setting shell quote options
  vim.o.shellquote = ""
  vim.o.shellxquote = ""
end
