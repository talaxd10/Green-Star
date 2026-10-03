// Draws a page into an image and a PDF, with a headless Chromium.
//
// The page is one piece of HTML with its fonts inside it. While it is drawn,
// scripts are off and nothing is fetched, so a name someone typed can never
// make the drawing do anything but show it.

import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { ApiError } from "./errors.ts";

/** The width the statement is laid out at, and so the image's width before it is doubled for sharpness. */
const WIDTH = 760;

export class Renderer {
  readonly #executablePath: string | undefined;
  #browser: Promise<Browser> | null = null;

  /** `executablePath`: a Chromium to use instead of the one Playwright installs. */
  constructor(executablePath?: string) {
    this.#executablePath = executablePath;
  }

  /** The browser, started the first time something is drawn and kept for the next. */
  async #open(): Promise<Browser> {
    if (this.#browser === null) {
      const starting = chromium.launch(this.#executablePath === undefined ? {} : { executablePath: this.#executablePath });
      this.#browser = starting;
      // A start that failed is tried again the next time, not remembered.
      starting.then(
        (browser) => browser.on("disconnected", () => { if (this.#browser === starting) this.#browser = null; }),
        () => { if (this.#browser === starting) this.#browser = null; },
      );
    }
    try {
      return await this.#browser;
    } catch (error) {
      throw new ApiError(
        503,
        "renderer_missing",
        "The image and the PDF cannot be drawn: Chromium is not installed where the API runs. The text is still there to send.",
        { fields: { detail: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error) } },
      );
    }
  }

  async #draw<T>(html: string, work: (context: BrowserContext) => Promise<T>): Promise<T> {
    const browser = await this.#open();
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 600 }, deviceScaleFactor: 2, javaScriptEnabled: false });
    try {
      // Everything the page needs is inside it. Anything else it asks for is refused.
      await context.route("**/*", (route) => route.abort());
      return await work(context);
    } finally {
      await context.close();
    }
  }

  /** The whole page as a PNG, as tall as it needs to be. */
  image(html: string): Promise<Buffer> {
    return this.#draw(html, async (context) => {
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load" });
      return page.screenshot({ type: "png", fullPage: true });
    });
  }

  /** The page as an A4 PDF. */
  pdf(html: string): Promise<Buffer> {
    return this.#draw(html, async (context) => {
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load" });
      return page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    });
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = null;
    if (browser !== null) await browser.then((b) => b.close()).catch(() => {});
  }
}
