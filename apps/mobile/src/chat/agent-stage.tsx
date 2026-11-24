// The top of a chat. A direct chat puts the Agent on stage: its avatar
// breathes while it works, the line under it says what it is doing with a
// Stop beside it, and tapping the face opens the Agent's profile. A group chat shows its name and members.
// The stage folds down while the keyboard is up.
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import Reanimated, { FadeIn, FadeOut } from "react-native-reanimated";

import type { ActorRef } from "../api/types";
import { useRoomMembers } from "../state/queries";
import { colors, radius, space, type } from "../theme";
import { AgentAvatar } from "../ui/avatar";
import { Icon } from "../ui/icon";
import { isWorking } from "./run-status";
import { useRunViews, useStopRun } from "./run-status-bar";
import { useReducedMotion } from "../ui/motion";
import { RoomAvatar } from "../ui/room-avatar";
import { SidebarButton } from "../ui/sidebar-button";
import { Text } from "../ui/text";

function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const show = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hide = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const ease = () =>
      LayoutAnimation.configureNext(
        LayoutAnimation.create(260, "easeInEaseOut", "scaleXY"),
      );
    const a = Keyboard.addListener(show, () => {
      ease();
      setUp(true);
    });
    const b = Keyboard.addListener(hide, () => {
      ease();
      setUp(false);
    });
    return () => {
      a.remove();
      b.remove();
    };
  }, []);
  return up;
}

/** A slow breath while `active`, settling back to rest when it ends. */
function useBreath(active: boolean) {
  const value = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!active || reduced) {
      Animated.timing(value, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start();
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 1,
          duration: 1_300,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 0,
          duration: 1_300,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, reduced, value]);
  return value;
}

/** Opens an Agent's read-only profile sheet. */
export function openAgent(agentId: string, roomId?: string): void {
  router.push({
    pathname: "/agent/[agentId]",
    params: roomId ? { agentId, roomId } : { agentId },
  });
}

