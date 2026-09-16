export type Mapping = "id" | "title" | "url" | "pathname" | "specific" | "number";

export interface Resource {
  key: string;
  title?: string;
  url?: string;
  pathname?: string;
  specific?: string;
  number?: number;
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
    case "id":
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
    case "specific":
      return required(resource.specific, "specific");
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
