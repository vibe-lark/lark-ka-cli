import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  executeContent,
  resourceRef,
  readClipboardImage,
} from "../src/domains/content.mjs";
import { CliError } from "../src/errors.mjs";

function context(handler = async () => ({}), options = {}) {
  const calls = [];
  const ctx = {
    config: { webBaseUrl: "https://private.example" },
    identity: "user",
    flags: {},
    input: async (x) => x,
    ...options,
  };
  ctx.request = async (method, url, opts = {}) => {
    calls.push({ method, url, ...opts });
    if (ctx.dryRun) return { dry_run: true };
    return handler(method, url, opts, calls.length);
  };
  ctx.calls = calls;
  return ctx;
}
async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-content-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("resource URLs route by path, including private wiki and sheet domains", () => {
  assert.deepEqual(resourceRef("https://private.example/wiki/abc#anchor"), {
    token: "abc",
    type: "wiki",
  });
  assert.deepEqual(resourceRef("https://private.example/sheets/sht123"), {
    token: "sht123",
    type: "sheet",
  });
  assert.throws(() => resourceRef("abc\nxyz"), CliError);
});

test("document create returns the created ID when body insertion fails", async () => {
  const ctx = context(async (method, url) => {
    if (url.endsWith("/documents"))
      return { document: { document_id: "doc123" } };
    throw new Error("upstream rejected the body");
  });
  await assert.rejects(
    executeContent(ctx, "docs", "+create", {
      title: "Report",
      content: "first\nsecond",
      "doc-format": "text",
    }),
    (e) => {
      assert.equal(e.type, "partial_failure");
      assert.equal(e.detail.document.document_id, "doc123");
      assert.equal(
        e.detail.document.url,
        "https://private.example/docx/doc123",
      );
      return true;
    },
  );
  assert.equal(ctx.calls.length, 2);
});

test("private deployment does not silently discard unsupported rich formatting", async () => {
  const ctx = context();
  await assert.rejects(
    executeContent(ctx, "docs", "+create", {
      title: "Report",
      content: "<html5-block>interactive</html5-block>",
      "doc-format": "xml",
    }),
    (e) => e.type === "unsupported",
  );
  assert.equal(ctx.calls.length, 0);
});

test("document creation dry-run contains all body chunks and makes no API calls", async () => {
  const ctx = context(undefined, { dryRun: true });
  const result = await executeContent(ctx, "docs", "+create", {
    title: "Report",
    content: Array.from({ length: 110 }, (_, i) => `line ${i}`).join("\n"),
    "doc-format": "text",
  });
  assert.equal(result.requests.length, 4);
  assert.deepEqual(
    result.requests.slice(1).map((x) => x.body.children.length),
    [50, 50, 10],
  );
  assert.equal(ctx.calls.length, 0);
});

test("docs-ai backend preserves XML and uses the create body contract", async () => {
  const ctx = context(async () => ({ document: { document_id: "doc" } }), {
    config: { capabilities: { docsAi: true } },
  });
  const xml = "<h1>Report</h1><p><b>Bold</b></p>";
  await executeContent(ctx, "docs", "+create", {
    content: xml,
    "doc-format": "xml",
    "parent-token": "folder",
  });
  assert.equal(ctx.calls[0].url, "/open-apis/docs_ai/v1/documents");
  assert.equal(ctx.calls[0].body.content, xml);
  assert.equal(ctx.calls[0].body.parent_token, "folder");
});

test("docs-ai partial fetch carries read and export options", async () => {
  const ctx = context(async () => ({}), { config: { docsBackend: "docs-ai" } });
  await executeContent(ctx, "docs", "+fetch", {
    doc: "doc123",
    scope: "keyword",
    keyword: "term",
    detail: "full",
    "doc-format": "xml",
  });
  assert.equal(ctx.calls[0].body.export_option.export_block_id, true);
  assert.equal(ctx.calls[0].body.read_option.keyword, "term");
});

