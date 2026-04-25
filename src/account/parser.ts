const BALANCE_PATTERN = /£[\d.]+/;

export function parseGiffgaffBalance(text: string): string | null {
  return text.match(BALANCE_PATTERN)?.[0] ?? null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&pound;", "£")
    .replaceAll("&amp;", "&")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&#163;", "£")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function extractAirtimeCreditFromDashboard(html: string): string | null {
  const match = html.match(/id="balance-value"[\s\S]*?<h4[^>]*>([\s\S]*?)<\/h4>/i);
  if (!match || !match[1]) {
    return null;
  }
  return normaliseWhitespace(decodeHtmlEntities(stripTags(match[1])));
}
