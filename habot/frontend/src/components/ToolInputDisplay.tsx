/**
 * Renders tool inputs with specialized formatting based on tool type.
 * - Edit: unified diff view (red removed, green added) with file path header
 * - Write: file content preview with file path header
 * - Read/Glob/Grep: file path or pattern display
 * - Bash: command display
 * - Default: formatted JSON
 */

interface ToolInputDisplayProps {
  toolName: string;
  input: unknown;
}

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface WriteInput {
  file_path: string;
  content: string;
}

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
}

interface GlobInput {
  pattern: string;
  path?: string;
}

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: string;
}

function isEditInput(input: unknown): input is EditInput {
  const obj = input as Record<string, unknown>;
  return obj && typeof obj.file_path === "string" && typeof obj.old_string === "string" && typeof obj.new_string === "string";
}

function isWriteInput(input: unknown): input is WriteInput {
  const obj = input as Record<string, unknown>;
  return obj && typeof obj.file_path === "string" && typeof obj.content === "string";
}

function isReadInput(input: unknown): input is ReadInput {
  const obj = input as Record<string, unknown>;
  return obj && typeof obj.file_path === "string" && !("content" in obj) && !("old_string" in obj);
}

function isBashInput(input: unknown): input is BashInput {
  const obj = input as Record<string, unknown>;
  return obj && typeof obj.command === "string";
}

function isGlobInput(input: unknown): input is GlobInput {
  const obj = input as Record<string, unknown>;
  return obj && typeof obj.pattern === "string" && !("output_mode" in obj);
}

function isGrepInput(input: unknown): input is GrepInput {
  const obj = input as Record<string, unknown>;
  return obj && typeof obj.pattern === "string" && ("output_mode" in obj || "glob" in obj || "type" in obj);
}

function EditDiffView({ input }: { input: EditInput }) {
  const oldLines = input.old_string.split("\n");
  const newLines = input.new_string.split("\n");

  // Simple line diff: find common prefix/suffix, show removed/added in the middle
  const { prefixLen, suffixLen } = findCommonLines(oldLines, newLines);

  const commonPrefix = oldLines.slice(0, prefixLen);
  const removedLines = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const addedLines = newLines.slice(prefixLen, newLines.length - suffixLen);
  const commonSuffix = oldLines.slice(oldLines.length - suffixLen);

  return (
    <div className="tool-input-structured">
      <div className="tool-input-file-path">{input.file_path}</div>
      {input.replace_all && <div className="tool-input-badge">replace all</div>}
      <div className="diff-view">
        {commonPrefix.map((line, i) => (
          <div key={`p-${i}`} className="diff-line diff-context">
            <span className="diff-marker"> </span>
            <span className="diff-text">{line || "\u00A0"}</span>
          </div>
        ))}
        {removedLines.map((line, i) => (
          <div key={`r-${i}`} className="diff-line diff-removed">
            <span className="diff-marker">−</span>
            <span className="diff-text">{line || "\u00A0"}</span>
          </div>
        ))}
        {addedLines.map((line, i) => (
          <div key={`a-${i}`} className="diff-line diff-added">
            <span className="diff-marker">+</span>
            <span className="diff-text">{line || "\u00A0"}</span>
          </div>
        ))}
        {commonSuffix.map((line, i) => (
          <div key={`s-${i}`} className="diff-line diff-context">
            <span className="diff-marker"> </span>
            <span className="diff-text">{line || "\u00A0"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Find the number of matching lines at the start and end of two arrays */
function findCommonLines(a: string[], b: string[]): { prefixLen: number; suffixLen: number } {
  let prefixLen = 0;
  const maxPrefix = Math.min(a.length, b.length);
  while (prefixLen < maxPrefix && a[prefixLen] === b[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  const maxSuffix = Math.min(a.length - prefixLen, b.length - prefixLen);
  while (suffixLen < maxSuffix && a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]) {
    suffixLen++;
  }

  return { prefixLen, suffixLen };
}

function WriteView({ input }: { input: WriteInput }) {
  const preview = input.content.length > 500
    ? input.content.slice(0, 500) + "\n…"
    : input.content;

  return (
    <div className="tool-input-structured">
      <div className="tool-input-file-path">{input.file_path}</div>
      <pre className="tool-input-code">{preview}</pre>
    </div>
  );
}

function ReadView({ input }: { input: ReadInput }) {
  return (
    <div className="tool-input-structured">
      <div className="tool-input-file-path">{input.file_path}</div>
      {(input.offset || input.limit) && (
        <span className="tool-input-meta">
          {input.offset ? `offset: ${input.offset}` : ""}
          {input.offset && input.limit ? ", " : ""}
          {input.limit ? `limit: ${input.limit}` : ""}
        </span>
      )}
    </div>
  );
}

function BashView({ input }: { input: BashInput }) {
  return (
    <div className="tool-input-structured">
      {input.description && <div className="tool-input-meta">{input.description}</div>}
      <pre className="tool-input-code tool-input-command">$ {input.command}</pre>
    </div>
  );
}

function GlobGrepView({ input, isGrep }: { input: GlobInput | GrepInput; isGrep: boolean }) {
  return (
    <div className="tool-input-structured">
      <code className="tool-input-pattern">{input.pattern}</code>
      {input.path && <span className="tool-input-meta"> in {input.path}</span>}
      {isGrep && "glob" in input && input.glob && (
        <span className="tool-input-meta"> files: {input.glob}</span>
      )}
    </div>
  );
}

export function ToolInputDisplay({ toolName, input }: ToolInputDisplayProps) {
  const name = toolName.replace(/^mcp__ha-mcp__/, "");

  if (name === "Edit" && isEditInput(input)) {
    return <EditDiffView input={input} />;
  }
  if (name === "Write" && isWriteInput(input)) {
    return <WriteView input={input} />;
  }
  if (name === "Read" && isReadInput(input)) {
    return <ReadView input={input} />;
  }
  if (name === "Bash" && isBashInput(input)) {
    return <BashView input={input} />;
  }
  if (name === "Glob" && isGlobInput(input)) {
    return <GlobGrepView input={input} isGrep={false} />;
  }
  if (name === "Grep" && isGrepInput(input)) {
    return <GlobGrepView input={input} isGrep={true} />;
  }

  // Default: formatted JSON
  return <pre className="tool-input-json">{JSON.stringify(input, null, 2)}</pre>;
}
