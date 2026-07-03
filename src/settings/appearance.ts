export type ColorScheme = "light" | "dark" | "gruvbox";

export type AppFont = "system" | "serif" | "mono";

export type AppearanceSettings = {
  colorScheme: ColorScheme;
  fontFamily: AppFont;
  fontSize: number;
};

export const appearanceStorageKey = "todo.md.appearance";
export const minFontSize = 14;
export const maxFontSize = 18;
export const defaultAppearanceSettings: AppearanceSettings = {
  colorScheme: "light",
  fontFamily: "system",
  fontSize: 16
};

const colorSchemes: ColorScheme[] = ["light", "dark", "gruvbox"];
const appFonts: AppFont[] = ["system", "serif", "mono"];

export const colorSchemeOptions: Array<{ value: ColorScheme; label: string; icon: string }> = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "gruvbox", label: "Gruvbox", icon: "palette" }
];

export const appFontOptions: Array<{ value: AppFont; label: string; css: string }> = [
  {
    value: "system",
    label: "System",
    css: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  },
  {
    value: "serif",
    label: "Serif",
    css: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif'
  },
  {
    value: "mono",
    label: "Mono",
    css: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace'
  }
];

export function normalizeAppearanceSettings(value: unknown): AppearanceSettings {
  if (!isRecord(value)) {
    return { ...defaultAppearanceSettings };
  }

  return {
    colorScheme: isColorScheme(value.colorScheme) ? value.colorScheme : defaultAppearanceSettings.colorScheme,
    fontFamily: isAppFont(value.fontFamily) ? value.fontFamily : defaultAppearanceSettings.fontFamily,
    fontSize: normalizeFontSize(value.fontSize)
  };
}

export function parseAppearanceSettings(raw: string | null): AppearanceSettings {
  if (!raw) {
    return { ...defaultAppearanceSettings };
  }

  try {
    return normalizeAppearanceSettings(JSON.parse(raw));
  } catch {
    return { ...defaultAppearanceSettings };
  }
}

export function serializeAppearanceSettings(settings: AppearanceSettings) {
  return JSON.stringify(normalizeAppearanceSettings(settings));
}

export function appFontCss(font: AppFont) {
  return appFontOptions.find((option) => option.value === font)?.css ?? appFontOptions[0].css;
}

function normalizeFontSize(value: unknown) {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numericValue)) {
    return defaultAppearanceSettings.fontSize;
  }

  return Math.round(Math.min(Math.max(numericValue, minFontSize), maxFontSize));
}

function isColorScheme(value: unknown): value is ColorScheme {
  return typeof value === "string" && colorSchemes.includes(value as ColorScheme);
}

function isAppFont(value: unknown): value is AppFont {
  return typeof value === "string" && appFonts.includes(value as AppFont);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
