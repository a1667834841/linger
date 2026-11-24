// Read-only rendering of downloaded content: Markdown, text, code and images
// render natively. Other files open in the system viewer instead. No web views.
import { StyleSheet, View } from "react-native";

import type { Download } from "../api/teamhub";
import { toBase64 } from "../lib/bytes";
import { utf8 } from "../session/frames";
import { space, type } from "../theme";
import { EmptyState } from "../ui/controls";
import { Markdown } from "../ui/markdown";
import { Text } from "../ui/text";
import { ZoomableImage } from "./zoomable-image";

/** Larger text stays on the computer; a phone screen is no place for it. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Images up to this size decode comfortably on a phone. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Formats the iOS and Android image decoders both read. */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type Readable =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly uri: string }
  | { readonly kind: "unsupported" };

export function readableFrom(download: Download): Readable {
  if (download.tooLarge) return { kind: "unsupported" };
  const mediaType =
    download.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (IMAGE_TYPES.has(mediaType))
    return download.bytes.length > MAX_IMAGE_BYTES
      ? { kind: "unsupported" }
      : {
          kind: "image",
          uri: `data:${mediaType};base64,${toBase64(download.bytes)}`,
        };
  if (download.bytes.length > MAX_TEXT_BYTES) return { kind: "unsupported" };
  if (mediaType === "text/markdown" || mediaType === "text/x-markdown")
    return { kind: "markdown", text: utf8(download.bytes) };
  if (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json") ||
    mediaType === "application/xml" ||
    mediaType === "application/yaml" ||
    mediaType === "application/x-yaml"
  )
    return { kind: "text", text: utf8(download.bytes) };
  return { kind: "unsupported" };
}

/** Text scrolls in its parent; an image fills it, fitted and zoomable. */
export function ReadableView(props: { readonly content: Readable }) {
  const { content } = props;
  if (content.kind === "unsupported")
    return (
      <EmptyState
        title="Open on your computer"
        body="This file cannot be shown on the phone. Open it in Linger on your computer."
      />
    );
  if (content.kind === "image") return <ZoomableImage uri={content.uri} />;
  return (
    <View style={styles.body}>
      {content.kind === "markdown" ? (
        <Markdown text={content.text} />
      ) : (
        <Text style={type.body} selectable>
          {content.text}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.xl, paddingVertical: space.lg },
});
