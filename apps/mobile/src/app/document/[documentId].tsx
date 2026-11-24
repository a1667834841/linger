// A Document or file, read-only. Text, Markdown and images are drawn by the
// app; audio plays in the app; every other file the computer can open is
// downloaded into the cache and shown by the system viewer (Quick Look on
// iOS). A file Document reads its current Version, which needs only read
// access: Wiki pages are read-only and cannot be exported, so their
// GET /v0/documents/{id}/downloads answers 404. A native Document's latest
// content comes from that route, which waits out one still rendering.
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import type { File } from "expo-file-system";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";

import { openFile } from "../../../modules/file-preview";
import {
  documentVersionContentPath,
  downloadDocumentVersion,
  downloadLatestDocument,
  getDocument,
  getDocumentVersion,
} from "../../api/teamhub";
import { FileTile } from "../../chat/file-card";
import { downloadToFile, freshCacheFile } from "../../library/cache-file";
import {
  fileSize,
  fileTypeLabel,
  viewerFor,
  type Viewer,
} from "../../library/file-kind";
import { readKnowledgeMarkdown } from "../../library/knowledge-markdown";
import { readableFrom, ReadableView } from "../../library/readable";
import { Recording } from "../../library/recording";
import { isWikiPage, wikiPageTitle } from "../../library/wiki-pages";
import { HttpError } from "../../session/http";
import { teamHubKey, useTeamHub } from "../../state/queries";
import { colors, radius, space, type } from "../../theme";
import { Button, EmptyState } from "../../ui/controls";
import { Icon } from "../../ui/icon";
import { StatusStrip } from "../../ui/status-strip";
import { Text } from "../../ui/text";

interface FileFacts {
  readonly versionId?: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size?: number;
}

/** The file's head: its tile, name, and type and size. */
function FileHead(props: { readonly facts: FileFacts }) {
  const { facts } = props;
  return (
    <View style={styles.head}>
      <FileTile
        filename={facts.filename}
        mediaType={facts.mediaType}
        size={56}
      />
      <Text style={styles.headName} numberOfLines={2}>
        {facts.filename}
      </Text>
      <Text style={type.chatMeta}>
        {fileTypeLabel(facts.filename, facts.mediaType)}
        {facts.size !== undefined ? ` · ${fileSize(facts.size)}` : ""}
      </Text>
    </View>
  );
}

