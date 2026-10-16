-- Autocmds are automatically loaded on the VeryLazy event
-- Default autocmds that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/autocmds.lua
--
-- Add any additional autocmds here
-- with `vim.api.nvim_create_autocmd`
--
-- Or remove existing autocmds by their group name (which is prefixed with `lazyvim_` for the defaults)
-- e.g. vim.api.nvim_del_augroup_by_name("lazyvim_wrap_spell")

if jit.os == "OSX" then
  vim.api.nvim_create_autocmd("User", {
    group = vim.api.nvim_create_augroup("vimtex_skim_notes", { clear = true }),
    pattern = "VimtexEventInitPost",
    callback = function()
      if vim.b.vimtex.viewer and vim.b.vimtex.viewer.name == "Skim" then
        vim.cmd([[
          let b:vimtex.viewer.config_skim_callback = b:vimtex.viewer.compiler_callback
          let b:vimtex.viewer.compiler_callback = function('config#vimtex#refresh')
        ]])
      end
    end,
  })
end

local pending = {}
vim.api.nvim_create_autocmd("BufWritePost", {
  group = vim.api.nvim_create_augroup("vimtex_build_on_save", { clear = true }),
  pattern = { "*.tex", "*.bib" },
  callback = function(event)
    local state = vim.b[event.buf].vimtex
    if not state or not state.compiler or state.compiler.name ~= "tectonic" then
      return
    end

    local project = state.tex
    local queued = pending[project]
    pending[project] = event.buf
    if queued then
      return
    end

    local function build()
      local buf = pending[project]
      if not vim.api.nvim_buf_is_valid(buf) or not vim.api.nvim_buf_is_loaded(buf) then
        pending[project] = nil
        return
      end
      local current = vim.b[buf].vimtex
      if not current or current.tex ~= project then
        pending[project] = nil
        return
      end
      vim.api.nvim_buf_call(buf, function()
        -- Wait for the current build so saves during compilation are not lost.
        if vim.fn.eval("b:vimtex.compiler.is_running()") then
          vim.defer_fn(build, 200)
          return
        end
        pending[project] = nil
        local ok, err = pcall(vim.fn["vimtex#compiler#start"])
        if not ok then
          vim.notify(err, vim.log.levels.ERROR)
        end
      end)
    end
    build()
  end,
})
