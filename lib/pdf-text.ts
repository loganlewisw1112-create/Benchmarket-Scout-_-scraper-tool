// Text handling for the client-side PDF export.
//
// jsPDF's built-in Helvetica only covers WinAnsi (Windows-1252). Handing it
// anything else makes jsPDF emit the whole string as 16-bit text Helvetica
// cannot draw, so the entire line garbles, including the ASCII around it. The
// export therefore:
//   1. uses Helvetica when every printed string is WinAnsi (no font download);
//   2. otherwise embeds Noto Sans (SIL OFL 1.1, vendored in public/fonts/ from
//      the @expo-google-fonts/noto-sans npm package), which covers Latin
//      (including Vietnamese), Greek, and Cyrillic;
//   3. replaces any character the active font still cannot draw (CJK, Arabic,
//      emoji, or everything non-WinAnsi if the font fails to load) with a
//      visible "?" and counts it, so the PDF can say so. Nothing is garbled
//      silently.

export type PdfFontFamily = "helvetica" | "NotoSans";

export const UNICODE_FONT_FAMILY = "NotoSans";
export const UNICODE_FONT_FILES = {
  normal: "/fonts/NotoSans-Regular.ttf",
  bold: "/fonts/NotoSans-Bold.ttf",
} as const;
export const UNRENDERABLE_PLACEHOLDER = "?";

// Windows-1252 code points 0x80-0x9F that map to printable characters.
const WINANSI_HIGH = new Set(
  Array.from("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ", (ch) => ch.codePointAt(0) ?? 0)
);

export function isWinAnsiCodePoint(cp: number): boolean {
  return (
    (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WINANSI_HIGH.has(cp)
  );
}

// cmap coverage of the vendored NotoSans-Regular.ttf / NotoSans-Bold.ttf
// (identical), extracted with jsPDF's own TTF parser. Devanagari
// (U+0900-U+097F) is present in the font but deliberately left out: jsPDF does
// no complex-script shaping, so it would render wrong without any warning.
const NOTO_SANS_RANGES: readonly (readonly [number, number])[] = [
  [0x0020, 0x007e], [0x00a0, 0x0377], [0x037a, 0x037f], [0x0384, 0x038a],
  [0x038c, 0x038c], [0x038e, 0x03a1], [0x03a3, 0x03e1], [0x03f0, 0x052f],
  [0x10fb, 0x10fb], [0x1ab0, 0x1ac0], [0x1ac5, 0x1ac5],
  [0x1ac7, 0x1ace], [0x1c80, 0x1c88], [0x1d00, 0x1df9], [0x1dfb, 0x1f15],
  [0x1f18, 0x1f1d], [0x1f20, 0x1f45], [0x1f48, 0x1f4d], [0x1f50, 0x1f57],
  [0x1f59, 0x1f59], [0x1f5b, 0x1f5b], [0x1f5d, 0x1f5d], [0x1f5f, 0x1f7d],
  [0x1f80, 0x1fb4], [0x1fb6, 0x1fc4], [0x1fc6, 0x1fd3], [0x1fd6, 0x1fdb],
  [0x1fdd, 0x1fef], [0x1ff2, 0x1ff4], [0x1ff6, 0x1ffe], [0x2000, 0x2064],
  [0x2066, 0x2071], [0x2074, 0x208e], [0x2090, 0x209c], [0x20a0, 0x20c0],
  [0x20f0, 0x20f0], [0x2100, 0x215f], [0x2183, 0x2184], [0x2189, 0x2189],
  [0x2212, 0x2212], [0x25cc, 0x25cc], [0x2c60, 0x2c7f], [0x2de0, 0x2e5d],
  [0xa640, 0xa69f], [0xa700, 0xa7ca], [0xa7d0, 0xa7d1], [0xa7d3, 0xa7d3],
  [0xa7d5, 0xa7d9], [0xa7f2, 0xa7ff], [0xa8ff, 0xa8ff], [0xa92e, 0xa92e],
  [0xab30, 0xab6b], [0xfb00, 0xfb06], [0xfe00, 0xfe00], [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff], [0xfffc, 0xfffd],
];

export function isNotoSansCodePoint(cp: number): boolean {
  let lo = 0;
  let hi = NOTO_SANS_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = NOTO_SANS_RANGES[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

// Line breaks and tabs are layout, not glyphs; jsPDF handles them itself.
function isLayoutCodePoint(cp: number): boolean {
  return cp === 0x0a || cp === 0x09;
}

export function canRender(family: PdfFontFamily, cp: number): boolean {
  if (isLayoutCodePoint(cp)) return true;
  return family === "helvetica" ? isWinAnsiCodePoint(cp) : isNotoSansCodePoint(cp);
}

// True when at least one string would not survive Helvetica (WinAnsi).
export function needsUnicodeFont(texts: Iterable<string>): boolean {
  for (const text of texts) {
    for (const ch of text.normalize("NFC")) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 0x0d) continue;
      if (!canRender("helvetica", cp)) return true;
    }
  }
  return false;
}

export type PdfTextSanitizer = {
  readonly family: PdfFontFamily;
  clean(text: string): string;
  replacedCount(): number;
};

// Returns a cleaner bound to the active font. Every string drawn into the PDF
// must pass through `clean`; `replacedCount` then tells the caller whether to
// print the "shown as ?" notice.
export function createPdfTextSanitizer(family: PdfFontFamily): PdfTextSanitizer {
  let replaced = 0;
  return {
    family,
    clean(text: string): string {
      let out = "";
      for (const ch of text.normalize("NFC")) {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp === 0x0d) continue;
        if (canRender(family, cp)) {
          out += ch;
        } else {
          out += UNRENDERABLE_PLACEHOLDER;
          replaced += 1;
        }
      }
      return out;
    },
    replacedCount: () => replaced,
  };
}

function arrayBufferToBinaryString(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return binary;
}

export type UnicodeFontData = { normal: string; bold: string };

// Fetches the vendored TTFs only when a report actually needs them (~630 KB
// each). Any failure resolves to null so the export falls back to Helvetica
// with visible "?" replacements instead of failing outright.
export async function loadUnicodeFont(
  fetchImpl: typeof fetch = fetch
): Promise<UnicodeFontData | null> {
  try {
    const [normal, bold] = await Promise.all(
      [UNICODE_FONT_FILES.normal, UNICODE_FONT_FILES.bold].map(async (path) => {
        const res = await fetchImpl(path);
        if (!res.ok) throw new Error(`Font request failed: ${res.status}`);
        return arrayBufferToBinaryString(await res.arrayBuffer());
      })
    );
    return { normal, bold };
  } catch {
    return null;
  }
}
