// Minimal stand-in for `virtual:react-router/server-build` in tests.
// The SPA catch-all isn't exercised by the worker tests.
export const entry = { module: {} };
export const routes = {};
export const assets = { entry: { module: "", imports: [] }, routes: {}, url: "", version: "test" };
export const future = {};
export const ssr = false;
export const isSpaMode = true;
export const prerender = [];
export const publicPath = "/";
export const assetsBuildDirectory = "build/client";
export const basename = "/";
export const routeDiscovery = { mode: "initial" };
