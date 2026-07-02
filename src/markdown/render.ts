import type { MarkdownRenderOptions } from "../app/types";
import { escapeAttr, escapeHtml } from "./escape";
import { resolveMarkdownImageSrc } from "./images";

export function renderMarkdown(markdown: string, options: MarkdownRenderOptions = {}) {
  const lines = markdown.trim().split("\n");

  if (!markdown.trim()) {
    return "";
  }

  const html: string[] = [];
  let list: "ul" | "ol" | null = null;
  let paragraph: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }

    const renderedParagraph = renderInline(paragraph.join(" "), options).trim();

    if (renderedParagraph) {
      html.push(`<p>${renderedParagraph}</p>`);
    }

    paragraph = [];
  };

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        closeList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);

    if (heading && !options.compact) {
      flushParagraph();
      closeList();
      const level = heading[1].length + 2;
      html.push(`<h${level}>${renderInline(heading[2], options)}</h${level}>`);
      continue;
    }

    const quote = /^>\s+(.+)$/.exec(trimmed);

    if (quote && !options.compact) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${renderInline(quote[1], options)}</blockquote>`);
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);

    if (unordered || ordered) {
      flushParagraph();
      const nextList = unordered ? "ul" : "ol";

      if (list && list !== nextList) {
        closeList();
      }

      if (!list) {
        html.push(`<${nextList}>`);
        list = nextList;
      }

      const renderedItem = renderInline((unordered ?? ordered)?.[1] ?? "", options).trim();

      if (renderedItem) {
        html.push(`<li>${renderedItem}</li>`);
      }

      continue;
    }

    closeList();
    paragraph.push(trimmed.replace(/^#+\s+/, ""));
  }

  flushParagraph();
  closeList();

  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }

  return options.compact ? html.slice(0, 2).join("") : html.join("");
}

export function renderInline(value: string, options: MarkdownRenderOptions = {}) {
  const placeholders: string[] = [];
  let html = escapeHtml(value);

  html = html.replace(/`([^`]+)`/g, (_, code: string) => {
    const token = `@@TOKEN_${placeholders.length}@@`;
    placeholders.push(`<code>${code}</code>`);
    return token;
  });

  html = html
    .replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (match, alt: string, src: string) => {
      if (options.skipImages) {
        return "";
      }

      const imageSrc = resolveMarkdownImageSrc(src, options.projectPath, options.fileSrcConverter);

      if (!imageSrc) {
        return match;
      }

      return `<img src="${escapeAttr(imageSrc)}" alt="${alt}" loading="lazy" />`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(
      /(^|[^!])\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '$1<a href="$3" target="_blank" rel="noreferrer">$2</a>'
    )
    .replace(/\[ \]\s+/g, '<input type="checkbox" disabled /> ')
    .replace(/\[x\]\s+/gi, '<input type="checkbox" checked disabled /> ');

  placeholders.forEach((replacement, index) => {
    html = html.replace(`@@TOKEN_${index}@@`, replacement);
  });

  return html;
}
