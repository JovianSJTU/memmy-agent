import type { RecorderArgs } from "./recording-pipeline.js";
export function parseArgs(argv: string[]): RecorderArgs {
  const args: RecorderArgs = {
    allowApps: [],
    onlyApps: [],
    captureText: false,
    captureSearchText: false,
    screenshots: true,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new Error(`${key} requires a value`);
      return next;
    };
    if (key === "--title") args.title = value();
    else if (key === "--out") args.out = value();
    else if (key === "--recordings-dir") args.recordingsDir = value();
    else if (key === "--context-url") args.contextUrl = value();
    else if (key === "--capture-search-text") args.captureSearchText = true;
    else if (key === "--capture-text") args.captureText = true;
    else if (key === "--allow-app") args.allowApps.push(value());
    else if (key === "--only-app") args.onlyApps.push(value());
    else if (key === "--observation-settings") args.observationSettings = value();
    else if (key === "--no-screenshots") args.screenshots = false;
    else if (key === "--help" || key === "-h") args.help = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (args.captureText && args.allowApps.length === 0) {
    throw new Error("--capture-text requires at least one --allow-app application ID");
  }
  return args;
}


import readline from "node:readline";
import { createRecordingPipeline } from "./recording-pipeline.js";
import { startCaptureProcess } from "./capture-process.js";
import type { CapturePlatform } from "./platform.js";

/** CLI/IPC host for the common recorder. Native work is injected by the adapter. */
export async function runRecorder(input: RecorderArgs, platform: CapturePlatform) {
  const args = { ...input,
    allowApps: input.allowApps.map(platform.normalizeApplicationId),
    onlyApps: input.onlyApps.map(platform.normalizeApplicationId),
  };
  const collector = await platform.prepare({ screenshots: args.screenshots });
  if (args.screenshots && !collector.captureScreenshot) throw new Error("collector does not support screenshots");
  let capture: ReturnType<typeof startCaptureProcess> | undefined;
  const pipeline = await createRecordingPipeline(args, {
    platform: platform.platform, defaultTitle: platform.defaultTitle,
    display: collector.display, captureScreenshot: collector.captureScreenshot,
    onFailure: error => capture?.fail(error),
  });
  let terminal: readline.Interface | undefined;
  const onSignal = () => { void capture?.stop("user_interrupt"); };
  const onMessage = (message: unknown) => {
    if (message && typeof message === "object" && "type" in message
      && message.type === "computer-history-stop") void capture?.stop("user_interrupt");
  };
  try {
    capture = startCaptureProcess(collector, {
      platform: platform.platform,
      isStopEvent: platform.isStopEvent,
      async onReady(message) {
        await pipeline.start();
        console.log(`[recorder] goal: ${args.title ?? platform.defaultTitle}`);
        console.log(`[recorder] output: ${pipeline.output}`);
        console.log(`[recorder] recording now; ${platform.stopHint}`);
        if (process.send) process.send({ type: "computer-history-ready", runId: message.runId, controlProtocol: 1 });
      },
      onEvent: event => pipeline.event(event),
      onGap: gap => pipeline.gap(gap),
      onStderr: text => process.stderr.write(text),
    });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.on("message", onMessage);
    await capture.ready;
    if (process.stdin.isTTY) {
      terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
      terminal.once("line", () => { void capture?.stop("user_stop"); });
    }
    await pipeline.stop(await capture.done);
    console.log(`\nrecording written: ${pipeline.output}`);
    console.log(`events: ${pipeline.events}`);
    return { output: pipeline.output, recordingId: pipeline.recordingId, events: pipeline.events };
  } catch (error) {
    await capture?.stop("capture_error").catch(() => undefined);
    await pipeline.stop(`capture_error:${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
    throw error;
  } finally {
    terminal?.close();
    pipeline.dispose();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("message", onMessage);
  }
}
