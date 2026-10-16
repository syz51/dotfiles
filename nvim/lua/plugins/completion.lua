return {
  "saghen/blink.cmp",
  opts = {
    completion = {
      trigger = {
        show_on_blocked_trigger_characters = function()
          return vim.bo.filetype == "ghostty" and { "\n", "\t" } or { " ", "\n", "\t" }
        end,
      },
    },
    sources = {
      per_filetype = {
        ghostty = { inherit_defaults = true, "ghostty" },
      },
      providers = {
        ghostty = {
          name = "Ghostty",
          module = "config.ghostty-completion",
        },
      },
    },
  },
}
