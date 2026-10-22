-- Run from ~/.config/nvim: nvim --headless -u NONE -i NONE -l tests/rust.lua
-- API replacements are intentional test doubles and are restored below.
---@diagnostic disable: duplicate-set-field
local auto_attach = dofile("lua/plugins/rust.lua").opts.server.auto_attach
local system, exepath, notify_once = vim.system, vim.fn.exepath, vim.notify_once
local executable = "/test/rust-analyzer"
local result = { code = 0, stderr = "" }
local calls, messages = 0, {}
vim.fn.exepath = function(binary)
  assert(binary == "rust-analyzer")
  return executable
end
vim.system = function(command, opts)
  calls = calls + 1
  assert(vim.deep_equal(command, { executable, "--version" }))
  assert(opts.text)
  if executable == "" then
    error("executable missing")
  end
  return {
    wait = function(_, timeout)
      assert(timeout == 3000)
      return result
    end,
  }
end
vim.notify_once = function(message, level)
  assert(level == vim.log.levels.ERROR)
  messages[#messages + 1] = message
end

local ok, err = pcall(function()
  assert(not auto_attach(0), "Unnamed buffers should not start a server")
  assert(calls == 0)
  vim.api.nvim_buf_set_name(0, "/tmp/rust-guard-check.rs")
  vim.bo.buftype = "nofile"
  assert(not auto_attach(0), "Special buffers should not start a server")
  assert(calls == 0)
  vim.bo.buftype = ""
  assert(auto_attach(0), "A working server should attach")
  assert(#messages == 0)

  result = { code = 1, stderr = "error: Unknown binary 'rust-analyzer' in official toolchain 'stable'.\n" }
  assert(not auto_attach(0), "A rustup launcher without its component should not attach")
  assert(messages[#messages]:find("Unknown binary", 1, true))
  assert(messages[#messages]:find("rustup component add rust-analyzer", 1, true))
  assert(messages[#messages]:find(":RustAnalyzer start", 1, true))

  result = { code = 124, stderr = "" }
  assert(not auto_attach(0), "A timed-out version check should not attach")
  executable = ""
  assert(not auto_attach(0), "A missing executable should not attach")
  assert(messages[#messages]:find("not found in PATH", 1, true))

  executable = "/test/rust-analyzer"
  result = { code = 0, stderr = "" }
  assert(auto_attach(0), "Installing the component should allow a retry without restarting Neovim")
end)
vim.system, vim.fn.exepath, vim.notify_once = system, exepath, notify_once
assert(ok, err)
print("Rust startup guard checks passed")
