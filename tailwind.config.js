/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        babata: {
          bg: "#0f1115",
          fg: "#e7e9ee",
          muted: "#8a8f99",
          accent: "#7aa2f7",
          border: "#23262d",
          bubble: "#1a1d23",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system", "BlinkMacSystemFont", "system-ui",
          "Helvetica Neue", "Arial", "PingFang SC", "Microsoft YaHei",
          "sans-serif",
        ],
        mono: [
          "ui-monospace", "SFMono-Regular", "Menlo", "Monaco",
          "Consolas", "monospace",
        ],
      },
    },
  },
  plugins: [],
};
