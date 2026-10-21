import { startBackend } from "./app";
import { safeErrorMessage } from "./admin";

/** `npm run start`: HTTP API + settlement listener in one process. */
startBackend({ withListener: true }).catch((err) => {
  // Message only: never dump config/env-derived objects or causes.
  console.error("fatal:", safeErrorMessage(err));
  process.exit(1);
});
