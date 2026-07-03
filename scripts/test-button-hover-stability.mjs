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
