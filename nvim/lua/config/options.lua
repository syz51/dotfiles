-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

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
