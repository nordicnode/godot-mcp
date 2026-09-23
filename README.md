# Godot MCP

[![Github-sponsors](https://img.shields.io/badge/sponsor-30363D?style=for-the-badge&logo=GitHub-Sponsors&logoColor=#EA4AAA)](https://github.com/sponsors/Coding-Solo)

[![](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white 'Node.js')](https://nodejs.org/en/download/)
[![](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white 'TypeScript')](https://www.typescriptlang.org/)

[![](https://img.shields.io/github/last-commit/Coding-Solo/godot-mcp 'Last Commit')](https://github.com/Coding-Solo/godot-mcp/commits/main)
[![](https://img.shields.io/github/stars/Coding-Solo/godot-mcp 'Stars')](https://github.com/Coding-Solo/godot-mcp/stargazers)
[![](https://img.shields.io/github/forks/Coding-Solo/godot-mcp 'Forks')](https://github.com/Coding-Solo/godot-mcp/network/members)
[![](https://img.shields.io/badge/License-MIT-red.svg 'MIT License')](https://opensource.org/licenses/MIT)


```text
                           (((((((             (((((((
                        (((((((((((           (((((((((((
                        (((((((((((((       (((((((((((((
                        (((((((((((((((((((((((((((((((((
                        (((((((((((((((((((((((((((((((((
         (((((      (((((((((((((((((((((((((((((((((((((((((      (((((
       (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
     ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
    ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
      (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
        (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         (((((((((((@@@@@@@(((((((((((((((((((((((((((@@@@@@@(((((((((((
         (((((((((@@@@,,,,,@@@(((((((((((((((((((((@@@,,,,,@@@@(((((((((
         ((((((((@@@,,,,,,,,,@@(((((((@@@@@(((((((@@,,,,,,,,,@@@((((((((
         ((((((((@@@,,,,,,,,,@@(((((((@@@@@(((((((@@,,,,,,,,,@@@((((((((
         (((((((((@@@,,,,,,,@@((((((((@@@@@((((((((@@,,,,,,,@@@(((((((((
         ((((((((((((@@@@@@(((((((((((@@@@@(((((((((((@@@@@@((((((((((((
         (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         @@@@@@@@@@@@@((((((((((((@@@@@@@@@@@@@((((((((((((@@@@@@@@@@@@@
         ((((((((( @@@(((((((((((@@(((((((((((@@(((((((((((@@@ (((((((((
         (((((((((( @@((((((((((@@@(((((((((((@@@((((((((((@@ ((((((((((
          (((((((((((@@@@@@@@@@@@@@(((((((((((@@@@@@@@@@@@@@(((((((((((
           (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
              (((((((((((((((((((((((((((((((((((((((((((((((((((((
                 (((((((((((((((((((((((((((((((((((((((((((((((
                        (((((((((((((((((((((((((((((((((


                          /$$      /$$  /$$$$$$  /$$$$$$$
                         | $$$    /$$$ /$$__  $$| $$__  $$
                         | $$$$  /$$$$| $$  \__/| $$  \ $$
                         | $$ $$/$$ $$| $$      | $$$$$$$/
                         | $$  $$$| $$| $$      | $$____/
                         | $$\  $ | $$| $$    $$| $$
                         | $$ \/  | $$|  $$$$$$/| $$
                         |__/     |__/ \______/ |__/
```

A Model Context Protocol (MCP) server for interacting with the Godot game engine.

## Introduction

Godot MCP enables AI agents to launch the Godot editor, run projects, capture debug output, and control project execution. This direct feedback loop helps agents understand what works and what doesn't in real Godot projects, leading to better code generation and debugging assistance.

## Features

- **Launch Godot Editor**: Open the Godot editor for a specific project
- **Run Godot Projects**: Execute Godot projects in debug mode
- **Capture Debug Output**: Retrieve console output and error messages
- **Control Execution**: Start and stop Godot projects programmatically
- **Get Godot Version**: Retrieve the installed Godot version
- **List Godot Projects**: Find Godot projects in a specified directory
- **Project Analysis**: Get detailed information about project structure
- **Scene Management**:
  - Create new scenes with specified root node types
  - Add nodes to existing scenes with customizable properties
  - Load sprites and textures into Sprite2D nodes
  - Export 3D scenes as MeshLibrary resources for GridMap
  - Save scenes with options for creating variants
- **UID Management** (for Godot 4.4+):
  - Get UID for specific files
  - Update UID references by resaving resources

## Extended tool set

This checkout extends the upstream server with 36 additional tools (**50 total**), grouped as follows.
Tools carry MCP annotations: read-only tools are marked `readOnlyHint`, destructive ones
(`delete_node`, `remove_autoload`, `uninstall_editor_bridge`) `destructiveHint`, and re-runnable
ones `idempotentHint`.

**Read & validate (the missing feedback loop)**

- `read_scene` — full node tree of a scene: paths, types, groups, scripts, properties, **signal connections**
- `validate_project` — parse-checks every `.gd` with line-accurate errors and load-checks every scene
- `search_project` — filename + content search (literal or regex) across the project
- `get_project_setting` / `set_project_setting` — read/write `project.godot` while preserving comments
- `get_editor_log` — editor output captured at launch plus any log files on disk
- `describe_class` — ClassDB introspection: properties (type + default), methods (signature + flags),
  signals, inheritance chain; `filter` narrows huge classes like `Control`
- `analyze_project` — project linter: main-scene sanity, script compile failures, orphan nodes,
  never-referenced scripts, unused resources — run before declaring work finished
- `doctor` — one-call diagnosis: Godot binary/version, bridge script, project validity, main scene,
  write access, bridge round-trip, input-bridge port. **Call this first when something is not working.**

**Script workflow**

- `create_script` / `edit_script` — create from template or content; targeted find-and-replace edits
- `attach_script` — attach a script to a node (rejects scripts that do not compile)

**Scene editing**

- `set_node_property`, `delete_node`, `move_node`, `duplicate_node`, `instantiate_scene`
- Values accept smart strings: `"Vector2(100, 200)"`, `"#ff0000"`, `"res://icon.svg"`, `"true"`
- `edit_scene` — batch of add/delete/move/set ops applied in **one** Godot launch, all-or-nothing:
  a failing op aborts without touching the file
- `set_node_property` defaults to a surgical `.tscn` text edit (only the one property line changes,
  round-trip formatting is never involved); forced `mode: "text"` refuses instead of silently falling back
- Every scene write is atomic: temp file → verify it loads → keep one `.bak` in `.godot/mcp_backups/` → swap
- Mutations are serialized per project, so parallel tool calls cannot race on the same scene
- `connect_signal` / `disconnect_signal` — wire a node's signal to a script method and persist it;
  validates the signal, the target, and that the target script defines the method (idempotent)
- `add_autoload` / `remove_autoload` / `list_autoloads` — `[autoload]` management in `project.godot`
  that preserves every other setting and comment

**Editor integration (the editor bridge plugin)**

- `install_editor_bridge` / `uninstall_editor_bridge` — drop a `@tool` plugin into
  `addons/mcp_editor_bridge/` and enable it in `project.godot` (idempotent, settings-preserving)
- `editor_status` — is the editor running, what scenes are open, what is selected
  (`connected: false` with no editor is data, not an error)
- `editor_screenshot` — PNG of the whole editor window (not just the game viewport)
- While the plugin is active and has the target scene open, scene mutations
  (`add_node`, `set_node_property`, `delete_node`, `move_node`, `connect_signal`, `disconnect_signal`)
  are **routed through the editor**: applied with `EditorUndoRedo` (so Ctrl+Z works) and saved by the
  editor itself — no more writes behind the editor's back. Anything ambiguous falls back to the file path.
- The plugin listens on `127.0.0.1:6508` and requires a per-run token from
  `.godot/mcp_editor_bridge.token`.

**Run, see, and touch the game**

- `run_headless` — headless execution with full output and exit code
- `run_tests` — auto-detects **GUT or gdUnit4**; GUT runs accept `dir`/`filter` and always leave a
  JUnit XML report in `.godot/mcp_reports/` for CI
- `screenshot` — renders a scene and saves a PNG of the game window
- `send_input` — injects key/mouse/action/text events into a running game and can capture it,
  via a temporary bridge started by `run_project {withInputBridge: true}` (bridge files are
  removed automatically when the game stops). The bridge listens on `127.0.0.1:6507` and rejects
  commands without the per-run token.
- `get_debug_output` — while running, live output; after exit, the final output plus `exitCode`
  instead of an error

**Project config, resources & builds**

- `read_resource` — text content for text formats, class/property dump for binary (runs `--import` if needed)
- `write_resource` — raw text write, or build a resource from a class name + properties
- `add_input_action` — register an InputMap action written directly into `project.godot`
  (never round-trips settings through a headless `ProjectSettings.save()` — that silently destroys them)
- `list_export_presets` — presets from `export_presets.cfg` (name, platform, filter, saved `export_path`)
- `export_project` — headless `--export-release`/`--export-debug` against a preset; refuses to
  overwrite an existing output unless `overwrite: true`, and surfaces missing export templates

Run the full suite with `node .scratch/test_driver.mjs` after `npm run build` (150 assertions,
including a headless-editor round trip against an isolated project clone).

## Requirements

- [Godot Engine](https://godotengine.org/download) installed on your system
- Node.js (>=18.0.0) and npm
- An AI agent that supports MCP

## Quick Start

### Claude Code

```bash
claude mcp add godot -- npx @coding-solo/godot-mcp
```

That's it. Restart Claude Code and your Godot MCP tools are available.

With environment variables:

```bash
claude mcp add godot -e GODOT_PATH=/path/to/godot -e DEBUG=true -- npx @coding-solo/godot-mcp
```

<details>
<summary><strong>Cline</strong></summary>

Add to your Cline MCP settings file (`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["@coding-solo/godot-mcp"],
      "env": {
        "DEBUG": "true"
      },
      "disabled": false,
      "autoApprove": [
        "launch_editor",
        "run_project",
        "get_debug_output",
        "stop_project",
        "get_godot_version",
        "list_projects",
        "get_project_info",
        "create_scene",
        "add_node",
        "load_sprite",
        "export_mesh_library",
        "save_scene",
        "get_uid",
        "update_project_uids"
      ]
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

**Using the Cursor UI:**

1. Go to **Cursor Settings** > **Features** > **MCP**
2. Click on the **+ Add New MCP Server** button
3. Fill out the form:
   - Name: `godot`
   - Type: `command`
   - Command: `npx @coding-solo/godot-mcp`
4. Click "Add"
5. You may need to press the refresh button in the top right corner of the MCP server card to populate the tool list

**Using Project-Specific Configuration:**

Create a file at `.cursor/mcp.json` in your project directory:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["@coding-solo/godot-mcp"],
      "env": {
        "DEBUG": "true"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Other MCP Clients</strong></summary>

For any MCP-compatible client, use this configuration:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["@coding-solo/godot-mcp"],
      "env": {
        "GODOT_PATH": "/path/to/godot",
        "DEBUG": "true"
      }
    }
  }
}
```

</details>

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GODOT_PATH` | Path to the Godot executable (overrides automatic detection) |
| `DEBUG` | Set to `"true"` to enable detailed server-side debug logging |

<details>
<summary><strong>Building from Source</strong></summary>

```bash
git clone https://github.com/Coding-Solo/godot-mcp.git
cd godot-mcp
npm install
npm run build
```

Then point your MCP client to `build/index.js` instead of using `npx`.

</details>


## Architecture

The Godot MCP server uses a bundled GDScript approach for complex operations:

1. **Direct Commands**: Simple operations like launching the editor or getting project info use Godot's built-in CLI commands directly.
2. **Bundled Operations Script**: Complex operations like creating scenes or adding nodes use a single, comprehensive GDScript file (`godot_operations.gd`) that handles all operations.

The bundled script accepts operation type and parameters as JSON, allowing for flexible and dynamic operation execution without generating temporary files for each operation.

3. **Editor bridge plugin (optional)**: `install_editor_bridge` drops a `@tool` plugin into the
   project that listens on `127.0.0.1:6508`. When it is running and has the target scene open,
   scene mutations go through `EditorUndoRedo` + the editor's own save instead of writing `.tscn`
   files directly. Every bridge (editor on 6508, in-game input on 6507) authenticates with a token.

## Troubleshooting

- **Godot Not Found**: Set the `GODOT_PATH` environment variable to your Godot executable path
- **Connection Issues**: Ensure the server is running and restart your AI assistant
- **Invalid Project Path**: Ensure the path points to a directory containing a `project.godot` file
- **Build Issues**: Make sure all dependencies are installed by running `npm install`

<details>
<summary><strong>Cursor-Specific Issues</strong></summary>

- Ensure the MCP server shows up and is enabled in Cursor settings (Settings > MCP)
- MCP tools can only be run using the Agent chat profile (Cursor Pro or Business subscription)
- Use "Yolo Mode" to automatically run MCP tool requests

</details>

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