/** The bar above a stage; only Another Me's chat offers Record. */
function TopBar(props: { readonly record?: boolean }) {
  return (
    <View style={styles.bar}>
      <SidebarButton />
      <View style={styles.barSpacer} />
      {props.record ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Record a meeting"
          hitSlop={8}
          onPress={() => router.push("/voice/record")}
          style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}
        >
          <Icon name="record" size={20} color={colors.secondary} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The Agent's current work and its Stop, the one place a direct chat shows
 * them. It fades in and out inside a slot of fixed height, so the stage and
 * the conversation under it never jump when a Run starts or ends.
 */
function WorkLine(props: {
  readonly roomId: string;
  readonly runId: string;
  readonly line: string;
  readonly agentName: string;
  readonly compact?: boolean;
}) {
  const { stopping, stop } = useStopRun(props.roomId);
  const isStopping = stopping.has(props.runId);
  return (
    <Reanimated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(160)}
      style={[styles.work, props.compact && styles.workCompact]}
    >
      <ActivityIndicator
        size="small"
        color={colors.muted}
        style={styles.spinner}
      />
      <Text
        style={[type.small, styles.workText]}
        numberOfLines={1}
        accessibilityLiveRegion="polite"
      >
        {isStopping ? "Stopping…" : props.line}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Stop ${props.agentName}`}
        disabled={isStopping}
        hitSlop={10}
        onPress={() => stop(props.runId)}
        style={({ pressed }) => [
          styles.stop,
          pressed && styles.stopPressed,
          isStopping && styles.stopDisabled,
        ]}
      >
        <View style={styles.stopSquare} />
      </Pressable>
    </Reanimated.View>
  );
}

export function AgentStage(props: {
  readonly roomId: string;
  readonly agent: Pick<ActorRef, "id" | "display_name">;
  readonly idleLine?: string;
  /** Another Me's chat: the bar offers Record. */
  readonly record?: boolean;
}) {
  const views = useRunViews(props.roomId);
  const working = Object.values(views).find(
    (view) => view.run.agent.id === props.agent.id && isWorking(view.run),
  );
  const keyboard = useKeyboardUp();
  const breath = useBreath(!!working);
  const scale = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.06],
  });
  const lift = breath.interpolate({ inputRange: [0, 1], outputRange: [0, -2] });
  const line = working ? working.line || "Working…" : (props.idleLine ?? "");

  if (keyboard)
    return (
      <View style={styles.folded}>
        <SidebarButton />
        <AgentAvatar actorId={props.agent.id} size={28} />
        <View style={styles.foldedText}>
          <Text style={styles.barTitle} numberOfLines={1}>
            {props.agent.display_name}
          </Text>
          {working ? (
            <WorkLine
              roomId={props.roomId}
              runId={working.run.run_id}
              line={line}
              agentName={props.agent.display_name}
              compact
            />
          ) : null}
        </View>
      </View>
    );

  return (
    <View>
      <TopBar record={props.record} />
      <View style={styles.stage}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`About ${props.agent.display_name}`}
          onPress={() => openAgent(props.agent.id, props.roomId)}
          style={({ pressed }) => pressed && styles.facePressed}
        >
          <Animated.View
            style={[
              styles.face,
              { transform: [{ translateY: lift }, { scale }] },
            ]}
          >
            <AgentAvatar actorId={props.agent.id} size={72} />
          </Animated.View>
        </Pressable>
        <Text style={styles.name} numberOfLines={1}>
          {props.agent.display_name}
        </Text>
        {/* A fixed slot: work fades in and out without moving anything. */}
        <View style={styles.slot}>
          {working ? (
            <WorkLine
              key={working.run.run_id}
              roomId={props.roomId}
              runId={working.run.run_id}
              line={line}
              agentName={props.agent.display_name}
            />
          ) : line ? (
            <Text style={[type.small, styles.idle]} numberOfLines={1}>
              {line}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export function GroupStage(props: {
  readonly roomId: string;
  readonly title: string;
}) {
  const members = useRoomMembers(props.roomId).data ?? [];
  return (
    <View>
      <TopBar />
      <View style={styles.group}>
        <RoomAvatar
          members={members.map((member) => member.actor)}
          size={64}
          ring={colors.canvas}
        />
        <Text style={styles.name} numberOfLines={1}>
          {props.title}
        </Text>
        {members.length > 0 ? (
          <Text style={type.small}>
            {members.length === 1 ? "1 member" : `${members.length} members`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    paddingRight: space.md,
  },
  barTitle: { ...type.headline, flex: 1 },
  barButton: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { backgroundColor: colors.sidebarMuted },
  stage: { alignItems: "center", paddingBottom: space.lg, gap: 2 },
  // Resting content casts no shadow; the breath alone says it is working.
  face: { borderRadius: 14 },
  facePressed: { opacity: 0.85, transform: [{ scale: 0.96 }] },
  name: { ...type.headline, marginTop: space.sm, maxWidth: "80%" },
  folded: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 52,
    paddingRight: space.lg,
  },
  foldedText: { flex: 1 },
  barSpacer: { flex: 1 },
  idle: { maxWidth: "80%", textAlign: "center" },
  slot: { height: 28, justifyContent: "center", maxWidth: "86%" },
  work: { flexDirection: "row", alignItems: "center", gap: space.sm },
  workCompact: { maxWidth: "100%" },
  spinner: { transform: [{ scale: 0.75 }] },
  workText: { flexShrink: 1, color: colors.secondary },
  // A quiet round Stop, as a media control: a filled circle, an ink square.
  stop: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.sidebarMuted,
  },
  stopPressed: { transform: [{ scale: 0.92 }] },
  stopDisabled: { opacity: 0.5 },
  stopSquare: {
    width: 8,
    height: 8,
    borderRadius: 1.5,
    backgroundColor: colors.ink,
  },
  group: { alignItems: "center", paddingBottom: space.lg, gap: 2 },
});
