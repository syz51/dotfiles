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
      package_manager = "bun",
      hide_up_to_date = true,
    }
  end,
  config = function(_, opts)
    local config = require("package-info.config")
    local commands = require("package-info.utils.commands")
    local version_list, outdated = commands.version_list, commands.outdated

    ---@diagnostic disable-next-line: duplicate-set-field
    commands.version_list = function(name)
      if config.options.package_manager == "bun" then
        return "bun info " .. vim.fn.shellescape(name) .. " versions --json"
      end
      return version_list(name)
    end

    ---@diagnostic disable-next-line: duplicate-set-field
    commands.outdated = function(workspace_path)
      if config.options.package_manager == "bun" then
        return "bun " .. vim.fn.shellescape(vim.fn.stdpath("config") .. "/scripts/bun-outdated.js")
      end
      return outdated(workspace_path)
    end

    require("package-info").setup(opts)
  end,
}