test("document input is resolved once before building requests", async () => {
  const inputs = [];
  const ctx = context(async () => ({ document: { document_id: "doc123" } }), {
    input: async (value) => {
      inputs.push(value);
      return "File contents";
    },
  });
  await executeContent(ctx, "docs", "+create", {
    title: "File",
    content: "@./body.txt",
    "doc-format": "text",
  });
  assert.deepEqual(inputs, ["@./body.txt"]);
  assert.equal(
    ctx.calls[1].body.children[0].text.elements[0].text_run.content,
    "File contents",
  );
});

test("wiki document fetch resolves the target token before reading", async () => {
  const ctx = context(async (method, url) =>
    url.includes("get_node")
      ? { node: { obj_token: "doc123", obj_type: "docx" } }
      : { content: "body" },
  );
  const result = await executeContent(ctx, "docs", "+fetch", {
    doc: "https://private.example/wiki/node1",
  });
  assert.equal(result.content, "body");
  assert.equal(
    ctx.calls[1].url,
    "/open-apis/docx/v1/documents/doc123/raw_content",
  );
});

test("wiki list pagination aggregates pages and preserves final cursor", async () => {
  const ctx = context(async (method, url, opts) =>
    opts.query.page_token
      ? { items: [{ space_id: "2" }], has_more: false }
      : { items: [{ space_id: "1" }], has_more: true, page_token: "next" },
  );
  const result = await executeContent(ctx, "wiki", "+space-list", {
    "page-all": true,
    "page-limit": 5,
  });
  assert.deepEqual(
    result.items.map((x) => x.space_id),
    ["1", "2"],
  );
  assert.equal(ctx.calls.length, 2);
});

test("wiki pagination rejects a repeated token", async () => {
  const ctx = context(async () => ({
    items: [],
    has_more: true,
    page_token: "same",
  }));
  await assert.rejects(
    executeContent(ctx, "wiki", "+space-list", { "page-all": true }),
    /repeated page token/,
  );
});

test("wiki node create resolves my_library before posting", async () => {
  const ctx = context(async (method, url) =>
    url.endsWith("/my_library")
      ? { space: { space_id: "123" } }
      : { node: { node_token: "node" } },
  );
  await executeContent(ctx, "wiki", "+node-create", {
    "space-id": "my_library",
    title: "New",
  });
  assert.equal(ctx.calls[1].url, "/open-apis/wiki/v2/spaces/123/nodes");
  assert.equal(ctx.calls[1].body.obj_type, "docx");
});

test("wiki node create dry-run records resolution as well as mutation", async () => {
  const ctx = context(undefined, { dryRun: true });
  const result = await executeContent(ctx, "wiki", "+node-create", {
    "space-id": "my_library",
    title: "New",
  });
  assert.equal(result.requests.length, 2);
  assert.equal(ctx.calls.length, 0);
});

test("markdown create preserves bytes and uses multipart upload", async (t) => {
  const dir = await workspace(t);
  await writeFile(path.join(dir, "report.md"), "# Title\n正文");
  const ctx = context(async () => ({ file_token: "file1" }), { cwd: dir });
  const result = await executeContent(ctx, "markdown", "+create", {
    file: "./report.md",
    "folder-token": "folder",
  });
  assert.equal(result.file_token, "file1");
  assert.ok(ctx.calls[0].body instanceof FormData);
  assert.equal(ctx.calls[0].body.get("parent_node"), "folder");
  assert.equal(await ctx.calls[0].body.get("file").text(), "# Title\n正文");
});

test("markdown patch with no matches performs no upload", async () => {
  const ctx = context(async () => Buffer.from("existing content"));
  await assert.rejects(
    executeContent(ctx, "markdown", "+patch", {
      "file-token": "file1",
      pattern: "absent",
      content: "replacement",
    }),
    /did not match/,
  );
  assert.deepEqual(
    ctx.calls.map((c) => c.method),
    ["GET"],
  );
});

