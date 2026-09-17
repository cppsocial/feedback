export type Mapping = "key" | "title" | "url" | "pathname" | "custom" | "number";

export interface Resource {
  key: string;
  title?: string;
  url?: string;
  pathname?: string;
  custom?: string;
  number?: number;
}

export interface DocumentResourceOptions {
  key: string;
  document?: Document;
  location?: Location;
  titleSelectors?: readonly string[];
  canonicalSelector?: string;
  custom?: string;
  number?: number;
}

const defaultTitleSelectors = ['meta[property="og:title"]', "title"];

export function resourceFromDocument(options: DocumentResourceOptions): Resource {
  const document = options.document ?? globalThis.document;
  const location = options.location ?? globalThis.location;
  const title = firstContent(document, options.titleSelectors ?? defaultTitleSelectors);
  const canonical = document.querySelector(options.canonicalSelector ?? 'link[rel="canonical"]');
  const href = canonical?.getAttribute("href") ?? location.href;
  const url = new URL(href, document.baseURI);
  url.hash = "";
  return {
    key: validateResourceId(options.key),
    ...(title ? { title } : {}),
    url: url.href,
    pathname: url.pathname,
    ...(options.custom !== undefined ? { custom: options.custom } : {}),
    ...(options.number !== undefined ? { number: options.number } : {}),
  };
}

const resourceId = /^[A-Za-z0-9](?:[A-Za-z0-9._~/-]{0,198}[A-Za-z0-9._~-])?$/;

export function validateResourceId(value: string): string {
  if (!resourceId.test(value) || value.includes("//") || value.includes("/./") || value.includes("/../")) {
    throw new TypeError("Invalid resource key");
  }
  return value;
}

export function lookupTerm(mapping: Mapping, resource: Resource): string {
  validateResourceId(resource.key);
  switch (mapping) {
    case "key":
      return resource.key;
    case "title":
      return required(resource.title, "title");
    case "url": {
      const value = required(resource.url, "url");
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hash) throw new TypeError("Invalid URL");
      return value;
    }
    case "pathname": {
      const value = resource.pathname ?? resource.url;
      const path = value?.startsWith("http") ? new URL(value).pathname : required(value, "pathname");
      if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
        throw new TypeError("Invalid pathname");
      }
      return path;
    }
    case "custom":
      return required(resource.custom, "custom");
    case "number":
      if (!Number.isSafeInteger(resource.number) || (resource.number ?? 0) < 1) {
        throw new TypeError("Invalid discussion number");
      }
      return String(resource.number);
  }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 512 || normalized.includes("\0")) {
    throw new TypeError(`Invalid ${name}`);
  }
  return normalized;
}

function firstContent(document: Document, selectors: readonly string[]): string | undefined {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const value = element?.getAttribute("content") ?? element?.textContent;
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
}
