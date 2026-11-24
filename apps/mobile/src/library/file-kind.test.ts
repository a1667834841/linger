import { describe, expect, it } from "vitest";

import { fileKind, fileSize, fileTypeLabel, viewerFor } from "./file-kind";

describe("fileKind", () => {
  it("reads the extension first, then the media type", () => {
    expect(fileKind("source.m4a")).toBe("audio");
    expect(fileKind("report.PDF")).toBe("pdf");
    expect(fileKind("notes", "text/markdown; charset=utf-8")).toBe("markdown");
    expect(fileKind("clip", "video/mp4")).toBe("video");
    expect(fileKind("mystery.bin", "application/octet-stream")).toBe(
      "document",
    );
  });
});

describe("viewerFor", () => {
  it("keeps text, images and audio in the app and hands the rest to the system", () => {
    expect(viewerFor("transcript.md")).toBe("page");
    expect(viewerFor("data.json")).toBe("page");
    expect(viewerFor("photo.png")).toBe("image");
    expect(viewerFor("photo.heic")).toBe("system");
    expect(viewerFor("source.m4a")).toBe("audio");
    expect(viewerFor("deck.pptx")).toBe("system");
    expect(viewerFor("clip.mov")).toBe("system");
    expect(viewerFor("paper.pdf")).toBe("system");
  });
});

describe("labels", () => {
  it("names the type and size like the web", () => {
    expect(fileTypeLabel("plan.docx")).toBe("Word");
    expect(fileTypeLabel("table.csv")).toBe("CSV");
    expect(fileTypeLabel("source.m4a")).toBe("Audio");
    expect(fileSize(645_384)).toBe("630 KB");
    expect(fileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