test("markdown patch replaces literal dollar signs without interpreting substitution codes", async () => {
  const ctx = context(async (method) =>
    method === "GET" ? Buffer.from("A A") : { file_token: "file1" },
  );
  await executeContent(ctx, "markdown", "+patch", {
    "file-token": "file1",
    pattern: "A",
    content: "$&",
  });
  assert.equal(await ctx.calls[1].body.get("file").text(), "$& $&");
});

test("file upload refuses traversal before any request", async (t) => {
  const dir = await workspace(t);
  const ctx = context(undefined, { cwd: dir });
  await assert.rejects(
    executeContent(ctx, "drive", "+upload", { file: "../outside" }),
    /within the current working directory/,
  );
  assert.equal(ctx.calls.length, 0);
});

test("file upload refuses a symlink out of the current directory", async (t) => {
  const dir = await workspace(t);
  const outside = await workspace(t);
  await writeFile(path.join(outside, "secret"), "not to upload");
  await symlink(path.join(outside, "secret"), path.join(dir, "link"));
  const ctx = context(undefined, { cwd: dir });
  await assert.rejects(
    executeContent(ctx, "drive", "+upload", { file: "./link" }),
    /Symlink/,
  );
  assert.equal(ctx.calls.length, 0);
});

test("drive downloads do not overwrite existing files by default", async (t) => {
  const dir = await workspace(t);
  await writeFile(path.join(dir, "existing"), "original");
  const ctx = context(async () => Buffer.from("replacement"), { cwd: dir });
  await assert.rejects(
    executeContent(ctx, "drive", "+download", {
      "file-token": "file1",
      output: "./existing",
    }),
    { code: "EEXIST" },
  );
  assert.equal(await readFile(path.join(dir, "existing"), "utf8"), "original");
});

test("slide XML title is escaped and image placeholders are uploaded before slide create", async (t) => {
  const dir = await workspace(t);
  await writeFile(path.join(dir, "image.png"), Buffer.from([1, 2, 3]));
  const ctx = context(
    async (method, url) =>
      url.endsWith("xml_presentations")
        ? { xml_presentation_id: "deck1" }
        : url.endsWith("upload_all")
          ? { file_token: "image1" }
          : { slide_id: "slide1" },
    { cwd: dir },
  );
  await executeContent(ctx, "slides", "+create", {
    title: "A & B",
    slides: JSON.stringify(['<slide><img src="@./image.png"/></slide>']),
  });
  assert.match(ctx.calls[0].body.xml_presentation.content, /A &amp; B/);
  assert.equal(ctx.calls[1].body.get("parent_type"), "slide_file");
  assert.equal(ctx.calls[1].body.get("parent_node"), "deck1");
  assert.match(ctx.calls[2].body.slide.content, /src="image1"/);
});

test("slide partial failure reports the existing presentation", async () => {
  const ctx = context(async (method, url) => {
    if (url.endsWith("xml_presentations"))
      return { xml_presentation_id: "deck1" };
    throw new Error("page rejected");
  });
  await assert.rejects(
    executeContent(ctx, "slides", "+create", { slides: '["<slide/>"]' }),
    (e) =>
      e.type === "partial_failure" && e.detail.xml_presentation_id === "deck1",
  );
});

test("whiteboard mermaid contract uses syntax_type 2", async () => {
  const ctx = context(async () => ({ node_id: "node1" }));
  await executeContent(ctx, "whiteboard", "+update", {
    "whiteboard-token": "board1",
    source: "graph TD;A-->B",
    input_format: "mermaid",
    overwrite: true,
  });
  assert.equal(ctx.calls[0].body.syntax_type, 2);
  assert.equal(ctx.calls[0].body.overwrite, true);
});

test("full comment uses new_comments and reply_elements contract", async () => {
  const ctx = context();
  await executeContent(ctx, "drive", "+add-comment", {
    doc: "https://private.example/docx/doc123",
    content: '[{"type":"text","text":"Review"}]',
  });
  assert.equal(
    ctx.calls[0].url,
    "/open-apis/drive/v1/files/doc123/new_comments",
  );
  assert.equal(ctx.calls[0].body.reply_elements[0].text, "Review");
});

