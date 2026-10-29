import express from "express";
import { config } from "./config.js";
import { initRepo } from "./publish.js";
import { pipelineIdle, webhookRouter } from "./webhook.js";

const app = express();

// /health is what Railway checks; /healthz is the droplet's deploy check.
for (const path of ["/health", "/healthz"]) {
  app.get(path, (_req, res) => {
    res.status(200).send("ok");
  });
}

app.use(webhookRouter);

const server = await (async () => {
  console.log("Cloning/updating blog repo...");
  await initRepo();
  return app.listen(config.port, config.host, () => {
    console.log(
      `remarkable-blog listening on ${config.host}:${config.port}`
    );
  });
})();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Webhooks are acked before the pipeline runs, so let an in-flight post
    // finish publishing before exiting (deploys and reboots send SIGTERM).
    server.close(async () => {
      await pipelineIdle();
      process.exit(0);
    });
  });
}
