// packages/agent/src/realtime/commands.ts
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { RealtimeCommandSchema, type RealtimeCommand } from "@loadout/shared";
import * as log from "../log.js";

export function subscribeCommands(
  client: SupabaseClient,
  machineId: string,
  handlers: { onCommand: (c: RealtimeCommand) => Promise<void> | void }
): RealtimeChannel {
  const channel = client.channel(`machine:${machineId}`, { config: { private: true } });
  channel
    .on("broadcast", { event: "command" }, ({ payload }) => {
      const parsed = RealtimeCommandSchema.safeParse(payload);
      if (!parsed.success) return;
      // The handler runs detached from this callback (Realtime's `on` is sync), so its
      // rejection has nowhere to go: on Node >= 15 an unhandled rejection terminates the
      // process, meaning one failing dashboard command would kill the whole daemon. Callers
      // are expected to handle their own errors (cli.ts wraps its handler in try/catch);
      // this is the last-resort net at the actual crash site.
      void Promise.resolve(handlers.onCommand(parsed.data)).catch((err) => {
        log.error(`unhandled error in command handler for "${parsed.data.type}":`, err);
      });
    })
    .subscribe();
  return channel;
}
