// Import-hook entry point for the sync protocol test. Redirects the API
// server's push-notification and passkey modules to local stubs so the data
// sync paths (/api/data) boot and run with zero third-party dependencies.
// Usage: node --import ./syncServerRegister.mjs <server.js>
import { register } from 'node:module';

register('./syncServerHooks.mjs', import.meta.url);
