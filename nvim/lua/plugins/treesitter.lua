return {
  "nvim-treesitter/nvim-treesitter",
  opts = function(_, opts)
    require("nvim-treesitter.install").prefer_git = false

    vim.list_extend(opts.ensure_installed, {
      "css",
      "templ",
      "graphql",
      "powershell",
      "proto",
      "java",
    })
  end,
}
