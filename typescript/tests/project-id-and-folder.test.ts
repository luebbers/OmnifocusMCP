import { beforeEach, describe, expect, test, vi } from "vitest";
import { z, type ZodRawShape } from "zod";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const registeredTools = new Map<string, ToolHandler>();
const registeredSchemas = new Map<string, unknown>();
const runOmniJsMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  class MockMcpServer {
    tool(name: string, _description: string, schema: unknown, handler: ToolHandler): void {
      registeredTools.set(name, handler);
      registeredSchemas.set(name, schema);
    }

    registerResource(): void {}

    registerPrompt(): void {}

    resource(): void {}

    prompt(): void {}

    async connect(): Promise<void> {}
  }

  return { McpServer: MockMcpServer };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class MockTransport {},
}));

vi.mock("../src/jxa.js", () => ({
  escapeForJxa: (value: string) => JSON.stringify(value),
  runOmniJs: (...args: unknown[]) => runOmniJsMock(...args),
}));

// Minimal OmniJS object model: projects expose their folder as `parentFolder`
// (there is no `project.folder`), and `byName` only matches names, not ids.
function makeOmniJsEnv() {
  const folder = { id: { primaryKey: "f1" }, name: "3 Finanzen", parent: null };
  const otherFolder = { id: { primaryKey: "f2" }, name: "Empty", parent: null };
  const project = {
    id: { primaryKey: "aCH77BP1jES" },
    name: "Education Fund",
    parentFolder: folder,
    status: "[object Project.Status: Active]",
    ending: { location: "project-ending" },
  };
  const projects = Object.assign([project], {
    byName: (name: string) => projects.find((item) => item.name === name) ?? null,
  });
  const created: Array<{ name: string; parent: unknown }> = [];
  class Task {
    id = { primaryKey: `t${created.length + 1}` };
    constructor(
      public name: string,
      public parent: unknown
    ) {
      created.push(this);
    }
    addTag(): void {}
  }
  const document = {
    flattenedProjects: projects,
    flattenedFolders: [folder, otherFolder],
    flattenedTags: Object.assign([], { byName: () => null }),
  };
  const inbox = { ending: { location: "inbox-ending" } };
  return { document, inbox, Task, created };
}

function runScript(script: string, env: ReturnType<typeof makeOmniJsEnv>): unknown {
  const fn = new Function("document", "inbox", "Task", script);
  return fn(env.document, env.inbox, env.Task);
}

describe("project id lookup and parentFolder (regression)", () => {
  beforeEach(async () => {
    registeredTools.clear();
    registeredSchemas.clear();
    runOmniJsMock.mockReset();
    vi.resetModules();
    await import("../src/index.js");
  });

  const getTool = (name: string): ToolHandler => {
    const tool = registeredTools.get(name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool;
  };

  test.each(["aCH77BP1jES", "Education Fund"])(
    "create_task resolves project %s by id or name",
    async (projectRef) => {
      runOmniJsMock.mockResolvedValueOnce({ id: "t1", name: "task" });
      await getTool("create_task")({ name: "task", project: projectRef });
      const script = String(runOmniJsMock.mock.calls[0]?.[0]);
      const env = makeOmniJsEnv();
      runScript(script, env);
      expect(env.created).toHaveLength(1);
      expect(env.created[0].parent).toEqual({ location: "project-ending" });
    }
  );

  test("create_tasks_batch resolves project by id", async () => {
    runOmniJsMock.mockResolvedValueOnce([{ id: "t1", name: "task" }]);
    await getTool("create_tasks_batch")({
      tasks: [{ name: "task", project: "aCH77BP1jES" }],
    });
    const script = String(runOmniJsMock.mock.calls[0]?.[0]);
    const env = makeOmniJsEnv();
    runScript(script, env);
    expect(env.created).toHaveLength(1);
    expect(env.created[0].parent).toEqual({ location: "project-ending" });
  });

  test("create_task still fails for an unknown project", async () => {
    runOmniJsMock.mockResolvedValueOnce({});
    await getTool("create_task")({ name: "task", project: "does-not-exist" });
    const script = String(runOmniJsMock.mock.calls[0]?.[0]);
    expect(() => runScript(script, makeOmniJsEnv())).toThrow("Project not found: does-not-exist");
  });

  test("list_folders counts projects via parentFolder", async () => {
    runOmniJsMock.mockResolvedValueOnce([]);
    await getTool("list_folders")({ limit: 10 });
    const script = String(runOmniJsMock.mock.calls[0]?.[0]);
    const result = runScript(script, makeOmniJsEnv()) as Array<{ name: string; projectCount: number }>;
    expect(result).toEqual([
      { id: "f1", name: "3 Finanzen", parentName: null, projectCount: 1 },
      { id: "f2", name: "Empty", parentName: null, projectCount: 0 },
    ]);
  });

  test("search_projects reports folderName via parentFolder", async () => {
    runOmniJsMock.mockResolvedValueOnce([]);
    await getTool("search_projects")({ query: "Education", limit: 10 });
    const script = String(runOmniJsMock.mock.calls[0]?.[0]);
    expect(script).toContain("folderName: project.parentFolder ? project.parentFolder.name : null");
    expect(script).not.toMatch(/project\.folder\b/);
  });
});
