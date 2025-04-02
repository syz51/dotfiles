return {
  "williamboman/mason.nvim",
  opts = function(_, opts)
    vim.list_extend(opts.ensure_installed, {
      "templ",
      "graphql-language-service-cli",
      "powershell-editor-services",
      "pbls",
      "markdownlint-cli2",
      "markdown-toc",
    })
  end,
}
