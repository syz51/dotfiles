return {
  {
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
    opts = {
      colors = {
        up_to_date = "#98c379", -- Text color for up to date dependency virtual text
        outdated = "#d19a66", -- Text color for outdated dependency virtual text
      },
    },
    config = function(_, opts)
      require("package-info").setup(opts)

      -- manually register them
      vim.cmd([[highlight PackageInfoUpToDateVersion guifg=]] .. opts.colors.up_to_date)
      vim.cmd([[highlight PackageInfoOutdatedVersion guifg=]] .. opts.colors.outdated)
    end,
  },
}
