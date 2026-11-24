// The one line above a screen that says what is wrong, and nothing when all
// is well. Reaching the computer and Another Me being able to run tasks are
// separate: quitting Desktop stops tasks while TeamHub keeps serving.
import { useEffect, useState } from "react";

import { useComputer } from "../computer/computer-context";
import { useAnotherMeCanRunTasks } from "../state/queries";
import { Notice } from "./controls";

/** Brief reconnects should not flash a banner. */
const CONNECTING_GRACE_MS = 1_500;

function useDelayed(value: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!value) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [delay, value]);
  return value && shown;
}

export function StatusStrip() {
  const { active, status, retryNow } = useComputer();
  const canRunTasks = useAnotherMeCanRunTasks();
  const connecting = useDelayed(
    status?.kind === "connecting",
    CONNECTING_GRACE_MS,
  );
  const name = active?.name ?? "Your computer";

  if (status?.kind === "offline")
    return (
      <Notice
        tone="warning"
        text={`${name} is offline. Linger keeps trying.`}
        action={{ label: "Retry", onPress: retryNow }}
      />
    );
  if (connecting)
    return <Notice tone="neutral" text={`Connecting to ${name}…`} />;
  if (status?.kind === "pending")
    return (
      <Notice tone="info" text={`Approve this phone on ${name} to continue.`} />
    );
  if (status?.kind === "connected" && canRunTasks === false)
    return (
      <Notice tone="warning" text="Your computer can't run tasks right now." />
    );
  return null;
}
