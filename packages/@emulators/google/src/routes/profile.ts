import type { RouteContext } from "@emulators/core";
import { getCurrentHistoryId } from "../helpers.js";
import { requireGmailUser } from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

/**
 * users.getProfile: `GET /gmail/v1/users/{userId}/profile`, returning the
 * mailbox's emailAddress, messagesTotal, threadsTotal and current historyId
 * (https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile).
 */
export function profileRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  app.get("/gmail/v1/users/:userId/profile", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;
    const messages = gs.messages.findBy("user_email", authEmail);
    return c.json({
      emailAddress: authEmail,
      messagesTotal: messages.length,
      threadsTotal: new Set(messages.map((m) => m.thread_id)).size,
      historyId: getCurrentHistoryId(gs, authEmail),
    });
  });
}
