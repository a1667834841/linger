// Text, attachments and the voice entry points. Files upload as soon as they
// are picked, so the message itself only names the upload ids and its send
// can be repeated byte for byte from the outbox.
import * as DocumentPicker from "expo-document-picker";
import { router } from "expo-router";
import { File } from "expo-file-system";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";

import {
  deleteAttachmentUpload,
  newIdempotencyKey,
  uploadAttachment,
} from "../api/teamhub";
import type { MessageAttachmentUpload } from "../api/types";
import { HttpError } from "../session/http";
import {
  useDirectAgent,
  useIdentity,
  useRoomMembers,
  useTeamHub,
} from "../state/queries";
import { ActorAvatar } from "../ui/avatar";
import { colors, radius, shadow, space, type } from "../theme";
import { tap } from "../ui/haptics";
import { PressScale } from "../ui/press-scale";
import { Icon, type IconName } from "../ui/icon";
import {
  insertMention,
  mentionQuery,
  mentionToken,
  messageSegments,
  type Mentionable,
} from "./compose-message";
import { mentionStyle } from "./mention-style";
import { armLive } from "../voice";
import { useOutbox } from "./outbox-context";
import { Text, TextInput } from "../ui/text";

/** The session buffers a whole upload in memory, so phones send modest files. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface Pending {
  readonly localId: string;
  readonly name: string;
  readonly upload?: MessageAttachmentUpload;
}

export function Composer(props: {
  readonly roomId: string;
  readonly placeholder: string;
}) {
  const teamHub = useTeamHub();
  const outbox = useOutbox();
  const directAgent = useDirectAgent(props.roomId);
  const myActorId = useIdentity().data?.actorId;
  const members = useRoomMembers(props.roomId).data;
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [mentions, setMentions] = useState<readonly Mentionable[]>([]);
  const nextSelection = useRef<{ start: number; end: number } | undefined>(
    undefined,
  );
  const [files, setFiles] = useState<readonly Pending[]>([]);
  const [problem, setProblem] = useState<string | undefined>();
  const query = mentionQuery(text, caret);
  const suggestions = useMemo(() => {
    if (!query || !members) return [];
    const needle = query.query.toLowerCase();
    return members
      .map((member) => member.actor)
      .filter(
        (actor) =>
          actor.id !== myActorId &&
          actor.id !== directAgent?.id &&
          // Someone already named in the message is not offered again.
          !mentions.some(
            (named) =>
              named.id === actor.id && text.includes(mentionToken(named)),
          ) &&
          actor.display_name.toLowerCase().includes(needle),
      )
      .sort((a, b) =>
        a.kind === b.kind
          ? a.display_name.localeCompare(b.display_name)
          : a.kind === "agent"
            ? -1
            : 1,
      )
      .slice(0, 6);
  }, [directAgent?.id, members, mentions, myActorId, query, text]);
  const choose = (actor: Mentionable) => {
    if (!query) return;
    const next = insertMention(text, query.start, caret, actor);
    setText(next.text);
    setCaret(next.caret);
    nextSelection.current = { start: next.caret, end: next.caret };
    setMentions((current) => [
      ...current.filter((item) => item.id !== actor.id),
      actor,
    ]);
  };

  const uploading = files.some((file) => !file.upload);
  const canSend =
    !uploading &&
    (text.trim().length > 0 || files.length > 0) &&
    !!outbox.outbox;

  const attach = async () => {
    setProblem(undefined);
    if (!teamHub.connected) {
      setProblem("Connect to your computer to attach files.");
      return;
    }
    const picked = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (!asset) return;
    if (asset.size !== undefined && asset.size > MAX_UPLOAD_BYTES) {
      setProblem("Files from the phone can be up to 25 MB.");
      return;
    }
    const localId = newIdempotencyKey();
    setFiles((current) => [...current, { localId, name: asset.name }]);
    try {
      const bytes = await new File(asset.uri).bytes();
      const upload = await teamHub.run((session) =>
        uploadAttachment(
          session,
          props.roomId,
          { name: asset.name, mediaType: asset.mimeType, bytes },
          localId,
        ),
      );
      setFiles((current) =>
        current.map((file) =>
          file.localId === localId ? { ...file, upload } : file,
        ),
      );
    } catch (error) {
      setFiles((current) => current.filter((file) => file.localId !== localId));
      setProblem(
        error instanceof HttpError && error.status === 413
          ? "That file is larger than your computer accepts."
          : `${asset.name} did not upload. Try again.`,
      );
    }
  };

  const remove = (file: Pending) => {
    setFiles((current) =>
      current.filter((item) => item.localId !== file.localId),
    );
    const upload = file.upload;
    if (upload)
      void teamHub
        .run((session) =>
          deleteAttachmentUpload(session, props.roomId, upload.id),
        )
        .catch(() => undefined);
  };

  const send = async () => {
    if (!canSend) return;
    const uploads = files.flatMap((file) => (file.upload ? [file.upload] : []));
    const message = text.trim();
    const named = mentions.filter((actor) =>
      message.includes(mentionToken(actor)),
    );
    tap();
    setText("");
    setMentions([]);
    setFiles([]);
    setProblem(undefined);
    try {
      await outbox.send(props.roomId, message, uploads, {
        mentions: named,
        directAgent,
      });
    } catch {
      setText(message);
      setMentions(named);
      setProblem("The message could not be saved on this phone. Try again.");
    }
  };

  const shownProblem = problem;
  const showSend = canSend || text.trim().length > 0;

  return (
    <View style={styles.wrap}>
      {shownProblem ? (
        <Text style={[type.small, styles.problem]} accessibilityRole="alert">
          {shownProblem}
        </Text>
      ) : null}
      {suggestions.length > 0 ? (
        <MentionSheet actors={suggestions} onChoose={choose} />
      ) : null}
      {files.length > 0 ? (
        <View style={styles.files}>
          {files.map((file) => (
            <View key={file.localId} style={styles.file}>
              {file.upload ? null : (
                <ActivityIndicator size="small" color={colors.muted} />
              )}
              <Text style={[type.small, styles.fileName]} numberOfLines={1}>
                {file.name}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${file.name}`}
                onPress={() => remove(file)}
                hitSlop={10}
              >
                <Icon name="close" size={14} color={colors.muted} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.dock}>
        <RoundButton
          label="Attach a file"
          onPress={() => void attach()}
          icon="add"
        />
        <TextInput
          style={styles.input}
          onChangeText={setText}
          selection={nextSelection.current}
          onSelectionChange={(event) => {
            nextSelection.current = undefined;
            setCaret(event.nativeEvent.selection.end);
          }}
          placeholder={props.placeholder}
          placeholderTextColor={colors.placeholder}
          multiline
          textAlignVertical="center"
          accessibilityLabel="Message"
          submitBehavior="newline"
        >
          {/* Children instead of value, so a chosen @ shows as a mention. */}
          {messageSegments(text, mentions).map((segment, index) =>
            segment.type === "reference" ? (
              <Text key={index} style={mentionStyle}>
                {segment.content}
              </Text>
            ) : (
              <Text key={index}>{segment.content}</Text>
            ),
          )}
        </TextInput>
        {/* As on the desktop: with nothing typed the ink button opens
            Live, with words it sends them. */}
        {showSend ? (
          <RoundButton
            label="Send"
            onPress={() => void send()}
            icon="send"
            tone="ink"
            disabled={!canSend}
          />
        ) : (
          <RoundButton
            label="Talk live"
            onPress={() => {
              tap();
              armLive();
              router.push({
                pathname: "/voice/[mode]",
                params: { mode: "live", roomId: props.roomId },
              });
            }}
            icon="wave"
            tone="ink"
          />
        )}
      </View>
    </View>
  );
}

