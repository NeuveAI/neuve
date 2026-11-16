// Why: Bun up to 1.4.3 keeps a closed node:sqlite connection until its statements are collected, so
// collection decides when a closed source loses its WAL. Running with this preload makes it early and often.
setInterval(() => Bun.gc(true), 25).unref();
