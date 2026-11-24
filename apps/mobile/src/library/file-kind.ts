// What a file is and where it opens. The kinds and labels follow the web
// (apps/web/src/features/rooms/files/artifact-file-kind.ts) so a file looks
// the same on both. The phone renders text, Markdown, images and audio
// itself; everything else opens in the system viewer.

export type FileKind =
  | "archive"
  | "audio"
  | "code"
  | "document"
  | "html"
  | "image"
  | "markdown"
  | "pdf"
  | "presentation"
  | "spreadsheet"
  | "text"
  | "video";

const byExtension: Record<string, FileKind> = {};
function add(kind: FileKind, extensions: string) {
  for (const extension of extensions.split(" ")) byExtension[extension] = kind;
}
add("archive", "7z bz2 gz gzip rar tar xz zip");
add("audio", "aac flac m4a mp3 ogg opus wav");
add(
  "code",
  "c cpp css go h hpp java js json jsx less mmd py rs scss sh sql toml ts tsx xml yaml yml",
);
add("image", "avif bmp gif heic heif ico jpeg jpg png svg webp");
add("spreadsheet", "csv ods tsv xls xlsx");
add("video", "avi m4v mkv mov mp4 webm");
add("pdf", "pdf");
add("document", "doc docx pages rtf odt");
add("presentation", "ppt pptx key odp");
add("markdown", "md markdown");
add("html", "htm html");
add("text", "log txt");

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function kindFromMediaType(mediaType: string): FileKind | undefined {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/html") return "html";
  if (type === "text/csv") return "spreadsheet";
  if (type === "text/plain") return "text";
  if (type === "application/json" || type.endsWith("+json")) return "code";
  if (type.startsWith("text/")) return "code";
  return undefined;
}

export function fileKind(filename: string, mediaType = ""): FileKind {
  return (
    byExtension[extensionOf(filename)] ??
    kindFromMediaType(mediaType) ??
    "document"
  );
}

const labels: Record<FileKind, string> = {
  archive: "Archive",
  audio: "Audio",
  code: "Code",
  document: "Document",
  html: "HTML",
  image: "Image",
  markdown: "Markdown",
  pdf: "PDF",
  presentation: "Slides",
  spreadsheet: "Spreadsheet",
  text: "Text",
  video: "Video",
};

export function fileTypeLabel(filename: string, mediaType = ""): string {
  const extension = extensionOf(filename);
  if (extension === "doc" || extension === "docx") return "Word";
  if (extension === "ppt" || extension === "pptx") return "PowerPoint";
  if (extension === "xls" || extension === "xlsx") return "Excel";
  if (extension === "csv" || extension === "tsv") return "CSV";
  return labels[fileKind(filename, mediaType)];
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Where a file opens: drawn by the app, played by the app, or the system viewer. */
export type Viewer = "page" | "image" | "audio" | "system";

export function viewerFor(filename: string, mediaType = ""): Viewer {
  switch (fileKind(filename, mediaType)) {
    case "markdown":
    case "text":
    case "code":
      return "page";
    case "image":
      // HEIC and SVG need the system viewer; the app decodes the rest.
      return /^(heic|heif|svg|ico|bmp|avif)$/.test(extensionOf(filename))
        ? "system"
        : "image";
    case "audio":
      return "audio";
    default:
      return "system";
  }
}