test("unknown content command lets the dispatcher handle it", async () => {
  assert.equal(
    await executeContent(context(), "docs", "+unknown", {}),
    undefined,
  );
});

test("native XML conversion preserves title, inline styles and nested lists", async () => {
  const ctx = context(undefined, { dryRun: true });
  const result = await executeContent(ctx, "docs", "+create", {
    "doc-format": "xml",
    content:
      '<title>A &amp; B</title><h1>Heading</h1><p><b>Bold</b> and <a href="https://example.test">link</a></p><ul><li>Parent<ul><li>Child</li></ul></li></ul>',
  });
  assert.equal(result.requests[0].body.title, "A & B");
  const top = result.requests[1].body.children;
  assert.equal(top[0].block_type, 3);
  assert.equal(top[1].text.elements[0].text_run.text_element_style.bold, true);
  assert.equal(
    top[1].text.elements[2].text_run.text_element_style.link.url,
    "https://example.test",
  );
  assert.equal(
    result.requests[2].body.children[0].bullet.elements[0].text_run.content,
    "Child",
  );
  assert.equal(top[2].$children, undefined);
});

test("native XML table creation inserts paragraphs into generated cell blocks", async () => {
  const ctx = context(async (method, url, opts, index) => {
    if (index === 1) return { document: { document_id: "doc" } };
    if (index === 2)
      return { children: [{ block_id: "table", children: ["c1", "c2"] }] };
    return { children: [{ block_id: `text${index}` }] };
  });
  await executeContent(ctx, "docs", "+create", {
    title: "Table",
    "doc-format": "xml",
    content:
      "<table><tbody><tr><td><p>A</p></td><td><p><b>B</b></p></td></tr></tbody></table>",
  });
  assert.equal(ctx.calls[1].body.children[0].$table, undefined);
  assert.equal(
    ctx.calls[2].url,
    "/open-apis/docx/v1/documents/doc/blocks/c1/children",
  );
  assert.equal(
    ctx.calls[3].body.children[0].text.elements[0].text_run.text_element_style
      .bold,
    true,
  );
});

test("native Markdown conversion preserves headings, strong text and tables", async () => {
  const ctx = context(undefined, { dryRun: true });
  const result = await executeContent(ctx, "docs", "+create", {
    title: "MD",
    "doc-format": "markdown",
    content: "# Heading\n\n**Bold**\n\n|A|B|\n|---|---|\n|x|y|",
  });
  assert.equal(
    result.requests[1].body.children[0].heading1.elements[0].text_run.content,
    "Heading",
  );
  assert.equal(
    result.requests[1].body.children[1].text.elements[0].text_run
      .text_element_style.bold,
    true,
  );
  assert.equal(result.requests[1].body.children[2].table.property.row_size, 2);
  assert.equal(result.requests.length, 6);
});

test("native table export retains all cell text instead of exhausting the traversal early", async () => {
  const ctx = context(async () => ({
    items: [
      { block_id: "doc", block_type: 1, children: ["table"] },
      {
        block_id: "table",
        parent_id: "doc",
        block_type: 31,
        table: { property: { column_size: 2 } },
        children: ["c1", "c2"],
      },
      { block_id: "c1", parent_id: "table", block_type: 32, children: ["p1"] },
      { block_id: "c2", parent_id: "table", block_type: 32, children: ["p2"] },
      {
        block_id: "p1",
        parent_id: "c1",
        block_type: 2,
        text: { elements: [{ text_run: { content: "A" } }] },
      },
      {
        block_id: "p2",
        parent_id: "c2",
        block_type: 2,
        text: { elements: [{ text_run: { content: "B" } }] },
      },
    ],
    has_more: false,
  }));
  const result = await executeContent(ctx, "docs", "+fetch", {
    doc: "doc",
    "doc-format": "xml",
  });
  assert.match(
    result.document.content,
    /<td><p>A<\/p><\/td><td><p>B<\/p><\/td>/,
  );
});

