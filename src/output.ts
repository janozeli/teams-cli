import { Document, isNode } from "yaml";
import { CliError } from "./errors.js";

export type OutputFormat = "yaml" | "json";

/** Both serializers consume exactly the JSON data model, including over IPC. */
export function renderOutput(value: unknown, format: OutputFormat = "yaml"): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new CliError("Command returned no structured result", "OUTPUT_INVALID");
  if (format === "json") return json;
  const data = JSON.parse(json);
  const doc = new Document(data, { schema: "core", version: "1.2", aliasDuplicateObjects: false });
  const fence = data?.untrusted;
  if (fence && Array.isArray(fence.fields) && fence.fields.length) {
    const first = doc.get(fence.fields[0], true);
    const last = doc.get(fence.fields.at(-1), true);
    // Comments delimit content without adding invalid lines to the YAML document.
    // The descriptor remains present in JSON and after YAML parsing.
    if (isNode(first)) first.commentBefore = ` ${fence.begin}`;
    if (isNode(last)) last.comment = ` ${fence.end}`;
  }
  return doc.toString({ lineWidth: 0, simpleKeys: true, doubleQuotedAsJSON: true }).trimEnd();
}
