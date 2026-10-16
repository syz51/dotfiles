-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

local keymap = vim.keymap
local opts = { noremap = true, silent = true }

-- select all
keymap.set("n", "<C-a>", "gg<S-v>G", opts)

-- save
keymap.set({ "x", "n", "s" }, "<C-s>", "<cmd>w<cr><esc>", { desc = "Save File" })
keymap.set("i", "<C-s>", "<esc><cmd>w<cr>", { desc = "Save File" })

-- Ctrl+/ can arrive as Ctrl+_ in terminals without extended key support.
for _, key in ipairs({ "<C-/>", "<C-_>" }) do
  keymap.del("t", key)
  keymap.set("n", key, "gcc", { remap = true, desc = "Toggle Comment" })
  keymap.set("i", key, "<C-o>gcc", { remap = true, desc = "Toggle Comment" })
  keymap.set("x", key, "gc", { remap = true, desc = "Toggle Comment" })
  keymap.set("s", key, "<C-g>gc", { remap = true, desc = "Toggle Comment" })
end

keymap.set({ "n", "i", "x", "s", "t" }, "<C-Esc>", function()
  Snacks.terminal.focus(nil, { cwd = LazyVim.root() })
end, { desc = "Terminal (Root Dir)" })
