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
    vim.cmd([[highlight PackageInfoUpToDateVersion guifg=]] .. "#98c379")
    vim.cmd([[highlight PackageInfoOutdatedVersion guifg=]] .. "#d19a66")
  end,
}
