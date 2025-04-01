return {
  "stevearc/conform.nvim",
  optional = true,
  opts = function(_, opts)
    opts.formatters.sqlfluff = {
      args = { "format", "-" },
    }
  end,
}
