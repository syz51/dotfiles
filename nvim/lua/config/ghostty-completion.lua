local Source = {}
local actions = {
  theme = "+list-themes",
  ["font-family"] = "+list-fonts",
  ["font-family-bold"] = "+list-fonts",
  ["font-family-italic"] = "+list-fonts",
  ["font-family-bold-italic"] = "+list-fonts",
}

function Source.new()
  local resources = vim.env.GHOSTTY_RESOURCES_DIR or "/Applications/Ghostty.app/Contents/Resources/ghostty"
  local ok, lines = pcall(vim.fn.readfile, resources .. "/../bash-completion/completions/ghostty.bash")
  local values = {}
  if ok then
    for _, line in ipairs(lines) do
      local key, choices = line:match('%-%-([%w-]+)%) _compreply compgen %-W "([^"]+)"')
      local boolean = line:match([=[config%+=" '%-%-([%w-]+) '"]=])
      if key then
        values[key] = vim.split(choices, "%s+", { trimempty = true })
      elseif boolean then
        values[boolean] = { "true", "false" }
      end
    end
  end
  -- shortcut: cache per session; restart Neovim after updating Ghostty, fonts, or themes.
  return setmetatable({ cache = {}, values = values }, { __index = Source })
end

function Source:get_trigger_characters()
  local before = vim.api.nvim_get_current_line():sub(1, vim.api.nvim_win_get_cursor(0)[2])
  local key = before:match("^%s*([%w-]+)%s*=%s*$")
  return (actions[key] or self.values[key]) and { "=", " " } or {}
end

function Source:get_completions(ctx, callback)
  local before = ctx.line:sub(1, ctx.cursor[2])
  local key, start = before:match("^%s*([%w-]+)%s*=%s*()")
  local action = actions[key]
  local choices = self.values[key]
  local is_key = not before:find("=", 1, true)
  if not action and not choices and not is_key then
    callback({ items = {} })
    return
  end

  local themes = key == "theme"
  if is_key then
    start = before:find("%S") or (#before + 1)
  elseif ctx.line:sub(start, start) == '"' then
    start = start + 1
  end
  if themes or choices then
    local offset = before:sub(start):match(themes and ".*[,:]%s*()" or ".*,%s*()")
    start = offset and start + offset - 1 or start
  end
  local boundary = is_key and "[%s=]" or ((themes or choices) and '[,"]' or '"')
  local finish = (ctx.line:find(boundary, start) or (#ctx.line + 1)) - 1
  local function respond(values)
    local items = {}
    for _, value in ipairs(values) do
      items[#items + 1] = {
        label = value,
        data = { ghostty_option = key or value },
        textEdit = {
          newText = value,
          range = {
            start = { line = ctx.cursor[1] - 1, character = start - 1 },
            ["end"] = { line = ctx.cursor[1] - 1, character = finish },
          },
        },
      }
    end
    callback({ items = items, is_incomplete_forward = false, is_incomplete_backward = false })
  end

  if is_key then
    respond(vim.fn["syntaxcomplete#OmniSyntaxList"]())
    return
  end
  if choices then
    respond(choices)
    return
  end
  if self.cache[action] then
    respond(self.cache[action])
    return
  end
  local binary = vim.fn.exepath("ghostty")
  if binary == "" then
    binary = "/Applications/Ghostty.app/Contents/MacOS/ghostty"
  end
  if vim.fn.executable(binary) == 0 then
    respond({})
    return
  end
  local command = { binary, action }
  if themes then
    command[#command + 1] = "--plain"
  end
  vim.system(command, { text = true, timeout = 3000 }, function(result)
    vim.schedule(function()
      local values = {}
      if result.code == 0 then
        for line in (result.stdout or ""):gmatch("[^\r\n]+") do
          if line:match("^%S") then
            values[#values + 1] = themes and line:gsub(" %([^()]*%)$", "") or line
          end
        end
        self.cache[action] = values
      end
      respond(values)
    end)
  end)
end

function Source:resolve(item, callback)
  item = vim.deepcopy(item)
  local contents = require("config.ghostty-docs").get(item.data.ghostty_option)
  if contents then
    item.documentation = { kind = "markdown", value = table.concat(contents, "\n") }
  end
  callback(item)
end

return Source
