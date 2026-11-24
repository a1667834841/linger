// A chat's last words and when they were said, as its list rows show them.
import type { RoomListItem } from "../api/types";
import { mentionToken } from "./compose-message";

/** Today's time, or the day for anything older. */
export function when(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The latest message, without the @ a direct Agent chat leads with. */
export function previewOf(room: RoomListItem, me: string | undefined): string {
  const latest = room.latest_message;
  const lead = room.direct_peer ? `${mentionToken(room.direct_peer)} ` : "";
  const words =
    lead && latest?.raw_message.startsWith(lead)
      ? latest.raw_message.slice(lead.length)
      : latest?.raw_message;
  return latest
    ? `${latest.author.id === me ? "You: " : ""}${words}`
    : "No messages yet";
}
