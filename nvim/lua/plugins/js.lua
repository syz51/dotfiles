return {
  "vuki656/package-info.nvim",
  ft = "json",
  dependencies = "MunifTanjim/nui.nvim",
  keys = {
    {
      "<leader>ns",
      function()
        require("package-info").show({ force = true })
      end,
      desc = "Force Refresh Package Info",
    },
  },
  opts = function()
    local colors = require("catppuccin.palettes").get_palette("frappe")
    vim.cmd([[highlight PackageInfoOutdatedVersion guifg=]] .. colors.peach)

    return {
      package_manager = "pnpm",
      hide_up_to_date = true,
    }
  end,
}