test("native block_insert_after inserts a sibling rather than a child of the anchor", async () => {
  const ctx = context(async (method, url) =>
    url.endsWith("/anchor")
      ? { block: { block_id: "anchor", parent_id: "doc" } }
      : url.endsWith("/blocks/doc")
        ? { block: { block_id: "doc", children: ["anchor", "next"] } }
        : { children: [{ block_id: "new" }] },
  );
  await executeContent(ctx, "docs", "+update", {
    doc: "doc",
    command: "block_insert_after",
    "block-id": "anchor",
    content: "<p>New</p>",
    "doc-format": "xml",
  });
  assert.equal(
    ctx.calls[2].url,
    "/open-apis/docx/v1/documents/doc/blocks/doc/children",
  );
  assert.equal(ctx.calls[2].body.index, 1);
});

test("native formatting-preserving replacement leaves surrounding style runs intact", async () => {
  const ctx = context(async (method) =>
    method === "GET"
      ? {
          items: [
            {
              block_id: "p",
              block_type: 2,
              text: {
                elements: [
                  {
                    text_run: {
                      content: "Keep ",
                      text_element_style: { italic: true },
                    },
                  },
                  {
                    text_run: {
                      content: "OLD",
                      text_element_style: { bold: true },
                    },
                  },
                  { text_run: { content: " tail" } },
                ],
              },
            },
          ],
          has_more: false,
        }
      : {},
  );
  await executeContent(ctx, "docs", "+update", {
    doc: "doc",
    command: "str_replace",
    pattern: "OLD",
    content: "NEW",
    "doc-format": "text",
  });
  const elements = ctx.calls[1].body.requests[0].update_text_elements.elements;
  assert.equal(elements[0].text_run.text_element_style.italic, true);
  assert.equal(elements[1].text_run.content, "NEW");
  assert.equal(elements[1].text_run.text_element_style.bold, true);
  assert.equal(elements[2].text_run.content, " tail");
});

test("media upload uses parent-node flag without requiring a document URL", async (t) => {
  const dir = await workspace(t);
  await writeFile(path.join(dir, "image.png"), "image");
  const ctx = context(async () => ({ file_token: "media" }), { cwd: dir });
  await executeContent(ctx, "docs", "+media-upload", {
    file: "image.png",
    "parent-type": "docx_image",
    "parent-node": "block",
    "doc-id": "doc",
  });
  assert.equal(ctx.calls[0].body.get("parent_node"), "block");
  assert.equal(ctx.calls[0].body.get("extra"), '{"drive_route_token":"doc"}');
});

test("media insert failure rolls back the created block by its current index", async (t) => {
  const dir = await workspace(t);
  await writeFile(path.join(dir, "image.png"), "image");
  const ctx = context(
    async (method, url, opts, index) => {
      if (index === 1) return { block: { children: ["previous"] } };
      if (index === 2) return { children: [{ block_id: "new_media" }] };
      if (index === 3) throw new Error("Upload rejected");
      if (index === 4)
        return {
          block: {
            children: ["inserted-concurrently", "previous", "new_media"],
          },
        };
      return {};
    },
    { cwd: dir },
  );
  await assert.rejects(
    executeContent(ctx, "docs", "+media-insert", {
      doc: "doc",
      file: "image.png",
      type: "image",
    }),
    (e) => e.type === "partial_failure" && e.detail.rolled_back === true,
  );
  assert.equal(ctx.calls[4].method, "DELETE");
  assert.deepEqual(ctx.calls[4].body, { start_index: 2, end_index: 3 });
});

test("download refuses an output symlink escaping the working directory", async (t) => {
  const dir = await workspace(t),
    outside = await workspace(t);
  await writeFile(path.join(outside, "target"), "keep");
  await symlink(path.join(outside, "target"), path.join(dir, "link"));
  const ctx = context(async () => Buffer.from("replacement"), { cwd: dir });
  await assert.rejects(
    executeContent(ctx, "drive", "+download", {
      "file-token": "file",
      output: "link",
      overwrite: true,
    }),
    /Symlink/,
  );
  assert.equal(await readFile(path.join(outside, "target"), "utf8"), "keep");
});

