import { FetchedPage, FetchOptions, FetchProvider } from "./types";

export interface HTTPFetchProviderOptions {
  defaultTimeoutMs?: number;
  maxContentLength?: number;
  userAgent?: string;
}

export class HTTPFetchProvider implements FetchProvider {
  private defaultTimeoutMs: number;
  private maxContentLength: number;
  private userAgent: string;

  constructor(options: HTTPFetchProviderOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs || 10000;
    this.maxContentLength = options.maxContentLength || 50000;
    this.userAgent =
      options.userAgent ||
      "Mozilla/5.0 (compatible; JevWriteFactCheck/1.0; +https://github.com/wonderful-galileo)";
  }

  async fetchUrl(url: string, options: FetchOptions = {}): Promise<FetchedPage> {
    const timeout = options.timeoutMs || this.defaultTimeoutMs;
    const maxLen = options.maxContentLength || this.maxContentLength;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": this.userAgent,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
          ...options.headers,
        },
        signal: controller.signal,
      });

      const statusCode = response.status;
      if (!response.ok) {
        return {
          url,
          title: "",
          content: "",
          text: "",
          statusCode,
        };
      }

      const html = await response.text();
      const extracted = this.extractFromHtml(html, url);
      const textSlice = extracted.text.slice(0, maxLen);

      return {
        url,
        title: extracted.title,
        content: textSlice,
        text: textSlice,
        publishedAt: extracted.publishedAt,
        author: extracted.author,
        siteName: extracted.siteName,
        statusCode,
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Fetch request for ${url} timed out after ${timeout}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetch(url: string, options: FetchOptions = {}): Promise<FetchedPage> {
    return this.fetchUrl(url, options);
  }

  private extractFromHtml(html: string, url: string): {
    title: string;
    text: string;
    publishedAt?: string;
    author?: string;
    siteName?: string;
  } {
    let title = "";
    const ogTitleMatch = html.match(/<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (ogTitleMatch) {
      title = this.decodeHtmlEntities(ogTitleMatch[1]);
    } else {
      const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleTagMatch) {
        title = this.decodeHtmlEntities(titleTagMatch[1]);
      }
    }

    let publishedAt: string | undefined;
    const dateMatch =
      html.match(/<meta\s+[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta\s+[^>]*name=["']pubdate["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta\s+[^>]*name=["']date["'][^>]*content=["']([^"']+)["']/i);
    if (dateMatch) {
      publishedAt = dateMatch[1];
    }

    let author: string | undefined;
    const authorMatch =
      html.match(/<meta\s+[^>]*name=["']author["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta\s+[^>]*property=["']article:author["'][^>]*content=["']([^"']+)["']/i);
    if (authorMatch) {
      author = this.decodeHtmlEntities(authorMatch[1]);
    }

    let siteName: string | undefined;
    const siteMatch =
      html.match(/<meta\s+[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
    if (siteMatch) {
      siteName = this.decodeHtmlEntities(siteMatch[1]);
    } else {
      try {
        siteName = new URL(url).hostname;
      } catch {}
    }

    let clean = html;
    clean = clean.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
    clean = clean.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
    clean = clean.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");
    clean = clean.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");
    clean = clean.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "");
    clean = clean.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "");
    clean = clean.replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "");

    clean = clean.replace(/<\/(p|div|h[1-6]|li|tr|article|section)>/gi, "\n");
    clean = clean.replace(/<br\s*[\/]?>/gi, "\n");
    clean = clean.replace(/<[^>]+>/g, " ");
    clean = this.decodeHtmlEntities(clean);

    const text = clean
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0)
      .join("\n");

    return {
      title: title.trim(),
      text,
      publishedAt,
      author,
      siteName,
    };
  }

  private decodeHtmlEntities(str: string): string {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  }
}
