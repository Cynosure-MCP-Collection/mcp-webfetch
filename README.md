# @cynosure-mcp/webfetch

Web fetcher that converts pages to clean, LLM-readable markdown. Supports JavaScript-rendered pages, content extraction, and link discovery.

## Installation

```bash
npx @cynosure-mcp/webfetch
```

Or install globally:

```bash
npm install -g @cynosure-mcp/webfetch
webfetch
```

## Tools

| Tool              | Description                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `fetch_page`      | Fetch a URL and return clean markdown. Options: `only_main_content`, `mobile`, `wait_time` |
| `screenshot_page` | Capture a page as a base64 PNG screenshot. Options: `full_page`, `mobile`, `wait_time`     |
| `get_page_links`  | Discover all links on a page, grouped by internal/external                                 |
| `download_file`   | Download any file from a URL to disk                                                       |

## Configuration

No configuration required.

## MCP Config

```json
{
  "mcpServers": {
    "webfetch": {
      "command": "npx",
      "args": ["@cynosure-mcp/webfetch"]
    }
  }
}
```

## License

MIT
