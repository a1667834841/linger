import { Stack } from "expo-router";

import { colors } from "../../../theme";
import { SidebarButton } from "../../../ui/sidebar-button";

export default function LibraryLayout() {
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.ink,
        headerStyle: { backgroundColor: colors.canvas },
        headerShadowVisible: false,
        headerBackTitle: "Library",
        contentStyle: { backgroundColor: colors.canvas },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: "Library",
          headerLeft: () => <SidebarButton />,
        }}
      />
      <Stack.Screen name="meetings/[entryId]" options={{ title: "Meeting" }} />
    </Stack>
  );
}
