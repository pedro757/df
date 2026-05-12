return {
  -- { "tahayvr/matteblack.nvim", lazy = false, priority = 1000, config = function() vim.cmd.colorscheme "matteblack" end },
  -- { "ellisonleao/gruvbox.nvim", lazy = false, priority = 1000, config = function() vim.cmd.colorscheme "gruvbox" end },
  {
    "ember-theme/nvim",
    name = "ember",
    priority = 1000,
    config = function()
      require("ember").setup({
        variant = "ember", -- "ember" | "ember-soft" | "ember-light"
      })
      vim.cmd("colorscheme ember")
    end,
  }
}