test("import status zero without an artifact remains pending rather than claiming success", async (t) => {
  const dir = await workspace(t);
  await writeFile(path.join(dir, "source.md"), "data");
  const ctx = context(
    async (method, url) =>
      url.endsWith("/upload_all")
        ? { file_token: "upload" }
        : method === "POST"
          ? { ticket: "ticket" }
          : { result: { job_status: 0 } },
    { cwd: dir, config: { taskPollAttempts: 1 } },
  );
  const result = await executeContent(ctx, "drive", "+import", {
    file: "source.md",
    type: "docx",
  });
  assert.equal(result.pending, true);
  assert.equal(result.ticket, "ticket");
});

test("push defaults to skipping existing remote files", async (t) => {
  const dir = await workspace(t);
  await writeFile(path.join(dir, "same.txt"), "local");
  const ctx = context(
    async (method, url) =>
      url.endsWith("/files")
        ? {
            files: [
              {
                token: "remote",
                name: "same.txt",
                type: "file",
                modified_time: "1",
              },
            ],
            has_more: false,
          }
        : Buffer.from("remote"),
    { cwd: dir },
  );
  const result = await executeContent(ctx, "drive", "+push", {
    "local-dir": ".",
    "folder-token": "folder",
  });
  assert.equal(result.results[0].action, "skipped");
  assert.equal(
    ctx.calls.some((c) => c.method === "POST"),
    false,
  );
});

test("destructive local mirror requires explicit confirmation before network mutation", async (t) => {
  const dir = await workspace(t);
  const ctx = context(undefined, { cwd: dir });
  await assert.rejects(
    executeContent(ctx, "drive", "+pull", {
      "local-dir": ".",
      "folder-token": "folder",
      "delete-local": true,
    }),
    /requires --yes/,
  );
  assert.equal(ctx.calls.length, 0);
});

test("whiteboard malformed success response is not accepted as an update", async () => {
  await assert.rejects(
    executeContent(context(), "whiteboard", "+update", {
      "whiteboard-token": "board",
      input_format: "raw",
      source: '{"raw_nodes":[]}',
    }),
    /no valid ids array/,
  );
});

test("whiteboard code export reads preserved syntax nodes", async () => {
  const ctx = context(async () => ({
    nodes: [{ syntax: { syntax_type: 2, code: "graph TD;A-->B" } }],
  }));
  assert.deepEqual(
    await executeContent(ctx, "whiteboard", "+query", {
      "whiteboard-token": "board",
      output_as: "code",
    }),
    { code: "graph TD;A-->B", syntax_type: "mermaid" },
  );
});

test("clipboard PNG is decoded using a mocked macOS provider without reading the real clipboard", async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
  const calls = [];
  const bytes = await readClipboardImage("darwin", async (command, args) => {
    calls.push({ command, args });
    return { stdout: Buffer.from(`«data PNGf${png.toString("hex")}»`) };
  });
  assert.deepEqual(bytes, png);
  assert.equal(calls[0].command, "osascript");
});

test("styled table input fails before creating an incomplete document", async () => {
  const ctx = context();
  await assert.rejects(
    executeContent(ctx, "docs", "+create", {
      title: "Table",
      "doc-format": "xml",
      content:
        '<table><tbody><tr><td background-color="red"><p>Styled</p></td></tr></tbody></table>',
    }),
    /Styled native table cells require docs_ai/,
  );
  assert.equal(ctx.calls.length, 0);
});

test("explicit docs v2 chooses docs_ai instead of silently using native REST", async () => {
  const calls = [];
  const ctx = {
    identity: "user",
    config: {
      brand: "feishu",
      docsBackend: "mcp",
      mcpUrl: "https://mcp.example.invalid/mcp",
    },
    input: async (value) => value,
    request: async (method, url, options) => {
      calls.push({ method, url, options });
      return { document: { content: "<p>ok</p>" } };
    },
  };
  await executeContent(ctx, "docs", "+fetch", {
    doc: "doc_123",
    "api-version": "v2",
  });
  assert.match(calls[0].url, /docs_ai/);
});
