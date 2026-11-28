-- Run from ~/.config: nvim --headless -u NONE -i NONE -l nvim/tests/lazy.lua
---@diagnostic disable: duplicate-set-field
local lazy_config = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h") .. "/lua/config/lazy.lua"
local uv = vim.uv or vim.loop
local original_fs_stat = uv.fs_stat
local original_lazy = package.loaded.lazy
local original_rtp = vim.opt.rtp:get()
local setup_opts = nil

uv.fs_stat = function(path)
  if path == vim.fn.stdpath("data") .. "/lazy/lazy.nvim" then
    return { type = "directory" }
  end
  return original_fs_stat(path)
end
package.loaded.lazy = {
  setup = function(opts)
    setup_opts = opts
  end,
}

local ok, err = pcall(function()
  dofile(lazy_config)
  assert(type(setup_opts) == "table", "lazy.setup must receive an options table")
  local expected = vim.fn.stdpath("state") .. "/lazy-lock.json"
  assert(
    setup_opts.lockfile == expected,
    "lazy.nvim lockfile must live in stdpath('state'): expected "
      .. expected
      .. ", got "
      .. tostring(setup_opts.lockfile)
  )
  local config_dir = vim.fn.stdpath("config") .. "/"
  assert(
    setup_opts.lockfile:sub(1, #config_dir) ~= config_dir,
    "lazy.nvim lockfile must not live inside stdpath('config'): " .. tostring(setup_opts.lockfile)
  )
end)

uv.fs_stat = original_fs_stat
package.loaded.lazy = original_lazy
vim.opt.rtp = original_rtp

if not ok then
  error(err)
end
print("lazy.nvim lockfile checks passed")
