import express from "express";
import { config } from "./config.js";
import { initRepo } from "./publish.js";
import { webhookRouter } from "./webhook.js";

const app = express();

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.use(webhookRouter);

const server = await (async () => {
  console.log("Cloning/updating blog repo...");
  await initRepo();
  return app.listen(config.port, () => {
    console.log(`remarkable-blog listening on port ${config.port}`);
  });
})();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
