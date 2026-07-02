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
  init = function()
    if vim.g.gopls_prune_missing_watchers then
      return
    end
    vim.g.gopls_prune_missing_watchers = true

    local register_capability = vim.lsp.handlers["client/registerCapability"]
    vim.lsp.handlers["client/registerCapability"] = function(err, result, ctx, config)
      local client = ctx and vim.lsp.get_client_by_id(ctx.client_id)

      if client and client.name == "gopls" and result and result.registrations then
        for _, reg in ipairs(result.registrations) do
          local opts = reg.registerOptions
          if reg.method == "workspace/didChangeWatchedFiles" and opts and opts.watchers then
            opts.watchers = vim.tbl_filter(function(watcher)
              local glob = watcher.globPattern
              if type(glob) ~= "table" or not glob.baseUri then
                return true
              end

              local uri = type(glob.baseUri) == "string" and glob.baseUri or glob.baseUri.uri
              return type(uri) ~= "string" or vim.uv.fs_stat(vim.uri_to_fname(uri)) ~= nil
            end, opts.watchers)
          end
        end
      end

      return register_capability(err, result, ctx, config)
    end
  end,
}
