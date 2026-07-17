// Lightbase design tokens (mirrored from shop-swap-cloudflare-app).
// Use in inline styles throughout the app.

export const LB = {
  bg: "#FAFAF7",
  surface: "#FFFFFF",
  surfaceAlt: "#F4F4EF",
  border: "#E8E7E1",
  borderStrong: "#D6D5CD",
  text: "#111111",
  textMid: "#3E3E3A",
  textDim: "#76766F",
  blue: "#1E6BF1",
  blueSoft: "#E8F0FE",
  blueDeep: "#1850BF",
  green: "#0F9D58",
  greenSoft: "#E4F4EC",
  amber: "#D97706",
  amberSoft: "#FDF1DC",
  red: "#D7263D",
  redSoft: "#FBE6E9",
  slate: "#6B7280",
  slateSoft: "#EEEEEA",
  black: "#000000",
} as const;

export const FONTS = {
  sans: '"Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  mono: '"Geist Mono Variable", "Geist Mono", "JetBrains Mono", "SF Mono", ui-monospace, monospace',
} as const;
