import { startBackend } from "./app";
import { safeErrorMessage } from "./admin";

/** `npm run api`: HTTP API only. Run the listener separately (`npm run listener`). */
startBackend({ withListener: false }).catch((err) => {
  console.error("fatal:", safeErrorMessage(err));
  process.exit(1);
});
