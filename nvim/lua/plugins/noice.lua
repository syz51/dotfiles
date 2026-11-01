return {
  "folke/noice.nvim",
  init = function()
    -- Reserve Noice's final command-line height before the dashboard first renders.
    vim.opt.cmdheight = 0
  end,
}
