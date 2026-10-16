-- Run from ~/.config/nvim: nvim --headless -u NONE -l tests/ghostty-completion.lua
-- API replacements are intentional test doubles and are restored below.
---@diagnostic disable: duplicate-set-field
local Source = dofile("lua/config/ghostty-completion.lua")
local readfile = vim.fn.readfile
local missing_metadata = false
vim.fn.readfile = function(path)
  if path:match("/bash%-completion/completions/ghostty%.bash$") then
    assert(not missing_metadata, "Shell completions unavailable")
    return {
      [[config+=" '--mouse-hide-while-typing '"]],
      [[config+=" '--cursor-style-blink '"]],
      [[config+=" --font-size="]],
      [[--cursor-style) _compreply compgen -W "bar block underline block_hollow" -- "$cur"; _add_spaces ;;]],
      [[--window-theme) _compreply compgen -W "auto system light dark ghostty" -- "$cur"; _add_spaces ;;]],
      [[--confirm-close-surface) _compreply compgen -W "false true always" -- "$cur"; _add_spaces ;;]],
      [[--font-synthetic-style) _compreply compgen -W "bold no-bold italic no-italic" -- "$cur"; _add_spaces ;;]],
    }
  end
  return readfile(path)
end
local source = Source.new()
local system, executable = vim.system, vim.fn.executable
local syntax_list = vim.fn["syntaxcomplete#OmniSyntaxList"]
local docs = require("config.ghostty-docs")
local get_docs = docs.get
vim.fn["syntaxcomplete#OmniSyntaxList"] = function()
  return { "font-family", "theme" }
end
docs.get = function(key)
  return { "Documentation for " .. key }
end
local calls, fail = 0, false
vim.fn.executable = function()
  return 1
end
---@param command string[]
---@param _ vim.SystemOpts
---@param callback fun(result: vim.SystemCompleted)
local function mock_system(command, _, callback)
  calls = calls + 1
  callback({
    code = fail and 1 or 0,
    signal = 0,
    stdout = command[2] == "+list-themes" and "Catppuccin Frappe (resources)\nNocturne (user)\n"
      or "JetBrains Mono\n  JetBrains Mono Regular\n\nMenlo\n  Menlo Bold\n",
  })
end
vim.system = mock_system

