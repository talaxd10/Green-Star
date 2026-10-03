// The renderer on its own: a page is drawn exactly as it is written. Its
// scripts do not run and it reaches nothing outside itself, so whatever a
// person typed into a name can only ever be shown.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Renderer } from "../src/render.ts";

const renderer = new Renderer();
after(() => renderer.close());

const size = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
const page = (body: string) => `<!doctype html><html><body style="margin:0"><div style="height:700px">Statement</div>${body}</body></html>`;

test("a script inside the page does not run", async () => {
  const plain = await renderer.image(page(""));
  assert.deepEqual(size(plain), { width: 1520, height: 1400 });
  // If this ran, the page would become 4,000 pixels tall.
  const scripted = await renderer.image(page(`<script>document.body.innerHTML = '<div style="height:4000px">taken over</div>'</script>`));
  assert.deepEqual(size(scripted), size(plain));
  // Nor does a handler on a picture that fails to load.
  const broken = await renderer.image(page(`<img src="data:image/png;base64,AAAA">`));
  const handler = await renderer.image(page(`<img src="data:image/png;base64,AAAA" onerror="document.body.style.height='4000px'">`));
  assert.deepEqual(size(handler), size(broken));
  assert.ok(size(handler).height < 2000);
});

test("the page fetches nothing: not an image, not a stylesheet, not a font", async () => {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/css" });
    response.end("body{height:4000px}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const plain = await renderer.image(page(""));
    const reaching = page(
      `<link rel="stylesheet" href="${base}/style.css"><img src="${base}/pixel.png"><style>@font-face{font-family:x;src:url(${base}/font.woff2)} p{font-family:x}</style><p>text</p>`,
    );
    const drawn = await renderer.image(reaching);
    const pdf = await renderer.pdf(reaching);
    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.deepEqual(asked, [], "nothing was asked of the server");
    assert.equal(size(drawn).width, size(plain).width);
    assert.ok(size(drawn).height < 2000, "the stylesheet that would have stretched the page was never read");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
