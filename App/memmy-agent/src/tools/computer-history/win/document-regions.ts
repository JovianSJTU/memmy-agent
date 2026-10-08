import path from "node:path";
import type { NativeAppRule } from "./policy.js";
import type { NativeNode } from "./protocol.js";

// Recompute from the complete validated tree. A native "scope matched" assertion would
// not be sufficient authority, nor would a dynamic filename/accessible name.
export function isVsCodeEditorBody(node: NativeNode, nodes: ReadonlyMap<string, NativeNode>, rule: NativeAppRule): boolean {
  if (path.win32.basename(rule.executable).toLowerCase() !== "code.exe"
      || !rule.documentRegions?.some((selector) => "scope" in selector && selector.scope === "vscode.editor")
      || node.controlType !== "Edit" || node.automationId !== "" || node.password !== false || node.missing?.includes("automationId")) return false;
  let parent = node.parentKey;
  let depth = node.depth;
  for (const [type, id] of [["Text", ""], ["Group", ""], ["Group", "workbench.parts.editor"]]) {
    const ancestor = parent ? nodes.get(parent) : undefined;
    if (!ancestor || ancestor.controlType !== type || ancestor.automationId !== id || ancestor.depth !== --depth
        || ancestor.password !== false || ancestor.redaction || ancestor.missing?.includes("automationId")) return false;
    parent = ancestor.parentKey;
  }
  return true;
}

export function documentTextIsLabel(node: NativeNode): boolean {
  const trim = (value: string) => value.replace(/^[ \r\n\t]+|[ \r\n\t]+$/gu, "");
  return node.name !== undefined && node.text !== undefined && trim(node.name) !== "" && trim(node.name) === trim(node.text);
}
