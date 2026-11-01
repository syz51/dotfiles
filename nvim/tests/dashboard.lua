-- Run from ~/.config/nvim: nvim --headless -u NONE -i NONE -l tests/dashboard.lua
local original_snacks = _G.Snacks
local updates = {}
_G.Snacks = {
  dashboard = {
    update = function()
      updates[#updates + 1] = { laststatus = vim.o.laststatus, cmdheight = vim.o.cmdheight }
    end,
  },
}

local function drain()
  local done = false
  vim.schedule(function()
    done = true
  end)
  assert(
    vim.wait(1000, function()
      return done
    end),
    "Scheduled startup callbacks did not run"
  )
end

local group = vim.api.nvim_create_augroup("dashboard_startup_test", { clear = true })
local ok, err = pcall(function()
  vim.bo.filetype = "snacks_dashboard"
  vim.o.laststatus, vim.o.cmdheight = 0, 1
  -- LazyVim loads config.autocmds inside VeryLazy, before other handlers
  -- finish configuring the status line and command line.
  vim.api.nvim_create_autocmd("User", {
    group = group,
    pattern = "VeryLazy",
    once = true,
    callback = function()
      dofile("lua/config/autocmds.lua")
      assert(#updates == 0, "Dashboard refreshed before startup handlers finished")
    end,
  })
  vim.api.nvim_create_autocmd("User", {
    group = group,
    pattern = "VeryLazy",
    once = true,
    callback = function()
      vim.o.laststatus, vim.o.cmdheight = 3, 0
    end,
  })
  vim.api.nvim_exec_autocmds("User", { pattern = "VeryLazy" })
  drain()
  assert(vim.deep_equal(updates, { { laststatus = 3, cmdheight = 0 } }), "Dashboard used stale startup geometry")
  drain()
  assert(#updates == 1, "Startup refresh repeated")

  -- File startup needs no dashboard/plugin access, including when the user
  -- leaves the dashboard before the queued refresh runs.
  _G.Snacks = nil
  vim.bo.filetype = "lua"
  dofile("lua/config/autocmds.lua")
  drain()
  vim.bo.filetype = "snacks_dashboard"
  dofile("lua/config/autocmds.lua")
  vim.bo.filetype = "text"
  drain()
end)

vim.api.nvim_del_augroup_by_id(group)
_G.Snacks = original_snacks
assert(ok, err)
print("Dashboard startup checks passed")
