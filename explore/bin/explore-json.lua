-- JSON codec for the shell helpers, using the existing Neovim dependency.
local function main()
  local operation = arg[1]
  if operation == "argv" then
    io.stdout:write(vim.json.encode(vim.list_slice(arg, 2)))
    return
  end
  local value = vim.json.decode(io.read("*a"))
  if operation == "string" then
    assert(type(value) == "string" and value:sub(1, 1) == "/", "expected absolute path")
    assert(not value:find("\0", 1, true), "invalid path")
    io.stdout:write(value)
  elseif operation == "pane" then
    local row
    for _, candidate in ipairs(value.windows or {}) do
      if candidate.window_id == arg[2] then
        assert(not row, "ambiguous active pane")
        row = candidate
      end
    end
    assert(row, "active pane is unavailable")
    -- The explorer owns this reserved popup name. list-windows does not
    -- currently report its persisted popup bit on all tuios versions.
    local popup = row.popup == true or row.custom_name == "explore"
    local pid = row.pid or row.shell_pid or 0
    assert(type(pid) == "number" and pid >= 0 and pid % 1 == 0, "invalid pane pid")
    local cwd = type(row.cwd) == "string" and row.cwd or ""
    assert(not cwd:find("\0", 1, true), "invalid pane cwd")
    io.stdout:write(popup and "popup" or "pane", "\0", tostring(pid), "\0", cwd, "\0")
  else
    error("invalid codec operation")
  end
end

local ok, err = pcall(main)
if not ok then
  io.stderr:write("explore: ", tostring(err), "\n")
  os.exit(1)
end
