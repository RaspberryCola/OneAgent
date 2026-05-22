/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}", "./node_modules/streamdown/dist/*.js", "./node_modules/@streamdown/code/dist/*.js"],
  theme: {
    extend: {
      colors: {
        // Based on DESIGN.md "Color Palette & Roles"
        pure: {
          black: "#000000",
          white: "#ffffff",
        },
        near: {
          black: "#262626",
        },
        darkest: {
          surface: "#090909",
        },
        snow: "#fafafa",
        light: {
          gray: "#e5e5e5",
        },
        stone: "#737373",
        mid: {
          gray: "#525252",
        },
        silver: "#a3a3a3",
        yellow: "#eab308",
        green: "#22c55e",
        emerald: {
          50: "#ecfdf5",
          600: "#059669",
          900: "#064e3b",
        },
        rose: {
          50: "#fff1f2",
          500: "#f43f5e",
          800: "#9f1239",
        },
        button: {
          text: {
            dark: "#404040",
          },
        },
        border: {
          light: "#d4d4d4",
        },
      },
      borderRadius: {
        // Two-level border-radius system from FRONTEND_DESIGN.md
        container: "12px",
        interactive: "8px",
        pill: "9999px", // Reserved for homepage Agent switcher exception
      },
      fontFamily: {
        // SF Pro Rounded for display, UI Sans for body
        display: [
          "SF Pro Rounded",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        body: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        // Hierarchy from DESIGN.md
        hero: ["48px", { lineHeight: "1.0", fontWeight: "500" }],
        section: ["36px", { lineHeight: "1.11", fontWeight: "500" }],
        subheading: ["30px", { lineHeight: "1.20", fontWeight: "400" }],
        card: ["24px", { lineHeight: "1.33", fontWeight: "400" }],
        bodyLarge: ["18px", { lineHeight: "1.56", fontWeight: "400" }],
        body: ["16px", { lineHeight: "1.50", fontWeight: "400" }],
        caption: ["13px", { lineHeight: "1.43", fontWeight: "400" }],
        small: ["12px", { lineHeight: "1.33", fontWeight: "400" }],
        chat: ["14px", { lineHeight: "1.38", fontWeight: "400" }],
      },
    },
  },
  safelist: [
      "bg-yellow",
      "bg-green",
      "bg-emerald-50",
      "text-emerald-600",
      "text-emerald-900",
      "bg-rose-50",
      "text-rose-500",
      "text-rose-800",
    ],
    plugins: [],
};
