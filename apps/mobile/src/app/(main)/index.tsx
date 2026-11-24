// Home: the direct chat with Another Me.
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AgentStage } from "../../chat/agent-stage";
import { ChatHeader, ChatRoom } from "../../chat/chat-room";
import { useAnotherMe, useDirectAgent, useTeamHub } from "../../state/queries";
import { colors } from "../../theme";
import { EmptyState } from "../../ui/controls";
import { StatusStrip } from "../../ui/status-strip";

export default function AnotherMeScreen() {
  const teamHub = useTeamHub();
  const anotherMe = useAnotherMe();
  const roomId = anotherMe.data?.room_id;
  const agent = useDirectAgent(roomId);
  const name = agent?.display_name ?? "Linger";
  if (roomId)
    return (
      <ChatRoom
        roomId={roomId}
        header={
          agent ? (
            <AgentStage roomId={roomId} agent={agent} record />
          ) : (
            <ChatHeader title={name} />
          )
        }
        runsInHeader={!!agent}
        placeholder={`Message ${name}`}
        emptyTitle={`What can ${name} take off your plate?`}
      />
    );
  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ChatHeader title={name} />
      <StatusStrip />
      {!teamHub.connected || anotherMe.isPending ? (
        <EmptyState
          title="Waiting for your computer"
          busy={teamHub.connected}
        />
      ) : anotherMe.isError ? (
        <EmptyState
          title={`${name} could not be loaded`}
          action={{
            label: "Try again",
            onPress: () => void anotherMe.refetch(),
          }}
        />
      ) : (
        <EmptyState
          title={`${name} is getting ready`}
          body="It appears here once Linger has started on your computer."
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
});
