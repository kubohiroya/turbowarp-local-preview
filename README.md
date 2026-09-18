# turbowarp-local-preview

Shared local preview primitives for TurboWarp-related development tools.

This package intentionally stays format-agnostic. DSL4, SB3, A-Frame YAML, and other source-specific parsing remain in caller-provided adapters.

## Features

- Stable single-file source watcher with debounce, retry, stabilization timeout, serialized publication, and duplicate suppression.
- Loopback-only preview host with bearer authentication, JSON route helpers, retained events, server-sent event delivery, and lifecycle snapshots.
  Routes may also return a web `Response`; its body is streamed to the client without buffering (client disconnects cancel the source stream, and source stream errors abort the response).
- Browser launcher that accepts only authenticated loopback preview URLs.

## License

MPL-2.0
