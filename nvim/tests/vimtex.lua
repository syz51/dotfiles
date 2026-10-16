-- Run from ~/.config/nvim: nvim --headless -u NONE -i NONE -l tests/vimtex.lua
local dir = vim.fn.tempname() .. " vimtex test"
local path = vim.env.PATH
local tectonic = vim.fn.exepath("tectonic")
assert(tectonic ~= "", "Tectonic must be installed")
vim.fn.mkdir(dir, "p")
dir = assert(vim.uv.fs_realpath(dir))
-- Keep the first build busy long enough to exercise saves during compilation.
vim.fn.writefile({ "#!/bin/sh", "sleep 0.3", "exec " .. vim.fn.shellescape(tectonic) .. ' "$@"' }, dir .. "/tectonic")
vim.fn.setfperm(dir .. "/tectonic", "rwx------")
vim.env.PATH = dir .. ":" .. path
vim.fn.writefile({
  [[\documentclass{article}]],
  [[\begin{document}]],
  [[\input{part}]],
  [[\bibliographystyle{plain}]],
  [[\bibliography{refs}]],
  [[\end{document}]],
}, dir .. "/main.tex")
vim.fn.writefile({ "% !TEX root = main.tex", [[A citation: \cite{sample}.]] }, dir .. "/part.tex")
vim.fn.writefile({
  "% !TEX root = main.tex",
  "@book{sample, author={Example Author}, title={Original Title}, year={2026}, publisher={Example Press}}",
}, dir .. "/refs.bib")

dofile("lua/config/options.lua")
vim.g.vimtex_view_enabled = 0 -- Tests must not launch GUI applications.
vim.g.vimtex_quickfix_mode = 0
vim.g.vimtex_cache_persistent = 0
vim.opt.rtp:prepend(vim.fn.stdpath("data") .. "/lazy/vimtex")
vim.cmd("filetype plugin on")
dofile("lua/config/autocmds.lua")
local started = 0
vim.api.nvim_create_autocmd("User", {
  pattern = "VimtexEventCompileStarted",
  callback = function()
    started = started + 1
  end,
})

local function edit(name, ft)
  vim.cmd.edit(vim.fn.fnameescape(dir .. "/" .. name))
  vim.cmd("setfiletype " .. ft)
end

local ok, err = xpcall(function()
  edit("main.tex", "tex")
  local main = vim.api.nvim_get_current_buf()
  local mainfile = vim.b.vimtex.tex
  assert(vim.b.vimtex.compiler.name == "tectonic")
  if jit.os == "OSX" then
    assert(vim.g.vimtex_view_method == "skim")
    assert(vim.g.vimtex_view_skim_sync == 0, "Rebuilds must not jump to the source line")
  end

  local function wait_for_builds(count)
    assert(
      vim.wait(45000, function()
        return started == count and vim.b[main].vimtex.compiler.status == 2
      end, 50),
      "Expected " .. count .. " successful builds, got " .. started
    )
    assert(vim.fn.filereadable(dir .. "/main.pdf") == 1, "No PDF generated")
  end

  vim.cmd.write()
  assert(started == 1, "Saving must start a build")
  vim.cmd.write()
  vim.cmd.write()
  edit("unrelated.txt", "text")
  vim.cmd.write()
  wait_for_builds(2)
  assert(started == 2, "Rapid saves must queue only one follow-up build")

  edit("part.tex", "tex")
  assert(vim.b.vimtex.tex == mainfile, "Included file lost its main document: " .. vim.b.vimtex.tex)
  vim.cmd.write()
  wait_for_builds(3)

  local before = vim.fn.sha256(table.concat(vim.fn.readfile(dir .. "/main.pdf", "b"), "\n"))
  edit("refs.bib", "bib")
  assert(vim.b.vimtex.tex == mainfile, "Bibliography lost its main document: " .. vim.b.vimtex.tex)
  vim.cmd([[silent %s/Original Title/Updated Title/]])
  vim.cmd.write()
  wait_for_builds(4)
  local after = vim.fn.sha256(table.concat(vim.fn.readfile(dir .. "/main.pdf", "b"), "\n"))
  assert(before ~= after, "Bibliography edit did not update the PDF")
end, debug.traceback)
vim.fn["vimtex#compiler#stop_all"]()
vim.cmd("silent! %bwipeout!")
vim.env.PATH = path
vim.fn.delete(dir, "rf")
assert(ok, err)
print("VimTeX save/rebuild, queued saves, included files, bibliography, and Skim configuration checks passed")
