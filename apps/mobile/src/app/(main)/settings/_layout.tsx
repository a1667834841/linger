import { Stack } from "expo-router";

import { colors } from "../../../theme";
import { SidebarButton } from "../../../ui/sidebar-button";

/** Settings gets the native large title that collapses as the page scrolls. */
export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.ink,
        headerStyle: { backgroundColor: colors.sidebar },
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerLargeTitleEnabled: true,
        headerTitleStyle: { fontFamily: "Geist-SemiBold" },
        headerLargeTitleStyle: { fontFamily: "Geist-SemiBold" },
        contentStyle: { backgroundColor: colors.sidebar },
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: "Settings", headerLeft: () => <SidebarButton /> }}
      />
    </Stack>
  );
}
