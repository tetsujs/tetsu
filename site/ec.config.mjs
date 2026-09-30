import { defineEcConfig } from "@astrojs/starlight/expressive-code";
import ecTwoSlash from "expressive-code-twoslash";
import { twoslashOptions } from "./twoslash.config.ts";

export default defineEcConfig({
  plugins: [ecTwoSlash({ twoslashOptions })],
  styleOverrides: {
    twoSlash: {
      errorColor: ({ theme }) =>
        theme.type === "dark" ? "#ff8a80" : "#b3261e",
    },
  },
});
