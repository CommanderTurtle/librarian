import type { TreeNode } from "../okf/types.js";

/** Compact indented listing for prompts and the list_directory MCP tool. */
export function formatTree(node: TreeNode, depth = 0): string {
  const lines: string[] = [];
  if (depth === 0) lines.push("/");
  for (const child of node.children ?? []) {
    const indent = "  ".repeat(depth + 1);
    if (child.kind === "directory") {
      lines.push(`${indent}${child.name}/`);
      lines.push(formatTree(child, depth + 1));
    } else if (child.kind === "concept") {
      const meta = [child.type, child.description].filter(Boolean).join(" — ");
      lines.push(`${indent}${child.name}${meta ? `  [${meta}]` : ""}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}
