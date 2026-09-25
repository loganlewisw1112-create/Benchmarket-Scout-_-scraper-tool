import { describe, expect, it, vi } from "vitest";
import {
  canRender,
  createPdfTextSanitizer,
  isWinAnsiCodePoint,
  loadUnicodeFont,
  needsUnicodeFont,
  UNICODE_FONT_FILES,
} from "./pdf-text";

const cp = (ch: string) => ch.codePointAt(0) ?? 0;

describe("font coverage", () => {
  it("treats Windows-1252 punctuation as WinAnsi and Vietnamese as not", () => {
    for (const ch of ["A", "é", "©", "—", "•", "…", "€", "’"]) {
      expect(isWinAnsiCodePoint(cp(ch))).toBe(true);
    }
    for (const ch of ["ở", "ộ", "Ł", "河", "Ж"]) {
      expect(isWinAnsiCodePoint(cp(ch))).toBe(false);
    }
  });

  it("covers Latin, Vietnamese, Greek, and Cyrillic with Noto Sans but not CJK or Devanagari", () => {
    for (const ch of ["ở", "ộ", "Ł", "Ж", "Ω", "—"]) {
      expect(canRender("NotoSans", cp(ch))).toBe(true);
    }
    for (const ch of ["河", "粉", "क", "😀", "ب"]) {
      expect(canRender("NotoSans", cp(ch))).toBe(false);
    }
  });

  it("only asks for the Unicode font when some text is outside WinAnsi", () => {
    expect(needsUnicodeFont(["Joe's Café — “Best” • 100%\n"])).toBe(false);
    expect(needsUnicodeFont(["Plain", "Phở Hà Nội"])).toBe(true);
  });
});

describe("createPdfTextSanitizer", () => {
  it("replaces unrenderable characters with a visible marker and counts them", () => {
    const helvetica = createPdfTextSanitizer("helvetica");
    expect(helvetica.clean("Phở Café")).toBe("Ph? Café");
    expect(helvetica.replacedCount()).toBe(1);

    const noto = createPdfTextSanitizer("NotoSans");
    expect(noto.clean("Phở 河内")).toBe("Phở ??");
    expect(noto.replacedCount()).toBe(2);
  });

  it("normalizes decomposed accents before checking coverage", () => {
    const helvetica = createPdfTextSanitizer("helvetica");
    // "e" + COMBINING ACUTE ACCENT composes to "é", which WinAnsi has.
    expect(helvetica.clean("Café")).toBe("Café");
    expect(helvetica.replacedCount()).toBe(0);
  });

  it("keeps line breaks and drops carriage returns", () => {
    const helvetica = createPdfTextSanitizer("helvetica");
    expect(helvetica.clean("a\r\nb\tc")).toBe("a\nb\tc");
    expect(helvetica.replacedCount()).toBe(0);
  });
});

describe("loadUnicodeFont", () => {
  it("fetches both weights from /fonts as binary strings", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([0, 1, 0, 0, 255]).buffer,
    }));
    const font = await loadUnicodeFont(fetchMock as unknown as typeof fetch);

    expect(fetchMock.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      UNICODE_FONT_FILES.normal,
      UNICODE_FONT_FILES.bold,
    ]);
    expect(font).toEqual({
      normal: "\u0000\u0001\u0000\u0000ÿ",
      bold: "\u0000\u0001\u0000\u0000ÿ",
    });
  });

  it("resolves null (not a throw) when the font cannot be fetched", async () => {
    const failing = vi.fn(async () => ({ ok: false, status: 404 }));
    expect(await loadUnicodeFont(failing as unknown as typeof fetch)).toBeNull();

    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await loadUnicodeFont(offline as unknown as typeof fetch)).toBeNull();
  });
});
