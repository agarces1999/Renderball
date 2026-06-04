import type { Config } from "tailwindcss";

/**
 * Renderball theme — tokens defined as CSS variables in app/globals.css,
 * surfaced here as Tailwind utilities. See DESIGN.md for the system.
 * Cool-graphite greyscale + one emerald signal. Dark by default.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "var(--canvas)",
        surface: {
          DEFAULT: "var(--surface)",
          2: "var(--surface-2)",
          3: "var(--surface-3)",
        },
        ink: {
          DEFAULT: "var(--ink)",
          soft: "var(--ink-soft)",
        },
        muted: "var(--muted)",
        faint: "var(--faint)",
        accent: {
          DEFAULT: "var(--accent)",
          ink: "var(--accent-ink)",
          text: "var(--accent-text)",
          soft: "var(--accent-soft)",
          line: "var(--accent-line)",
        },
      },
      borderColor: {
        hairline: {
          DEFAULT: "var(--hairline)",
          strong: "var(--hairline-strong)",
        },
      },
      fontFamily: {
        display: ["var(--font-display)"],
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      borderRadius: {
        sm: "8px",
        md: "12px",
        lg: "18px",
      },
    },
  },
  plugins: [],
};

export default config;