function RoundButton(props: {
  readonly label: string;
  readonly icon: IconName;
  readonly onPress: () => void;
  /** The gray pill, the ink circle of Send and Live, or a bare icon. */
  readonly tone?: "pill" | "ink" | "quiet";
  readonly disabled?: boolean;
}) {
  const ink = props.tone === "ink";
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={4}
      style={[
        styles.round,
        ink
          ? styles.roundInk
          : props.tone === "quiet"
            ? styles.roundQuiet
            : styles.roundPill,
        props.disabled && styles.roundDisabled,
      ]}
    >
      <Icon
        name={props.icon}
        size={20}
        color={ink ? colors.onAction : colors.secondary}
      />
    </PressScale>
  );
}

/** Room members to mention, as large faces sliding up over the dock. */
function MentionSheet(props: {
  readonly actors: readonly Mentionable[];
  readonly onChoose: (actor: Mentionable) => void;
}) {
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(rise, {
      toValue: 1,
      speed: 18,
      bounciness: 5,
      useNativeDriver: true,
    }).start();
  }, [rise]);
  return (
    <Animated.View
      style={[
        styles.sheet,
        {
          opacity: rise,
          transform: [
            {
              translateY: rise.interpolate({
                inputRange: [0, 1],
                outputRange: [24, 0],
              }),
            },
          ],
        },
      ]}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.sheetRow}
        accessibilityLabel="People and Agents to mention"
      >
        {props.actors.map((actor) => (
          <Pressable
            key={actor.id}
            accessibilityRole="button"
            accessibilityLabel={`Mention ${actor.display_name}`}
            onPress={() => props.onChoose(actor)}
            style={({ pressed }) => [
              styles.pick,
              pressed && styles.pickPressed,
            ]}
          >
            <ActorAvatar actor={actor} size={52} />
            <Text style={styles.pickName} numberOfLines={1}>
              {actor.display_name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.md,
    paddingTop: space.xs,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  problem: { color: colors.danger, paddingHorizontal: space.sm },
  files: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  file: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    maxWidth: "100%",
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  fileName: { color: colors.ink, flexShrink: 1 },
  // The composer: white, a hairline, shadow-md, radius 16 (--composer-*).
  dock: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.xxl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...shadow.md,
  },
  input: {
    ...StyleSheet.flatten(type.chat),
    flex: 1,
    minHeight: 36,
    maxHeight: 140,
    paddingTop: 7,
    paddingBottom: 7,
  },
  round: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  roundPill: { backgroundColor: colors.pill },
  roundInk: { backgroundColor: colors.action },
  roundQuiet: { backgroundColor: "transparent" },
  roundDisabled: { opacity: 0.4 },
  // A menu over the composer: r12, hairline, shadow-md.
  sheet: {
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: space.md,
    ...shadow.md,
  },
  sheetRow: {
    paddingHorizontal: space.md,
    gap: space.lg,
    alignItems: "flex-start",
  },
  pick: {
    alignItems: "center",
    gap: 6,
    width: 68,
    minHeight: 84,
    borderRadius: radius.lg,
  },
  pickPressed: { opacity: 0.6, transform: [{ scale: 0.95 }] },
  pickName: { fontSize: 12, color: colors.secondary, maxWidth: 64 },
});
