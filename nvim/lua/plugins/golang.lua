return {
  "neovim/nvim-lspconfig",
  opts = {
    servers = {
      gopls = {
        settings = {
          gopls = {
            analyses = {
              ST1000 = false,
            },
          },
        },
      },
    },
  },
}
