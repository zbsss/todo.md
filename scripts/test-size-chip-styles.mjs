import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const styles = await readFile(resolve(repoRoot, "src/styles.css"), "utf8");
const main = await readFile(resolve(repoRoot, "src/main.ts"), "utf8");

const sizePalette = {
  xs: "5",
  s: "0",
  m: "1",
  l: "3",
  xl: "4"
};

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]+)\\}`));

  assert.ok(match?.groups?.body, `Expected to find CSS rule for ${selector}`);

  return match.groups.body;
}

function themeVariables(selector) {
  const body = ruleFor(selector);
  const variables = {};

  for (const match of body.matchAll(/--(?<name>[\w-]+):\s*(?<value>#[0-9a-f]{6})\s*;/gi)) {
    variables[match.groups.name] = match.groups.value;
  }

  return variables;
}

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    .map((pair) => Number.parseInt(pair, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));

  return (lighter + 0.05) / (darker + 0.05);
}

test("size chips render with size-specific classes", () => {
  assert.match(main, /task-chip-size task-size-\$\{ticket\.size\.toLowerCase\(\)\}/);
  assert.match(main, /task-size-\$\{value\.toLowerCase\(\)\}/);

  for (const size of Object.keys(sizePalette)) {
    const rule = ruleFor(`.task-size-${size}`);

    assert.match(rule, /background:\s*var\(--tag-\d-bg\);/);
    assert.match(rule, /color:\s*var\(--tag-\d-fg\);/);
  }
});

test("size chip colors keep readable contrast in each theme", () => {
  const themes = [":root", ':root[data-color-scheme="dark"]', ':root[data-color-scheme="gruvbox"]'];

  for (const theme of themes) {
    const variables = themeVariables(theme);

    for (const [size, tag] of Object.entries(sizePalette)) {
      const ratio = contrastRatio(variables[`tag-${tag}-bg`], variables[`tag-${tag}-fg`]);

      assert.ok(ratio >= 4.5, `${theme} task-size-${size} contrast ${ratio.toFixed(2)} should be at least 4.5`);
    }
  }
});
