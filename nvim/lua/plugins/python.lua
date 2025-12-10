return {
  {
    "linux-cultist/venv-selector.nvim",
    dependencies = { "folke/snacks.nvim" },
    opts = {
      name = ".venv",
    },
    event = "VeryLazy",
    keys = {
      { "<leader>cvs", "<cmd>VenvSelect<cr>" },
      { "<leader>cvc", "<cmd>VenvSelectCached<cr>" },
    },
  },
}