local function complete(line, cursor)
  local response
  source:get_completions({ line = line, cursor = { 1, cursor or #line } }, function(result)
    response = result
  end)
  assert(vim.wait(1000, function()
    return response ~= nil
  end), "Completion did not respond")
  return response.items
end

local function apply(line, item)
  local edit = item.textEdit
  return line:sub(1, edit.range.start.character) .. edit.newText .. line:sub(edit.range["end"].character + 1)
end

local function check_docs(item, key)
  local resolved
  source:resolve(item, function(result)
    resolved = result
  end)
  assert(resolved.documentation.kind == "markdown")
  assert(resolved.documentation.value == "Documentation for " .. key, "Documentation belongs to the wrong option")
  assert(not item.documentation, "Resolving documentation changed the original completion item")
end

local function triggers(line)
  vim.api.nvim_buf_set_lines(0, 0, -1, false, { line })
  vim.wo.virtualedit = "onemore"
  vim.api.nvim_win_set_cursor(0, { 1, #line })
  return source:get_trigger_characters()
end

local ok, err = pcall(function()
  for _, line in ipairs({
    "cursor-style=",
    "window-theme = ",
    "cursor-style-blink = ",
    "theme = ",
    "font-family = ",
  }) do
    assert(vim.deep_equal(triggers(line), { "=", " " }), "Empty value did not enable triggers: " .. line)
  end
  for _, line in ipairs({ " ", "cursor-style ", "font-size = ", "# theme = ", "theme = Cat " }) do
    assert(#triggers(line) == 0, "Unexpected value trigger: " .. line)
  end
  local blocked = dofile("lua/plugins/completion.lua").opts.completion.trigger.show_on_blocked_trigger_characters
  vim.bo.filetype = "ghostty"
  assert(vim.deep_equal(blocked(), { "\n", "\t" }))
  vim.bo.filetype = "text"
  assert(vim.deep_equal(blocked(), { " ", "\n", "\t" }), "Other filetype triggers changed")
  assert(#complete("# theme = Cat") == 0)
  assert(#complete("font-size = 18") == 0)
  assert(#complete("font-family-unknown = Men") == 0)
  assert(calls == 0, "Unrelated options started Ghostty")
  local keys = complete("font-fa = Menlo", #"font-fa")
  assert(apply("font-fa = Menlo", keys[1]) == "font-family = Menlo", "Key completion changed the existing value")
  check_docs(keys[1], "font-family")
  check_docs(keys[2], "theme")
  assert(calls == 0, "Key completion started Ghostty")
  for key, expected in pairs({
    ["cursor-style"] = { "bar", "block", "underline", "block_hollow" },
    ["window-theme"] = { "auto", "system", "light", "dark", "ghostty" },
    ["mouse-hide-while-typing"] = { "true", "false" },
    ["cursor-style-blink"] = { "true", "false" },
    ["confirm-close-surface"] = { "false", "true", "always" },
  }) do
    local items = complete(key .. " = ")
    assert(vim.deep_equal(vim.tbl_map(function(item)
      return item.label
    end, items), expected), "Wrong allowed values for " .. key)
    check_docs(items[1], key)
  end
  local flags = "font-synthetic-style = bold, it"
  assert(apply(flags, complete(flags)[3]) == "font-synthetic-style = bold, italic", "Existing flags were overwritten")
  assert(
    apply('window-theme = "da"', complete('window-theme = "da"', #('window-theme = "da'))[4]) == 'window-theme = "dark"'
  )
  assert(calls == 0, "Allowed values started a Ghostty process")

  fail = true
  assert(#complete("theme = Cat") == 0, "CLI failure should return no items")
  fail = false
  local themes = complete("theme = Cat")
  assert(themes[1].label == "Catppuccin Frappe")
  assert(themes[2].label == "Nocturne", "Custom theme was not included")
  check_docs(themes[1], "theme")
  assert(apply("theme = Cat", themes[1]) == "theme = Catppuccin Frappe")
  assert(apply('theme = "Cat"', complete('theme = "Cat"', 12)[1]) == 'theme = "Catppuccin Frappe"')
  local line = "theme = dark:Cat,light:Nocturne"
  assert(apply(line, complete(line, 15)[1]) == "theme = dark:Catppuccin Frappe,light:Nocturne")

  for _, key in ipairs({ "font-family", "font-family-bold", "font-family-italic", "font-family-bold-italic" }) do
    local fonts = complete(key .. " = JetBrains M")
    assert(#fonts == 2, "Font faces should not be included as family names")
    check_docs(fonts[1], key)
    assert(apply(key .. " = JetBrains M", fonts[1]) == key .. " = JetBrains Mono")
  end
  local line_with_suffix = "font-family = JetBrains Old"
  assert(
    apply(line_with_suffix, complete(line_with_suffix, #"font-family = JetBrains")[1]) == "font-family = JetBrains Mono"
  )
  assert(calls == 3, "Theme and font lists were not cached")
  vim.fn.executable = function()
    return 0
  end
  source = Source.new()
  assert(#complete("theme = Cat") == 0, "Missing Ghostty should return no items")
  assert(calls == 3, "Missing Ghostty started a process")
  missing_metadata = true
  source = Source.new()
  assert(#complete("cursor-style = b") == 0, "Missing metadata should return no guessed values")
end)
vim.system, vim.fn.executable = system, executable
vim.fn.readfile = readfile
vim.fn["syntaxcomplete#OmniSyntaxList"], docs.get = syntax_list, get_docs
assert(ok, err)
print("Ghostty value completion checks passed")
