-- Run from ~/.config: nvim --headless -u NONE -i NONE -l nvim/tests/clipboard.lua
-- Only terminal output is replaced; provider/register/yank/paste behavior is real.
---@diagnostic disable: duplicate-set-field
local options = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h") .. "/lua/config/options.lua"
local original_send = vim.api.nvim_ui_send
local original_connection, original_tty = vim.env.SSH_CONNECTION, vim.env.SSH_TTY
local sent = {}
vim.api.nvim_ui_send = function(sequence)
  sent[#sent + 1] = sequence
end

local function equal(actual, expected, message)
  assert(vim.deep_equal(actual, expected), (message or "Mismatch") .. ": " .. vim.inspect(actual))
end

local function buffer(lines)
  vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)
  vim.api.nvim_win_set_cursor(0, { 1, 0 })
end

local function normal(keys)
  vim.cmd.normal({ args = { keys }, bang = true })
end

local function copied(payload)
  equal(sent, { "\027]52;c;" .. vim.base64.encode(payload) .. "\027\\" }, "OSC 52 write")
  sent = {}
end

local function pasted(keys, expected)
  normal(keys)
  equal(vim.api.nvim_buf_get_lines(0, 0, -1, false), expected, "Paste contents")
  equal(sent, {}, "Paste must not send OSC 52 reads or writes")
end

local ok, err = pcall(function()
  -- Leave local provider selection and options alone, including a GUI's provider.
  for _, environment in ipairs({ {}, { "", "" } }) do
    vim.env.SSH_CONNECTION, vim.env.SSH_TTY = environment[1], environment[2]
    for _, provider in ipairs({ false, "pbcopy", "GUI clipboard" }) do
      vim.g.clipboard = provider or nil
      vim.opt.clipboard = "unnamed"
      dofile(options)
      equal(vim.g.clipboard, provider or nil, "Local provider changed")
      equal(vim.o.clipboard, "unnamed", "Local clipboard option changed")
    end
  end

  for _, environment in ipairs({ { "client 123 server 22", "" }, { "", "/dev/ttys001" } }) do
    vim.env.SSH_CONNECTION, vim.env.SSH_TTY = environment[1], environment[2]
    vim.g.clipboard = "pbcopy"
    vim.opt.clipboard = ""
    dofile(options)
    equal(vim.o.clipboard, "unnamedplus", "SSH ordinary yanks are not enabled")
    equal(vim.fn["provider#clipboard#Executable"](), "OSC 52", "SSH provider selection")
    equal(vim.fn.getreg("+", 1, true), { "" }, "Initial cache")
    equal(sent, {}, "Initial paste must not query terminal")

    buffer({ "remote α", "second" })
    normal("yy")
    copied("remote α\n")
    equal(vim.fn.getregtype("+"), "V", "Ordinary yy register type")
    pasted("p", { "remote α", "remote α", "second" })

    buffer({ "abcdef" })
    normal("v2ly")
    copied("abc")
    equal(vim.fn.getregtype("+"), "v", "Visual characterwise register type")
    buffer({ "x" })
    pasted("p", { "xabc" })

    -- Both explicit registers use the client's standard clipboard and retain
    -- independent characterwise, linewise, and blockwise paste metadata.
    for _, register in ipairs({ "+", "*" }) do
      buffer({ "abcdef" })
      normal('"' .. register .. "yiw")
      copied("abcdef")
      equal(vim.fn.getregtype(register), "v")
      buffer({ "x" })
      pasted('"' .. register .. "p", { "xabcdef" })

      buffer({ "first", "second" })
      normal('"' .. register .. "yy")
      copied("first\n")
      equal(vim.fn.getregtype(register), "V")
      buffer({ "x" })
      pasted('"' .. register .. "p", { "x", "first" })

      buffer({ "abcd", "efgh" })
      normal('\022jl"' .. register .. "y")
      copied("ab\nef\n")
      equal(vim.fn.getregtype(register), "\0222", "Blockwise register type")
      buffer({ "X--", "Y--" })
      pasted('"' .. register .. "p", { "Xab--", "Yef--" })
    end

    vim.fn.setreg("+", "plus", "v")
    copied("plus")
    vim.fn.setreg("*", { "star" }, "V")
    copied("star\n")
    equal(vim.fn.getreg("+", 1, true), { "plus" }, "Plus cache overwritten by star")
    equal(vim.fn.getregtype("+"), "v")
    equal(vim.fn.getreg("*", 1, true), { "star" }, "Star cache")
    equal(vim.fn.getregtype("*"), "V")
    equal(sent, {}, "Cache reads must not query terminal")
  end
end)

vim.api.nvim_ui_send = original_send
vim.env.SSH_CONNECTION, vim.env.SSH_TTY = original_connection, original_tty
if not ok then
  error(err)
end
print("clipboard tests passed")
