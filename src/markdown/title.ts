import { escapeHtml } from "./escape";

export const untitledTicketTitle = "Untitled ticket";

export type TaggedTicketTitle = {
  tag: string;
  text: string;
};

export function renderTicketTitle(title: string) {
  const taggedTitle = parseTicketTitle(title);

  if (!taggedTitle) {
    return escapeHtml(title);
  }

  const tagVariant = ticketTitleTagVariant(taggedTitle.tag);
  const titleText = taggedTitle.text
    ? `<span class="ticket-title-text">${escapeHtml(taggedTitle.text)}</span>`
    : "";

  return `<span class="ticket-title"><span class="ticket-title-chip ticket-title-chip-${tagVariant}">${escapeHtml(taggedTitle.tag)}</span>${titleText}</span>`;
}

export function parseTicketTitle(title: string): TaggedTicketTitle | null {
  const trimmed = title.trim();
  const bracketTag = /^\[([^\]\r\n]{1,32})\](?:\s+(.*)|$)/.exec(trimmed);

  if (bracketTag) {
    const tag = normalizeTicketTitleTag(bracketTag[1]);

    if (!tag) {
      return null;
    }

    return {
      tag,
      text: bracketTag[2]?.trim() ?? ""
    };
  }

  const colonTag = /^([A-Za-z][A-Za-z0-9 _/-]{0,31}):\s+(.+)$/.exec(trimmed);

  if (!colonTag) {
    return null;
  }

  const tag = normalizeTicketTitleTag(colonTag[1]);

  if (!tag) {
    return null;
  }

  return {
    tag,
    text: colonTag[2].trim()
  };
}

export function normalizeTicketTitleTag(tag: string) {
  return tag.split(/\s+/).filter(Boolean).join(" ");
}

export function ticketTitleTagVariant(tag: string) {
  let hash = 0;

  for (const character of tag.toLowerCase()) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash % 6;
}

export function titleDisplayValue(title: string) {
  return title.trim() ? title : untitledTicketTitle;
}
