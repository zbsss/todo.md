import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const styles = await readFile(resolve(repoRoot, "src/styles.css"), "utf8");

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]+)\\}`));

  assert.ok(match?.groups?.body, `Expected to find CSS rule for ${selector}`);

  return match.groups.body;
}

function ruleContainingSelector(selector) {
  const match = [...styles.matchAll(/(?<selectors>[^{}]+)\{(?<body>[^}]+)\}/g)].find((candidate) =>
    candidate.groups.selectors
      .split(",")
      .map((item) => item.trim())
      .includes(selector)
  );

  assert.ok(match?.groups?.body, `Expected to find CSS rule containing ${selector}`);

  return match.groups.body;
}

test("text button hover states do not shift vertically", () => {
  const hoverSelectors = [...styles.matchAll(/(?<selectors>[^{}]+:hover[^{}]*)\{(?<body>[^}]+)\}/g)];
  const movingTextButtonHover = hoverSelectors.find((match) => {
    const selectors = match.groups.selectors;
    const body = match.groups.body;

    return (
      (selectors.includes(".ghost-button:hover") || selectors.includes(".save-button:hover")) &&
      /transform\s*:\s*translateY\(/.test(body)
    );
  });

  assert.equal(movingTextButtonHover, undefined);
});

test("icon and sidebar buttons keep their hover lift", () => {
  const iconHoverRule = ruleFor(".icon-button:hover");
  const sidebarHoverRule = ruleFor(".sidebar-action:hover");

  assert.match(iconHoverRule, /transform\s*:\s*translateY\(-1px\)/);
  assert.match(sidebarHoverRule, /transform\s*:\s*translateY\(-1px\)/);
});

test("search controls and highlights use theme-aware colors", () => {
  const searchRule = ruleFor(".ticket-search");
  const focusRule = ruleContainingSelector(".ticket-search:focus-within");
  const clearHoverRule = ruleContainingSelector(".ticket-search-clear:hover");
  const markRule = ruleContainingSelector(".ticket-title-search mark");
  const darkThemeRule = ruleFor(':root[data-color-scheme="dark"]');
  const gruvboxThemeRule = ruleFor(':root[data-color-scheme="gruvbox"]');

  assert.match(searchRule, /background\s*:\s*var\(--search-bg\)/);
  assert.match(focusRule, /background\s*:\s*var\(--search-focus-bg\)/);
  assert.match(clearHoverRule, /background\s*:\s*var\(--search-clear-hover-bg\)/);
  assert.match(markRule, /background\s*:\s*var\(--search-mark-bg\)/);
  assert.match(markRule, /color\s*:\s*var\(--search-mark-fg\)/);
  assert.match(darkThemeRule, /--search-mark-bg\s*:/);
  assert.match(darkThemeRule, /--search-mark-fg\s*:/);
  assert.match(gruvboxThemeRule, /--search-mark-bg\s*:/);
  assert.match(gruvboxThemeRule, /--search-mark-fg\s*:/);
  assert.doesNotMatch(searchRule, /rgba\(255,\s*255,\s*255|#fff(?:fff)?\b/i);
  assert.doesNotMatch(focusRule, /#fff(?:fff)?\b/i);
  assert.doesNotMatch(markRule, /color\s*:\s*inherit|#fff0a6/i);
});
