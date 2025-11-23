return {
  "stevearc/conform.nvim",
  optional = true,
  opts = {
    formatters = {
      sqlfluff = {
        args = { "format", "-" },
      },
    },
  },
}
