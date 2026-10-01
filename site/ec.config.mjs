import { defineEcConfig } from "@astrojs/starlight/expressive-code";
import ecTwoSlash from "expressive-code-twoslash";
import { twoslashOptions } from "./twoslash.config.ts";

export default defineEcConfig({
  // GitHub's pair reads with more contrast than Starlight's Night Owl,
  // especially on the light theme. The blocks keep the site's own
  // backgrounds, borders and tabs.
  themes: ["github-dark-default", "github-light-default"],
  useStarlightUiThemeColors: true,
  plugins: [ecTwoSlash({ twoslashOptions })],
  styleOverrides: {
    twoSlash: {
      errorColor: ({ theme }) =>
        theme.type === "dark" ? "#ff8a80" : "#b3261e",
      // The plugin takes tag and link colours from the terminal palette,
      // which is too pale on the light theme (about 3:1); these are GitHub's
      // own.
      tagColor: ({ theme }) => (theme.type === "dark" ? "#79c0ff" : "#0550ae"),
      linkColor: ({ theme }) => (theme.type === "dark" ? "#79c0ff" : "#0969da"),
      linkColorHover: ({ theme }) =>
        theme.type === "dark" ? "#56d4dd" : "#0550ae",
      linkColorVisited: ({ theme }) =>
        theme.type === "dark" ? "#d2a8ff" : "#8250df",
      linkColorActive: ({ theme }) =>
        theme.type === "dark" ? "#56d364" : "#0550ae",
    },
  },
});
