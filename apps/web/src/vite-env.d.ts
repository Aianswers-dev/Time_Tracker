/// <reference types="vite/client" />

/** App version from apps/web/package.json, injected by Vite `define`. */
declare const __APP_VERSION__: string;
/** Short git commit of the build, or "dev" when git is unavailable. */
declare const __BUILD_SHA__: string;
