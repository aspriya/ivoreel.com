import { defineConfig } from "@trigger.dev/sdk/v3";
import { puppeteer } from "@trigger.dev/build/extensions/puppeteer";

export default defineConfig({
  project: "ivoreel", // change if your Trigger.dev project slug differs
  runtime: "node",
  logLevel: "log",
  maxDuration: 600,
  // Ensure Chromium is available for Remotion
  build: {
    extensions: [puppeteer()],
  },
  // dirs scanned for tasks
  dirs: ["./trigger"],
});
