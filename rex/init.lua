-- Rex terminal & multiplexer configuration (from scratch; keeps Rex defaults).
-- Reload after edits with: rex config reload
-- Validate before reload with: rex config check

-- Load optional machine-local overrides (gitignored), e.g. private rex.host{}
-- entries or per-Mac bindings. Re-raise errors if local.lua exists or fails.
local ok, err = pcall(require, "local")
if not ok and not tostring(err):match("module '?local'? not found:") then
  error(err, 0)
end
