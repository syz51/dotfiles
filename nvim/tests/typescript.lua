-- Run from ~/.config/nvim: nvim --headless -u NONE -i NONE -l tests/typescript.lua
local specs = dofile("lua/plugins/typescript.lua")
local servers = specs[1].opts.servers
assert(servers.tsc.mason == false and servers.oxlint.mason == false)

local dynamic = function()
  return { "prettier" }
end
local opts = {
  formatters_by_ft = {
    typescript = { "oxfmt", "prettier", "oxfmt", lsp_format = "never", stop_after_first = true },
    lua = { "stylua" },
    markdown = dynamic,
  },
  formatters = { prettier = { require_cwd = true } },
}
specs[2].opts(nil, opts)
assert(
  vim.deep_equal(opts.formatters_by_ft.typescript, {
    "prettier",
    lsp_format = "never",
    stop_after_first = true,
  }),
  "Oxfmt removal must preserve formatter order and filetype options"
)
assert(vim.deep_equal(opts.formatters_by_ft.lua, { "stylua" }))
assert(opts.formatters_by_ft.markdown == dynamic, "Dynamic formatter selection must remain intact")
assert(opts.formatters.prettier.require_cwd, "Formatter definitions must remain intact")
specs[2].opts(nil, {})

local mason = { ensure_installed = { "prettier", "oxfmt", "stylua" } }
specs[3].opts(nil, mason)
assert(vim.deep_equal(mason.ensure_installed, { "prettier", "stylua" }))
specs[3].opts(nil, {})
print("TypeScript formatter and project-tool checks passed")