/** Downloads the version into the cache and opens it in the system viewer. */
function SystemFile(props: {
  readonly facts: FileFacts & { versionId: string };
}) {
  const { facts } = props;
  const teamHub = useTeamHub();
  const fileRef = useRef<File | undefined>(undefined);
  const [state, setState] = useState<
    "downloading" | "ready" | "failed" | "unsupported"
  >("downloading");
  const [bytes, setBytes] = useState(0);
  const [attempt, setAttempt] = useState(0);

  const show = useCallback(async () => {
    const file = fileRef.current;
    if (!file) return;
    try {
      await openFile(file.uri, facts.filename, facts.mediaType || undefined);
    } catch {
      setState("unsupported");
    }
  }, [facts.filename, facts.mediaType]);

  useEffect(() => {
    let cancelled = false;
    const hostId = teamHub.hostId;
    if (!hostId || !teamHub.connected || fileRef.current) return;
    const file = freshCacheFile(hostId, facts.versionId, facts.filename);
    fileRef.current = file;
    void teamHub
      .run((session) =>
        downloadToFile(
          session,
          documentVersionContentPath(facts.versionId),
          file,
          setBytes,
        ),
      )
      .then(() => {
        if (cancelled) return;
        setState("ready");
        void show();
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, facts.filename, facts.versionId, show, teamHub]);

  // The phone keeps no file from the computer once this screen closes.
  useEffect(
    () => () => {
      const file = fileRef.current;
      if (file?.exists) file.delete();
    },
    [],
  );

  const progress =
    facts.size && facts.size > 0 ? Math.min(1, bytes / facts.size) : undefined;

  return (
    <View style={styles.center}>
      <View style={styles.card}>
        <FileHead facts={facts} />
        {state === "downloading" ? (
          <View style={styles.progress}>
            {progress !== undefined ? (
              <View style={styles.bar}>
                <View
                  style={[styles.barFill, { width: `${progress * 100}%` }]}
                />
              </View>
            ) : (
              <ActivityIndicator color={colors.muted} />
            )}
            <Text style={styles.note}>
              {bytes > 0
                ? facts.size
                  ? `Getting it… ${fileSize(bytes)} of ${fileSize(facts.size)}`
                  : `Getting it… ${fileSize(bytes)}`
                : "Getting it from your computer…"}
            </Text>
          </View>
        ) : state === "ready" ? (
          <View style={styles.progress}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open"
              onPress={() => void show()}
              style={({ pressed }) => [styles.open, pressed && styles.pressed]}
            >
              <Icon name="open" size={16} color={colors.onAction} />
              <Text style={styles.openLabel}>Open</Text>
            </Pressable>
            <Text style={styles.note}>Opens in the phone's viewer.</Text>
          </View>
        ) : state === "unsupported" ? (
          <Text style={styles.note}>
            No app on this phone opens this kind of file. Open it in Linger on
            your computer.
          </Text>
        ) : (
          <View style={styles.progress}>
            <Text style={styles.note}>The file did not download.</Text>
            <Button
              label="Try again"
              variant="secondary"
              onPress={() => {
                fileRef.current = undefined;
                setBytes(0);
                setState("downloading");
                setAttempt((value) => value + 1);
              }}
              style={styles.action}
            />
          </View>
        )}
      </View>
    </View>
  );
}

/** An audio file: its head above the player card. */
function AudioFile(props: {
  readonly facts: FileFacts & { versionId: string };
}) {
  return (
    <View style={styles.center}>
      <View style={styles.audio}>
        <FileHead facts={props.facts} />
        <Recording
          versionId={props.facts.versionId}
          filename={props.facts.filename}
        />
      </View>
    </View>
  );
}

function Page(props: {
  readonly documentId: string;
  /** Read this Version; without one, the Document's latest content. */
  readonly versionId?: string;
  /** Generated knowledge Markdown, which hides its metadata from readers. */
  readonly knowledge: boolean;
  readonly onTitle: (title: string) => void;
}) {
  const teamHub = useTeamHub();
  const content = useQuery({
    queryKey: teamHubKey(
      teamHub.hostId,
      "document",
      props.documentId,
      "content",
      props.versionId,
    ),
    enabled: teamHub.connected,
    gcTime: 0,
    queryFn: async () =>
      readableFrom(
        await teamHub.run((session) =>
          props.versionId
            ? downloadDocumentVersion(session, props.versionId)
            : downloadLatestDocument(session, props.documentId),
        ),
      ),
  });
  const knowledge = useMemo(
    () =>
      props.knowledge && content.data?.kind === "markdown"
        ? readKnowledgeMarkdown(content.data.text)
        : undefined,
    [content.data, props.knowledge],
  );
  const { onTitle } = props;
  useEffect(() => {
    if (knowledge?.title) onTitle(knowledge.title);
  }, [knowledge?.title, onTitle]);
  const denied =
    content.error instanceof HttpError &&
    (content.error.status === 403 || content.error.status === 404);
  if (content.data?.kind === "image")
    return <ReadableView content={content.data} />;
  if (content.data)
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <ReadableView
          content={
            knowledge
              ? { kind: "markdown", text: knowledge.body }
              : content.data
          }
        />
      </ScrollView>
    );
  if (content.isError)
    return (
      <EmptyState
        title={
          denied ? "You cannot read this here" : "The document did not load"
        }
        body={
          denied ? "It is not shared with you, or it was deleted." : undefined
        }
        action={
          denied
            ? undefined
            : { label: "Try again", onPress: () => void content.refetch() }
        }
      />
    );
  return teamHub.connected ? (
    <View style={styles.center}>
      <ActivityIndicator color={colors.muted} />
    </View>
  ) : (
    <EmptyState title="Waiting for your computer" />
  );
}

export default function DocumentScreen() {
  const params = useLocalSearchParams<{
    documentId: string;
    versionId?: string;
    filename?: string;
    mediaType?: string;
  }>();
  const { documentId } = params;
  const teamHub = useTeamHub();
  const [pageTitle, setPageTitle] = useState<string>();
  const document = useQuery({
    queryKey: teamHubKey(teamHub.hostId, "document", documentId),
    enabled: teamHub.connected && !!documentId,
    queryFn: () => teamHub.run((session) => getDocument(session, documentId)),
  });
  const versionId = params.versionId || document.data?.current_version?.id;
  // A file Document's content is its current Version; a native Document's is
  // its latest draft, which only the downloads route renders.
  const readVersionId =
    params.versionId ||
    (document.data && document.data.format !== "blocknote"
      ? document.data.current_version?.id
      : undefined);
  // A file opened from the Library comes without its name; read its version.
  const version = useQuery({
    queryKey: teamHubKey(teamHub.hostId, "document-version", versionId),
    enabled: teamHub.connected && !!versionId && !params.filename,
    queryFn: () =>
      teamHub.run((session) => getDocumentVersion(session, versionId ?? "")),
  });
  const facts: FileFacts | undefined = params.filename
    ? {
        versionId,
        filename: params.filename,
        mediaType: params.mediaType ?? "",
      }
    : version.data
      ? {
          versionId,
          filename: version.data.filename,
          mediaType: version.data.media_type,
          size: version.data.size_bytes,
        }
      : undefined;
  // A native Document has no file of its own: it reads as a page.
  const viewer: Viewer | undefined = facts
    ? viewerFor(facts.filename, facts.mediaType)
    : document.data && !versionId
      ? "page"
      : version.isError
        ? "page"
        : undefined;
  const wikiPage = !!document.data && isWikiPage(document.data);
  const title =
    pageTitle ||
    (document.data
      ? wikiPage
        ? wikiPageTitle(document.data)
        : document.data.title
      : facts?.filename) ||
    "Document";

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title }} />
      <StatusStrip />
      {viewer === "page" || viewer === "image" ? (
        <Page
          documentId={documentId}
          versionId={readVersionId}
          knowledge={wikiPage}
          onTitle={setPageTitle}
        />
      ) : viewer === "audio" && facts?.versionId ? (
        <AudioFile facts={{ ...facts, versionId: facts.versionId }} />
      ) : viewer === "system" && facts?.versionId ? (
        <SystemFile facts={{ ...facts, versionId: facts.versionId }} />
      ) : document.isError ? (
        <EmptyState
          title="The document did not load"
          action={{
            label: "Try again",
            onPress: () => void document.refetch(),
          }}
        />
      ) : teamHub.connected ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.muted} />
        </View>
      ) : (
        <EmptyState title="Waiting for your computer" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
  },
  card: {
    alignSelf: "stretch",
    alignItems: "center",
    gap: space.xl,
    paddingHorizontal: space.xl,
    paddingVertical: space.xl,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  audio: { alignSelf: "stretch", gap: space.xl },
  head: { alignItems: "center", gap: space.xs },
  headName: {
    marginTop: space.sm,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600",
    color: colors.ink,
    textAlign: "center",
  },
  progress: { alignSelf: "stretch", alignItems: "center", gap: space.md },
  bar: {
    alignSelf: "stretch",
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSoft,
    overflow: "hidden",
  },
  barFill: { height: 4, backgroundColor: colors.ink },
  note: { ...StyleSheet.flatten(type.chatMeta), textAlign: "center" },
  open: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    alignSelf: "stretch",
    minHeight: 44,
    borderRadius: radius.lg,
    backgroundColor: colors.action,
  },
  openLabel: { fontSize: 15, fontWeight: "500", color: colors.onAction },
  pressed: { transform: [{ scale: 0.97 }] },
  action: { alignSelf: "stretch" },
});
