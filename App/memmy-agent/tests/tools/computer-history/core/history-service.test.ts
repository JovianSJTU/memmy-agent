import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerHistoryService } from "../../../../src/tools/computer-history/core/history-service.js";
import type { HistoryServicePlatform } from "../../../../src/tools/computer-history/core/platform.js";

const require = createRequire(import.meta.url);
const directories: string[] = [];
const instances: ComputerHistoryService[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.shutdown();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

it("runs Windows protocol through real child IPC, pauses, resumes and summarizes with no Mac adapter", async () => {
  // Only the parent's clock changes; native input and system permissions are
  // never accessed. The fake collector is an ordinary Node protocol producer.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-27T10:01:00Z"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-platform-"));
  directories.push(root);
  const helper = path.join(root, "collector.cjs");
  fs.writeFileSync(helper, `
    const runId = require('node:crypto').randomUUID();
    const send = message => process.stdout.write(JSON.stringify({v:1, runId, ...message})+'\\n');
    send({type:'ready', platform:'windows', capabilities:['pointer', 'keyboard', 'ui_tree']});
    const context = {
      application:{id:'exe:c:\\\\example.exe',idKind:'exe_path',name:'Example',pid:process.pid},
      window:{id:'hwnd:1',title:'Example',isBrowser:false,page:{state:'unknown'}},
      privacy:{secureInput:false,passwordTarget:false,privateWindow:'unknown',systemSurface:false}
    };
    send({type:'event',sequence:1,occurredAt:new Date().toISOString(),kind:'pointer.click',context,
      data:{button:'left',clickCount:1,target:{element:{role:'button',name:'Save',isPassword:false}}}});
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      if (JSON.parse(line).type === 'stop') {
        send({type:'stopped',lastSequence:1,reason:'requested'});
        process.stdout.write('', () => process.exit(0));
      }
    });
    // SIGTERM must not be the normal stop mechanism: Windows force-kills it.
    process.on('SIGTERM', () => process.exit(9));
  `);
  const recorder = path.join(root, "recorder.mjs");
  const recorderUrl = new URL("../../../../src/tools/computer-history/core/recorder.ts", import.meta.url).href;
  fs.writeFileSync(recorder, `
    import {spawn} from 'node:child_process';
    import {runRecorder, parseArgs} from ${JSON.stringify(recorderUrl)};
    await runRecorder(parseArgs(process.argv), {
      platform:'windows', defaultTitle:'Windows workflow', stopHint:'Stop from the app',
      normalizeApplicationId:id=>id, isStopEvent:()=>false,
      prepare:async()=>({display:{width:100,height:100},
        start:()=>spawn(process.execPath,[${JSON.stringify(helper)}],{stdio:['pipe','pipe','pipe']})})
    });
  `);
  const platform: HistoryServicePlatform = {
    recorderScript: recorder,
    recorderCommand: script => ({ executable: process.execPath,
      args: ["--import", pathToFileURL(require.resolve("tsx/esm")).href, script] }),
    readPermissions: async () => ({ supported: true, accessibility: true, inputMonitoring: true }),
    openPermission: async () => ({ supported: true, accessibility: true, inputMonitoring: true }),
    permissionsFromError: () => null,
    applicationIcon: async id => `fixture:${id}`,
  };
  const service = new ComputerHistoryService({ platform,
    historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings.json"),
  });
  instances.push(service);
  const chat = vi.fn(async () => ({ content: JSON.stringify({
    title: "Saved a document", description: "You clicked Save in Example.", body: "You used the Save button in Example to save your work.",
  }) }));
  service.setLlmRuntime((() => ({ model: "fixture", provider: { chatWithRetry: chat } })) as unknown as Parameters<typeof service.setLlmRuntime>[0]);
  const first = await service.startObservationWithPermissions();
  expect(first.observation.state).toBe("running");
  const eventPath = (id: string) => path.join(root, "recordings", "segments", id, "events.jsonl");
  const rows = (id: string) => fs.readFileSync(eventPath(id), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const firstId = first.observation.segmentId!;
  await vi.waitFor(() => expect(rows(firstId).some(row => row.eventType === "mouse_click")).toBe(true));
  expect((await service.pauseObservation()).observation.state).toBe("paused");
  expect(rows(firstId).at(-1)).toMatchObject({ eventType: "recording_stopped", details: { reason: "user_interrupt" } });
  const resumed = await service.startObservationWithPermissions(true);
  expect(resumed.observation).toMatchObject({ state: "running", segmentId: firstId });
  await vi.waitFor(() => expect(rows(firstId).filter(row => row.eventType === "mouse_click")).toHaveLength(2));
  await service.pauseObservation();
  const firstRows = rows(firstId).filter(row => row.recordType === "human_event");
  expect(firstRows.map(row => row.sequence)).toEqual(firstRows.map((_, index) => index + 1));
  expect(new Set(firstRows.filter(row => row.source).map(row => row.source.runId)).size).toBe(2);
  expect(firstRows.find(row => row.eventType === "mouse_click").application.id).toBe("exe:c:\\example.exe");
  vi.setSystemTime(new Date("2026-09-27T10:11:00Z"));
  const next = await service.startObservationWithPermissions(true);
  expect(next.observation.segmentId).not.toBe(firstId);
  await vi.waitFor(() => expect(rows(next.observation.segmentId!).some(row => row.eventType === "mouse_click")).toBe(true));
  expect((await service.stopObservation()).observation.state).toBe("stopped");
  await vi.waitFor(() => expect(service.snapshot().histories.length).toBeGreaterThanOrEqual(2));
  expect(service.snapshot().histories.some(history => history.markdown.includes("Save"))).toBe(true);
  expect(chat).toHaveBeenCalled();
  expect(await service.applicationIcon("exe:c:\\example.exe")).toBe("fixture:exe:c:\\example.exe");
}, 20_000);

it("core has no runtime dependency on Mac entry points", () => {
  const core = new URL("../../../../src/tools/computer-history/core/", import.meta.url);
  for (const name of fs.readdirSync(core).filter(name => name.endsWith(".ts"))) {
    const source = fs.readFileSync(new URL(name, core), "utf8");
    expect(source, name).not.toMatch(/(?:from\s+|import\()["'][^"']*(?:\/mac\/|\/mac-|\.swift)/);
    expect(source, name).not.toMatch(/process\.platform\s*[!=]==?\s*["']darwin/);
  }
});
