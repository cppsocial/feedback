export function trustedOrigin(value: string, name: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.origin !== value || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new TypeError(`${name} must be HTTPS or loopback HTTP`);
  }
  return url.origin;
}
