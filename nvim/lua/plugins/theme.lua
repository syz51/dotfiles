return {
  "catppuccin/nvim",
  lazy = false,
  name = "catppuccin",
  priority = 1000,
  opts = function()
    vim.cmd.colorscheme("catppuccin-frappe")
  end,
}
