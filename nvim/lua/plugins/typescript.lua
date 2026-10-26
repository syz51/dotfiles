return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      -- Use each project's TypeScript and Oxlint versions.
      servers = { tsc = { mason = false }, oxlint = { mason = false } },
    },
  },
  {
    "stevearc/conform.nvim",
    opts = function(_, opts)
      -- Keep Prettier formatting when enabling the Oxc extra for Oxlint.
      for _, formatters in pairs(opts.formatters_by_ft or {}) do
        if type(formatters) == "table" then
          for i = #formatters, 1, -1 do
            if formatters[i] == "oxfmt" then
              table.remove(formatters, i)
            end
          end
        end
      end
    end,
  },
  {
    "mason-org/mason.nvim",
    opts = function(_, opts)
      opts.ensure_installed = vim.tbl_filter(function(tool)
        return tool ~= "oxfmt"
      end, opts.ensure_installed or {})
    end,
  },
}
