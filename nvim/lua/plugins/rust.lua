return {
  "mrcjkb/rustaceanvim",
  opts = {
    server = {
      auto_attach = function(bufnr)
        local name = vim.api.nvim_buf_get_name(bufnr)
        if vim.bo[bufnr].buftype ~= "" or name == "" or name:match("^%w+://") then
          return false
        end

        -- rustup's launcher can exist even when the toolchain component is missing.
        local executable = vim.fn.exepath("rust-analyzer")
        local ok, result = pcall(function()
          return vim.system({ executable, "--version" }, { text = true }):wait(3000)
        end)
        if ok and result.code == 0 then
          return true
        end

        local detail = executable == "" and "rust-analyzer was not found in PATH."
          or (ok and vim.trim(result.stderr or "") or tostring(result))
        if detail == "" then
          detail = "rust-analyzer --version failed (exit code " .. tostring(result.code) .. ")."
        end
        vim.notify_once(
          "Rust LSP could not start.\n"
            .. detail
            .. "\nInstall it for the active Rust toolchain:\n"
            .. "  rustup component add rust-analyzer\n"
            .. "Then run :RustAnalyzer start in the Rust buffer.",
          vim.log.levels.ERROR,
          { title = "Rust tooling" }
        )
        return false
      end,
    },
  },
}
