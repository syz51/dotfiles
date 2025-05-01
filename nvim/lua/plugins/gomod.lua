return {
  dir = "~/Documents/go-mod.nvim",
  dependencies = { "nvim-lua/plenary.nvim" },
  ft = "gomod",
  opts = {
    -- Auto check on file open
    auto_check = true,
    -- Check interval in minutes (0 to disable)
    check_interval = 30,
    -- Log level: "trace", "debug", "info", "warn", "error"
    log_level = "info",
    -- Log file path
    log_file = vim.fn.stdpath("cache") .. "/go-mod.log",
  },
  keys = {
    { "<leader>gmc", "<cmd>GoModCheck<cr>", desc = "Check Go Dependencies" },
    { "<leader>gmt", "<cmd>GoModToggle<cr>", desc = "Toggle Go Dependencies" },
    { "<leader>gml", "<cmd>GoModLog<cr>", desc = "Open Go Dependencies Log" },
  },
}
