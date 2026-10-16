local M = {}

---@param key string
---@return string[]? contents
---@return string? err
---@return integer? level
function M.get(key)
  local resources = vim.env.GHOSTTY_RESOURCES_DIR or "/Applications/Ghostty.app/Contents/Resources/ghostty"
  local ok, lines = pcall(vim.fn.readfile, resources .. "/doc/ghostty.5.md")
  if not ok then
    return nil, "Could not read Ghostty's bundled documentation: " .. tostring(lines), vim.log.levels.WARN
  end

  local contents, section, found = {}, {}, false
  for _, line in ipairs(lines) do
    local heading = line:match("^%*%*`([^`]+)`%*%*$")
    if heading then
      if found then
        break
      end
      if vim.trim(table.concat(section, "\n")) ~= "" then
        contents = section
      end
      section = {}
      found = heading == key
    else
      section[#section + 1] = line:gsub("^[: ]   ", "")
    end
  end
  if not found then
    return nil, "No bundled documentation for Ghostty option: " .. key, vim.log.levels.INFO
  end
  if vim.trim(table.concat(section, "\n")) ~= "" then
    contents = section
  end
  return vim.list_extend({ "# `" .. key .. "`", "" }, contents)
end

return M
