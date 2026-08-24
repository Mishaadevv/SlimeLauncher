// Ambient module declarations for static assets.
// This file must stay a "script" (no imports/exports) so the wildcard
// module patterns apply globally for TypeScript.

declare module '*.css' {
  const content: Record<string, string>;
  export default content;
}
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}
