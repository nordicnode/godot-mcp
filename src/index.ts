#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize } from 'path';
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, copyFileSync, accessSync, rmSync, constants } from 'fs';
import { spawn, execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import { homedir, tmpdir } from 'os';
import net from 'net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
const GODOT_DEBUG_MODE: boolean = true; // Always use GODOT DEBUG MODE

const execFileAsync = promisify(execFile);

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Interface representing a running Godot process
 */
interface GodotProcess {
  process: any;
  output: string[];
  errors: string[];
}

/**
 * Interface for server configuration
 */
interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  godotDebugMode?: boolean;
  strictPathValidation?: boolean; // New option to control path validation behavior
}

/**
 * Interface for operation parameters
 */
interface OperationParams {
  [key: string]: any;
}

/**
 * Port the temporary input/capture bridge listens on inside the running game
 */
const BRIDGE_PORT = 6507;

/** Port the persistent editor-bridge plugin listens on while the editor is open */
const EDITOR_BRIDGE_PORT = 6508;

/**
 * Persistent editor plugin installed by install_editor_bridge. The plugin
 * generates a per-editor-run token, writes it to .godot/mcp_editor_bridge.token,
 * and requires it on every command.
 */
const EDITOR_PLUGIN_CFG = `[plugin]

name="MCP Editor Bridge"
description="Applies Godot MCP scene edits through the open editor (EditorUndoRedo + editor save) instead of writing files behind its back."
author="godot-mcp"
version="0.3.0"
script="plugin.gd"
`;

const EDITOR_PLUGIN_GD = `@tool
extends EditorPlugin

# MCP editor bridge: newline-delimited JSON on 127.0.0.1:6508, authenticated
# with a per-run token in .godot/mcp_editor_bridge.token. Scene edits go
# through EditorUndoRedo so Ctrl+Z works, then the editor itself saves.

const PORT := 6508
const PLUGIN_VERSION := "0.3.0"

var _server: TCPServer = null
var _clients: Array = []
var _buffers: Dictionary = {}
var _token := ""

func _enter_tree():
    _token = _make_token()
    _write_token_file()
    _server = TCPServer.new()
    var err = _server.listen(PORT, "127.0.0.1")
    if err != OK:
        push_warning("[mcp_editor_bridge] cannot listen on 127.0.0.1:" + str(PORT) + " (error " + str(err) + ")")
        _server = null
        return
    print("[mcp_editor_bridge] listening on 127.0.0.1:" + str(PORT))

func _exit_tree():
    for c in _clients:
        if c != null:
            c.disconnect_from_host()
    _clients.clear()
    _buffers.clear()
    if _server != null:
        _server.stop()
        _server = null

func _make_token() -> String:
    var crypto = Crypto.new()
    return crypto.generate_random_bytes(16).hex_encode()

func _write_token_file():
    var dir = ProjectSettings.globalize_path("res://.godot")
    if not DirAccess.dir_exists_absolute(dir):
        DirAccess.make_dir_recursive_absolute(dir)
    var f = FileAccess.open("res://.godot/mcp_editor_bridge.token", FileAccess.WRITE)
    if f == null:
        push_warning("[mcp_editor_bridge] could not write token file; MCP connections will be rejected")
        return
    f.store_string(_token)
    f.close()

func _process(_delta):
    if _server == null or not _server.is_listening():
        return
    while _server.is_connection_available():
        var conn = _server.take_connection()
        _clients.append(conn)
        _buffers[conn] = ""
    var stale: Array = []
    for client in _clients:
        if client == null:
            stale.append(client)
            continue
        client.poll()
        if client.get_status() != StreamPeerTCP.STATUS_CONNECTED:
            stale.append(client)
            continue
        var available = client.get_available_bytes()
        if available <= 0:
            continue
        var parts = client.get_partial_data(available)
        if parts[0] != OK:
            continue
        var chunk: String = (_buffers[client] as String) + (parts[1] as PackedByteArray).get_string_from_utf8()
        while "\\n" in chunk:
            var idx = chunk.find("\\n")
            var line = chunk.substr(0, idx)
            chunk = chunk.substr(idx + 1)
            if line.strip_edges() != "":
                _handle(client, line.strip_edges())
        _buffers[client] = chunk
    for s in stale:
        _clients.erase(s)
        _buffers.erase(s)

func _reply(client, payload):
    client.put_data((JSON.stringify(payload) + "\\n").to_utf8_buffer())

func _handle(client, line: String):
    var msg = JSON.parse_string(line)
    if typeof(msg) != TYPE_DICTIONARY:
        _reply(client, {"ok": false, "error": "invalid JSON command"})
        return
    var msg_id = str(msg.get("id", ""))
    if str(msg.get("token", "")) != _token:
        _reply(client, {"id": msg_id, "ok": false, "error": "unauthorized: bad or missing token"})
        return
    var kind = str(msg.get("type", ""))
    match kind:
        "ping":
            _reply(client, {"id": msg_id, "ok": true, "pong": true, "version": PLUGIN_VERSION})
        "status":
            _reply(client, {"id": msg_id, "ok": true, "status": _status_dict()})
        "apply_and_save":
            _handle_apply(client, msg_id, msg)
        "open_scene":
            var p = str(msg.get("scenePath", ""))
            if p == "":
                _reply(client, {"id": msg_id, "ok": false, "error": "scenePath is required"})
                return
            _reply(client, {"id": msg_id, "ok": true, "opened": _open_scene(p)})
        "screenshot":
            _handle_screenshot(client, msg_id, msg)
        _:
            _reply(client, {"id": msg_id, "ok": false, "error": "unknown command type: " + kind})

func _status_dict() -> Dictionary:
    var open_scenes: Array = []
    if EditorInterface.has_method("get_open_scenes"):
        open_scenes = Array(EditorInterface.get_open_scenes())
    var edited = ""
    var root = EditorInterface.get_edited_scene_root()
    if root != null:
        edited = str(root.scene_file_path)
    var selected: Array = []
    var sel = EditorInterface.get_selection()
    if sel != null:
        for n in sel.get_selected_nodes():
            selected.append(str(n.name))
    return {
        "openScenes": open_scenes,
        "editedScene": edited,
        "selectedNodes": selected,
        "version": PLUGIN_VERSION,
        "godot": Engine.get_version_info().hex,
    }

func _open_scene(scene_path: String) -> bool:
    if not EditorInterface.has_method("open_scene"):
        return false
    var ret = EditorInterface.call("open_scene", _res_norm(scene_path))
    return ret == null or ret == OK

func _handle_screenshot(client, msg_id: String, msg: Dictionary):
    var out_path = str(msg.get("path", ""))
    if out_path == "":
        _reply(client, {"id": msg_id, "ok": false, "error": "path is required"})
        return
    var img = get_viewport().get_texture().get_image()
    if img == null or img.is_empty():
        _reply(client, {"id": msg_id, "ok": false, "error": "viewport texture unavailable (expected in --headless editors)"})
        return
    var save_err = img.save_png(out_path)
    if save_err != OK:
        _reply(client, {"id": msg_id, "ok": false, "error": "failed to save png: " + str(save_err)})
        return
    _reply(client, {"id": msg_id, "ok": true, "path": out_path, "width": img.get_width(), "height": img.get_height()})

func _handle_apply(client, msg_id: String, msg: Dictionary):
    var payload = msg.get("payload", {})
    if typeof(payload) != TYPE_DICTIONARY:
        _reply(client, {"id": msg_id, "ok": false, "error": "payload must be an object"})
        return
    var op = str(msg.get("op", ""))
    var scene_path = _res_norm(_pick(payload, "scenePath", "scene_path"))
    if scene_path == "":
        _reply(client, {"id": msg_id, "ok": false, "error": "payload.scenePath is required"})
        return
    var root = EditorInterface.get_edited_scene_root()
    if root == null and bool(msg.get("autoOpen", false)) and _open_scene(scene_path):
        root = EditorInterface.get_edited_scene_root()
    if root == null:
        _reply(client, {"id": msg_id, "ok": true, "handled": false, "reason": "no scene is open in the editor"})
        return
    var root_path = _res_norm(str(root.scene_file_path))
    if root_path == "" or root_path != scene_path:
        _reply(client, {"id": msg_id, "ok": true, "handled": false, "reason": "editor has " + root_path + " open, target is " + scene_path})
        return
    var result = _apply_op(root, op, payload, scene_path)
    if typeof(result) != TYPE_DICTIONARY:
        _reply(client, {"id": msg_id, "ok": false, "error": str(result)})
        return
    var noop = result.get("noop", false)
    result.erase("noop")
    result["id"] = msg_id
    result["ok"] = true
    result["handled"] = true
    if noop:
        result["saved"] = false
        _reply(client, result)
        return
    if not EditorInterface.has_method("save_scene"):
        result["saved"] = false
        result["reason"] = "editor build has no EditorInterface.save_scene; change is live and dirty"
        _reply(client, result)
        return
    var save_ret = EditorInterface.call("save_scene")
    var saved = save_ret == null or save_ret == OK
    result["saved"] = saved
    if not saved:
        result["reason"] = "save_scene failed: " + str(save_ret)
    _reply(client, result)

func _pick(p: Dictionary, camel: String, snake: String):
    if p.has(camel):
        return p[camel]
    if p.has(snake):
        return p[snake]
    return null

func _res_norm(p) -> String:
    var s = str(p).strip_edges()
    if s == "":
        return ""
    if not s.begins_with("res://"):
        if s.begins_with("/"):
            s = s.trim_prefix("/")
        s = "res://" + s.trim_prefix("./")
    return s

func _resolve(root, path_str):
    if root == null:
        return null
    var p = str(path_str).strip_edges()
    if p == "" or p == "." or p == "root":
        return root
    if p.begins_with("root/"):
        p = p.substr(5)
    return root.get_node_or_null(NodePath(p))

func _parse_value(value):
    if typeof(value) != TYPE_STRING:
        return value
    var s = str(value).strip_edges()
    if s.length() == 7 and s.begins_with("#"):
        return Color.html(s)
    if s.length() == 9 and s.begins_with("#"):
        return Color.html(s)
    var lower = s.to_lower()
    if lower == "true":
        return true
    if lower == "false":
        return false
    if s.begins_with("res://"):
        if ResourceLoader.exists(s):
            return load(s)
        return s
    if s.contains("(") and (s.begins_with("Vector") or s.begins_with("Color") or s.begins_with("Rect2") or s.begins_with("Transform") or s.begins_with("Packed") or s.begins_with("NodePath")):
        var parsed = str_to_var(s)
        if parsed != null:
            return parsed
    if s == "[]" or s == "{}":
        var bracket = str_to_var(s)
        if bracket != null:
            return bracket
    return value

func _has_prop(node, prop: String) -> bool:
    for p in node.get_property_list():
        if str(p.name) == prop:
            return true
    return false

func _closest_prop(node, prop: String) -> String:
    var best = ""
    var best_d = 99
    for p in node.get_property_list():
        var n = str(p.name)
        var d = _edit_distance(n.to_lower(), prop.to_lower())
        if d < best_d:
            best_d = d
            best = n
    if best_d <= 4:
        return best
    return ""

func _edit_distance(a: String, b: String) -> int:
    var m = a.length()
    var n = b.length()
    if m == 0:
        return n
    if n == 0:
        return m
    var prev: Array = []
    for j in range(n + 1):
        prev.append(j)
    for i in range(1, m + 1):
        var cur: Array = [i]
        for j in range(1, n + 1):
            var cost = 0
            if a[i - 1] != b[j - 1]:
                cost = 1
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost))
        prev = cur
    return prev[n]

func _apply_op(root, op: String, p: Dictionary, scene_path: String):
    match op:
        "set_node_property":
            var np = _pick(p, "nodePath", "node_path")
            var node_path = "" if np == null else str(np)
            var prop = str(_pick(p, "property", "property"))
            if node_path == "" or prop == "" or not p.has("value"):
                return "set_node_property requires nodePath, property, and value"
            var node = _resolve(root, node_path)
            if node == null:
                return "node not found: " + node_path + " (read_scene shows node paths)"
            if not _has_prop(node, prop):
                var near = _closest_prop(node, prop)
                var msg = "Property does not exist on " + node.get_class() + ": " + prop
                if near != "":
                    msg += " (closest: " + near + ")"
                return msg
            var prev_val = node.get(prop)
            var new_val = _parse_value(p["value"])
            var ur = get_undo_redo()
            ur.create_action("MCP: set " + prop + " on " + node_path)
            ur.add_undo_property(node, prop, prev_val)
            ur.add_do_property(node, prop, new_val)
            ur.commit_action()
            return {"scene": scene_path, "nodePath": node_path, "property": prop, "previousValue": str(prev_val), "value": str(new_val)}
        "add_node":
            var pp = _pick(p, "parentNodePath", "parent_node_path")
            var parent_path = "root" if pp == null else str(pp)
            if parent_path == "":
                parent_path = "root"
            var node_type = str(_pick(p, "nodeType", "node_type"))
            var node_name = str(_pick(p, "nodeName", "node_name"))
            if node_type == "" or node_name == "":
                return "add_node requires nodeType and nodeName"
            var parent = _resolve(root, parent_path)
            if parent == null:
                return "parent node not found: " + parent_path
            var new_node = null
            if ClassDB.class_exists(node_type) and ClassDB.can_instantiate(node_type):
                new_node = ClassDB.instantiate(node_type)
            if new_node == null:
                return "could not instantiate node type: " + node_type
            new_node.name = node_name
            var props_raw = _pick(p, "properties", "properties")
            if typeof(props_raw) == TYPE_DICTIONARY:
                var props: Dictionary = props_raw
                for key in props:
                    new_node.set(str(key), _parse_value(props[key]))
            var ur = get_undo_redo()
            ur.create_action("MCP: add " + node_name)
            ur.add_do_method(parent, "add_child", new_node, true)
            ur.add_do_property(new_node, "owner", root)
            ur.add_undo_method(parent, "remove_child", new_node)
            ur.commit_action()
            return {"scene": scene_path, "node": node_name, "type": node_type, "parent": parent_path, "added": true}
        "delete_node":
            var dp = _pick(p, "nodePath", "node_path")
            var del_path = "" if dp == null else str(dp)
            var del_node = _resolve(root, del_path)
            if del_node == null:
                return "node not found: " + del_path
            if del_node == root:
                return "refusing to delete the scene root"
            var del_parent = del_node.get_parent()
            var ur = get_undo_redo()
            ur.create_action("MCP: delete " + del_path)
            ur.add_do_method(del_parent, "remove_child", del_node)
            ur.add_undo_method(del_parent, "add_child", del_node)
            ur.commit_action()
            return {"scene": scene_path, "deleted": del_path}
        "move_node":
            if _pick(p, "index", "index") != null:
                return "indexed moves are not routed through the editor"
            var mp = _pick(p, "nodePath", "node_path")
            var mv_path = "" if mp == null else str(mp)
            var tp = _pick(p, "targetParentPath", "target_parent_path")
            var tgt_path = "" if tp == null else str(tp)
            var mv_node = _resolve(root, mv_path)
            var new_parent = _resolve(root, tgt_path)
            if mv_node == null:
                return "node not found: " + mv_path
            if new_parent == null:
                return "target parent not found: " + tgt_path
            if mv_node == root:
                return "cannot move the scene root"
            var probe = new_parent
            while probe != null:
                if probe == mv_node:
                    return "cannot move a node into its own descendant"
                probe = probe.get_parent()
            var old_parent = mv_node.get_parent()
            var ur = get_undo_redo()
            ur.create_action("MCP: move " + mv_path)
            ur.add_do_method(old_parent, "remove_child", mv_node)
            ur.add_do_method(new_parent, "add_child", mv_node, true)
            ur.add_undo_method(old_parent, "add_child", mv_node)
            ur.add_undo_method(new_parent, "remove_child", mv_node)
            ur.commit_action()
            return {"scene": scene_path, "moved": mv_path, "from": str(old_parent.name), "to": str(new_parent.name)}
        "connect_signal":
            var sp = _pick(p, "nodePath", "node_path")
            var c_node_path = "root" if sp == null else str(sp)
            if c_node_path == "":
                c_node_path = "root"
            var sig = str(_pick(p, "signal", "signal"))
            var tp2 = _pick(p, "targetPath", "target_path")
            var t_path = "" if tp2 == null else str(tp2)
            var meth = str(_pick(p, "method", "method"))
            if sig == "" or t_path == "" or meth == "":
                return "connect_signal requires signal, targetPath, and method"
            var src = _resolve(root, c_node_path)
            var tgt = _resolve(root, t_path)
            if src == null:
                return "node not found: " + c_node_path
            if tgt == null:
                return "node not found: " + t_path
            var sig_found = false
            for s2 in src.get_signal_list():
                if str(s2.get("name", "")) == sig:
                    sig_found = true
                    break
            if not sig_found:
                return "Signal not found: " + sig + " on " + src.get_class() + " (" + c_node_path + ")"
            var conn = {"from": c_node_path, "to": t_path, "signal": sig, "method": meth}
            var callable = Callable(tgt, meth)
            if src.is_connected(StringName(sig), callable):
                return {"noop": true, "scene": scene_path, "connection": conn, "connected": false, "alreadyConnected": true}
            if not tgt.has_method(meth):
                return "Method not found on target node: " + meth + " (" + t_path + ")"
            var ur = get_undo_redo()
            ur.create_action("MCP: connect " + sig)
            ur.add_do_method(src, "connect", StringName(sig), callable, CONNECT_PERSIST)
            ur.add_undo_method(src, "disconnect", StringName(sig), callable)
            ur.commit_action()
            return {"scene": scene_path, "connection": conn, "connected": true, "alreadyConnected": false}
        "disconnect_signal":
            var dp2 = _pick(p, "nodePath", "node_path")
            var d_node_path = "root" if dp2 == null else str(dp2)
            if d_node_path == "":
                d_node_path = "root"
            var sigd = str(_pick(p, "signal", "signal"))
            var tp3 = _pick(p, "targetPath", "target_path")
            var t_path2 = "" if tp3 == null else str(tp3)
            var methd = str(_pick(p, "method", "method"))
            if sigd == "" or t_path2 == "" or methd == "":
                return "disconnect_signal requires signal, targetPath, and method"
            var src2 = _resolve(root, d_node_path)
            var tgt2 = _resolve(root, t_path2)
            if src2 == null:
                return "node not found: " + d_node_path
            if tgt2 == null:
                return "node not found: " + t_path2
            var conn2 = {"from": d_node_path, "to": t_path2, "signal": sigd, "method": methd}
            var callable2 = Callable(tgt2, methd)
            if not src2.is_connected(StringName(sigd), callable2):
                return {"noop": true, "scene": scene_path, "connection": conn2, "disconnected": false, "alreadyDisconnected": true}
            var ur = get_undo_redo()
            ur.create_action("MCP: disconnect " + sigd)
            ur.add_do_method(src2, "disconnect", StringName(sigd), callable2)
            ur.add_undo_method(src2, "connect", StringName(sigd), callable2, CONNECT_PERSIST)
            ur.commit_action()
            return {"scene": scene_path, "connection": conn2, "disconnected": true, "alreadyDisconnected": false}
        _:
            return "unsupported op in editor bridge: " + op
`;

/**
 * Temporary bridge script written into the project when run_project is called
 * with withInputBridge. Deleted again by stop_project.
 */
const BRIDGE_SCRIPT = `extends Node
# Temporary input/capture bridge installed by the Godot MCP server.
# Created by run_project with withInputBridge; deleted on stop_project.
# Speaks newline-delimited JSON commands over 127.0.0.1:<port>.

const DEFAULT_PORT = 6507

var port = DEFAULT_PORT
var server: TCPServer = null
var clients: Array = []
var buffers: Dictionary = {}

func _ready():
    var env_port = OS.get_environment("MCP_BRIDGE_PORT")
    if env_port != "":
        port = int(env_port)
    server = TCPServer.new()
    var err = server.listen(port, "127.0.0.1")
    if err != OK:
        printerr("[MCP_BRIDGE] Failed to listen on 127.0.0.1:" + str(port) + " (error " + str(err) + ")")
        return
    print("MCP_BRIDGE_READY:" + str(port))
    var target = OS.get_environment("MCP_TARGET_SCENE")
    if target == "":
        target = str(ProjectSettings.get_setting("application/run/main_scene", ""))
    if target != "":
        var packed = load(target)
        if packed != null and packed is PackedScene:
            var inst = packed.instantiate()
            add_child(inst)
            print("[MCP_BRIDGE] Loaded target scene: " + target)
        else:
            printerr("[MCP_BRIDGE] Failed to load target scene: " + target)

func _process(_delta):
    if server == null or not server.is_listening():
        return
    while server.is_connection_available():
        var conn = server.take_connection()
        clients.append(conn)
        buffers[conn] = ""
    for client in clients:
        if client == null:
            continue
        client.poll()
        if client.get_status() != StreamPeerTCP.STATUS_CONNECTED:
            continue
        var available = client.get_available_bytes()
        if available <= 0:
            continue
        var parts = client.get_partial_data(available)
        if parts[0] != OK:
            continue
        var chunk: String = (buffers[client] as String) + (parts[1] as PackedByteArray).get_string_from_utf8()
        while "\\n" in chunk:
            var idx = chunk.find("\\n")
            var line = chunk.substr(0, idx)
            chunk = chunk.substr(idx + 1)
            if line.strip_edges() != "":
                handle_command(client, line.strip_edges())
        buffers[client] = chunk

func reply(client, payload):
    client.put_data((JSON.stringify(payload) + "\\n").to_utf8_buffer())

func handle_command(client, line: String):
    var cmd = JSON.parse_string(line)
    if typeof(cmd) != TYPE_DICTIONARY:
        reply(client, {"ok": false, "error": "invalid JSON command"})
        return
    var cmd_id = str(cmd.get("id", ""))
    var expected_token = OS.get_environment("MCP_BRIDGE_TOKEN")
    if expected_token != "" and str(cmd.get("token", "")) != expected_token:
        reply(client, {"id": cmd_id, "ok": false, "error": "unauthorized: bad or missing token"})
        return
    var kind = str(cmd.get("type", ""))
    match kind:
        "ping":
            reply(client, {"id": cmd_id, "ok": true, "pong": true})
        "query":
            var scene_path = ""
            var scene = get_tree().current_scene
            if scene != null:
                scene_path = str(scene.scene_file_path)
            reply(client, {"id": cmd_id, "ok": true, "scene": scene_path, "nodes": get_tree().get_node_count(), "fps": Engine.get_frames_per_second()})
        "key":
            var key_name = str(cmd.get("key", "")).to_lower()
            var code = lookup_keycode(key_name)
            if code == KEY_NONE:
                reply(client, {"id": cmd_id, "ok": false, "error": "unknown key: " + key_name})
                return
            var key_action = str(cmd.get("action", "tap"))
            if key_action == "press" or key_action == "tap":
                send_key(code, true)
            if key_action == "release" or key_action == "tap":
                send_key(code, false)
            reply(client, {"id": cmd_id, "ok": true, "key": key_name, "action": key_action})
        "action":
            var action_name = str(cmd.get("action", ""))
            if action_name == "":
                reply(client, {"id": cmd_id, "ok": false, "error": "missing action name"})
                return
            if not InputMap.has_action(action_name):
                reply(client, {"id": cmd_id, "ok": false, "error": "unknown input action: " + action_name})
                return
            var pressed = bool(cmd.get("pressed", true))
            if pressed:
                Input.action_press(action_name)
            else:
                Input.action_release(action_name)
            reply(client, {"id": cmd_id, "ok": true, "action": action_name, "pressed": pressed})
        "mouse":
            var button_name = str(cmd.get("button", "left")).to_lower()
            var buttons = {"left": MOUSE_BUTTON_LEFT, "right": MOUSE_BUTTON_RIGHT, "middle": MOUSE_BUTTON_MIDDLE, "wheel_up": MOUSE_BUTTON_WHEEL_UP, "wheel_down": MOUSE_BUTTON_WHEEL_DOWN}
            if not buttons.has(button_name):
                reply(client, {"id": cmd_id, "ok": false, "error": "unknown mouse button: " + button_name})
                return
            if cmd.has("x") and cmd.has("y"):
                Input.warp_mouse(Vector2(float(cmd.x), float(cmd.y)))
            var mouse_action = str(cmd.get("action", "click"))
            var ev = InputEventMouseButton.new()
            ev.button_index = buttons[button_name]
            ev.pressed = mouse_action != "release"
            Input.parse_input_event(ev)
            if mouse_action == "click":
                var release_ev = ev.duplicate() as InputEventMouseButton
                release_ev.pressed = false
                Input.parse_input_event(release_ev)
            reply(client, {"id": cmd_id, "ok": true})
        "text":
            var text_value = str(cmd.get("text", ""))
            for i in text_value.length():
                var cp = text_value.unicode_at(i)
                var press_ev = InputEventKey.new()
                press_ev.unicode = cp
                press_ev.pressed = true
                Input.parse_input_event(press_ev)
                var release_key_ev = InputEventKey.new()
                release_key_ev.unicode = cp
                release_key_ev.pressed = false
                Input.parse_input_event(release_key_ev)
            reply(client, {"id": cmd_id, "ok": true, "chars": text_value.length()})
        "capture":
            var out_path = str(cmd.get("path", ""))
            if out_path == "":
                reply(client, {"id": cmd_id, "ok": false, "error": "missing capture path"})
                return
            var img = get_viewport().get_texture().get_image()
            if img == null or img.is_empty():
                reply(client, {"id": cmd_id, "ok": false, "error": "viewport texture unavailable"})
                return
            var save_err = img.save_png(out_path)
            if save_err != OK:
                reply(client, {"id": cmd_id, "ok": false, "error": "failed to save png: " + str(save_err)})
                return
            reply(client, {"id": cmd_id, "ok": true, "path": out_path, "width": img.get_width(), "height": img.get_height()})
        "quit":
            reply(client, {"id": cmd_id, "ok": true})
            get_tree().quit()
        _:
            reply(client, {"id": cmd_id, "ok": false, "error": "unknown command type: " + kind})

func send_key(code: int, pressed: bool):
    var ev = InputEventKey.new()
    ev.keycode = code
    ev.physical_keycode = code
    ev.pressed = pressed
    Input.parse_input_event(ev)

func lookup_keycode(name_lower: String) -> int:
    var named = {"space": KEY_SPACE, "enter": KEY_ENTER, "return": KEY_ENTER, "escape": KEY_ESCAPE, "tab": KEY_TAB, "backspace": KEY_BACKSPACE, "delete": KEY_DELETE, "home": KEY_HOME, "end": KEY_END, "pageup": KEY_PAGEUP, "pagedown": KEY_PAGEDOWN, "left": KEY_LEFT, "right": KEY_RIGHT, "up": KEY_UP, "down": KEY_DOWN, "shift": KEY_SHIFT, "ctrl": KEY_CTRL, "alt": KEY_ALT, "meta": KEY_META}
    if named.has(name_lower):
        return named[name_lower]
    if name_lower.begins_with("f") and name_lower.length() > 1 and name_lower.substr(1).is_valid_int():
        var fn = int(name_lower.substr(1))
        if fn >= 1 and fn <= 12:
            return KEY_F1 + (fn - 1)
    if name_lower.length() == 1:
        var code = name_lower.unicode_at(0)
        if code >= 97 and code <= 122:
            return code - 32
        if code >= 48 and code <= 57:
            return code
    return KEY_NONE
`;

/**
 * Temporary bridge scene: a single node running BRIDGE_SCRIPT
 */
/**
 * MCP tool annotations: honest hints to clients about which tools only read,
 * which can irreversibly destroy state, and which are safe to re-run.
 */
const TOOL_ANNOTATIONS: Record<string, { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }> = {
  get_debug_output: { readOnlyHint: true },
  get_godot_version: { readOnlyHint: true },
  list_projects: { readOnlyHint: true },
  get_project_info: { readOnlyHint: true },
  read_scene: { readOnlyHint: true },
  validate_project: { readOnlyHint: true },
  get_project_setting: { readOnlyHint: true },
  read_resource: { readOnlyHint: true },
  search_project: { readOnlyHint: true },
  describe_class: { readOnlyHint: true },
  list_autoloads: { readOnlyHint: true },
  analyze_project: { readOnlyHint: true },
  list_export_presets: { readOnlyHint: true },
  doctor: { readOnlyHint: true },
  editor_status: { readOnlyHint: true },
  get_editor_log: { readOnlyHint: true },
  delete_node: { destructiveHint: true },
  remove_autoload: { destructiveHint: true },
  uninstall_editor_bridge: { destructiveHint: true },
  set_project_setting: { idempotentHint: true },
  add_input_action: { idempotentHint: true },
  add_autoload: { idempotentHint: true },
  set_node_property: { idempotentHint: true },
  connect_signal: { idempotentHint: true },
  disconnect_signal: { idempotentHint: true },
  attach_script: { idempotentHint: true },
  install_editor_bridge: { idempotentHint: true },
  run_project: { openWorldHint: true },
  run_headless: { openWorldHint: true },
  screenshot: { openWorldHint: true },
  send_input: { openWorldHint: true },
  editor_screenshot: { openWorldHint: true },
  export_project: { openWorldHint: true },
};

const BRIDGE_SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://godot_mcp_bridge.gd" id="1_bridge"]

[node name="McpBridge" type="Node"]
script = ExtResource("1_bridge")
`;

/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
  private server: Server;
  private activeProcess: GodotProcess | null = null;
  /** Final state of the most recent run_project, for get_debug_output after exit */
  private lastRunExit: { code: number | null; output: string[]; errors: string[] } | null = null;
  /** Per-run token authenticating commands to the port-6507 input bridge */
  private bridgeToken: string | null = null;
  private editorProcess: any = null;
  private editorOutput: string[] = [];
  private bridgeFiles: string[] = [];
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean = false;

  /**
   * Parameter name mappings between snake_case and camelCase
   * This allows the server to accept both formats
   */
  private parameterMappings: Record<string, string> = {
    'project_path': 'projectPath',
    'scene_path': 'scenePath',
    'root_node_type': 'rootNodeType',
    'parent_node_path': 'parentNodePath',
    'node_type': 'nodeType',
    'node_name': 'nodeName',
    'texture_path': 'texturePath',
    'node_path': 'nodePath',
    'output_path': 'outputPath',
    'mesh_item_names': 'meshItemNames',
    'new_path': 'newPath',
    'new_name': 'newName',
    'file_path': 'filePath',
    'directory': 'directory',
    'recursive': 'recursive',
    'scene': 'scene',
    'max_depth': 'maxDepth',
    'include_properties': 'includeProperties',
    'script_path': 'scriptPath',
    'old_string': 'oldString',
    'new_string': 'newString',
    'replace_all': 'replaceAll',
    'extends_type': 'extendsType',
    'class_name': 'className',
    'target_parent_path': 'targetParentPath',
    'source_scene_path': 'sourceScenePath',
    'frame_delay': 'frameDelay',
    'timeout_seconds': 'timeoutSeconds',
    'extra_args': 'extraArgs',
    'quit_after': 'quitAfter',
    'resource_class': 'resourceClass',
    'max_lines': 'maxLines',
    'max_results': 'maxResults',
    'with_input_bridge': 'withInputBridge',
    'raw_value': 'rawValue',
  };

  /**
   * Keys whose values must reach Godot verbatim: agent-authored property names
   * (e.g. an exported `mySpeed`) and free-form values must not be snake_cased.
   */
  private rawPassthroughKeys: Set<string> = new Set(['properties', 'value', 'content', 'events']);

  /** Tools that mutate files or process state; serialized per project */
  private mutatingTools: Set<string> = new Set([
    'create_scene', 'add_node', 'load_sprite', 'save_scene', 'export_mesh_library',
    'create_script', 'edit_script', 'attach_script',
    'set_node_property', 'delete_node', 'move_node', 'duplicate_node', 'instantiate_scene', 'edit_scene',
    'set_project_setting', 'add_input_action', 'write_resource', 'update_project_uids',
    'connect_signal', 'disconnect_signal', 'add_autoload', 'remove_autoload', 'export_project',
    'install_editor_bridge', 'uninstall_editor_bridge',
    'run_project', 'stop_project', 'screenshot',
  ]);

  /** Scene mutations that can ride the open editor's UndoRedo + save instead of touching files directly */
  private editorRoutedTools: Set<string> = new Set([
    'add_node', 'set_node_property', 'delete_node', 'move_node', 'connect_signal', 'disconnect_signal',
  ]);

  /** Per-project promise chain: one mutation at a time per project */
  private projectLocks: Map<string, Promise<any>> = new Map();

  private async withProjectLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.projectLocks.get(projectPath) || Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.projectLocks.set(
      projectPath,
      next.catch(() => undefined)
    );
    return next;
  }

  /**
   * Reverse mapping from camelCase to snake_case
   * Generated from parameterMappings for quick lookups
   */
  private reverseParameterMappings: Record<string, string> = {};

  constructor(config?: GodotServerConfig) {
    // Initialize reverse parameter mappings
    for (const [snakeCase, camelCase] of Object.entries(this.parameterMappings)) {
      this.reverseParameterMappings[camelCase] = snakeCase;
    }
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    let godotDebugMode = GODOT_DEBUG_MODE;

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        godotDebugMode = config.godotDebugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '0.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);

    // Cleanup on exit
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Log debug messages if debug mode is enabled
   * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
   */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  /**
   * Create a standardized error response with possible solutions
   */
  private createErrorResponse(message: string, possibleSolutions: string[] = []): any {
    // Log the error
    console.error(`[SERVER] Error response: ${message}`);
    if (possibleSolutions.length > 0) {
      console.error(`[SERVER] Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    const response: any = {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true,
    };

    if (possibleSolutions.length > 0) {
      response.content.push({
        type: 'text',
        text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
      });
    }

    return response;
  }

  /**
   * Validate a path to prevent path traversal attacks
   */
  private validatePath(path: string): boolean {
    // Basic validation to prevent path traversal
    if (!path || path.includes('..')) {
      return false;
    }

    // Add more validation as needed
    return true;
  }

  /**
   * Validate a Godot class name to prevent arbitrary script instantiation.
   * Class names must be simple identifiers (e.g. "Node2D", "CharacterBody3D").
   * Rejects anything that looks like a path (res://, absolute paths, dots, slashes, colons).
   */
  private validateClassName(name: string): boolean {
    if (!name) return false;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  }

  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    // Check cache first
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // Check if the file exists (skip for 'godot' which might be in PATH)
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      // Try to execute Godot with --version flag
      // Using execFileAsync with argument array to prevent command injection
      await execFileAsync(path, ['--version']);

      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = [
      'godot', // Check if 'godot' is in PATH first
    ];

    // Add platform-specific paths
    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`
      );
    }

    // Try each possible path
    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
    }
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
    return false;
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    if (this.activeProcess) {
      this.logDebug('Killing active Godot process');
      this.activeProcess.process.kill();
      this.activeProcess = null;
    }
    await this.server.close();
  }

  /**
   * Check if the Godot version is 4.4 or later
   * @param version The Godot version string
   * @returns True if the version is 4.4 or later
   */
  private isGodot44OrLater(version: string): boolean {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 4 || (major === 4 && minor >= 4);
    }
    return false;
  }

  /**
   * Normalize parameters to camelCase format
   * @param params Object with either snake_case or camelCase keys
   * @returns Object with all keys in camelCase format
   */
  private normalizeParameters(params: OperationParams): OperationParams {
    if (!params || typeof params !== 'object') {
      return params;
    }
    
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        let normalizedKey = key;
        
        // If the key is in snake_case, convert it to camelCase using our mapping
        if (key.includes('_') && this.parameterMappings[key]) {
          normalizedKey = this.parameterMappings[key];
        }
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[normalizedKey] = this.normalizeParameters(params[key] as OperationParams);
        } else {
          result[normalizedKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Convert camelCase keys to snake_case
   * @param params Object with camelCase keys
   * @returns Object with snake_case keys
   */
  private convertCamelToSnakeCase(params: OperationParams): OperationParams {
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        // Convert camelCase to snake_case
        const snakeKey = this.reverseParameterMappings[key] || key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

        // Free-form payloads (property maps, values, file contents) pass through untouched
        if (this.rawPassthroughKeys.has(key)) {
          result[snakeKey] = params[key];
          continue;
        }
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[snakeKey] = this.convertCamelToSnakeCase(params[key] as OperationParams);
        } else {
          result[snakeKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  private async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string
  ): Promise<{ stdout: string; stderr: string }> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

    // Convert camelCase parameters to snake_case for Godot script
    const snakeCaseParams = this.convertCamelToSnakeCase(params);
    this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);


    // Ensure godotPath is set
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    try {
      // Serialize the snake_case parameters to a valid JSON string
      const paramsJson = JSON.stringify(snakeCaseParams);

      // Build argument array for execFile to prevent command injection
      // Using execFile with argument arrays avoids shell interpretation entirely
      const args = [
        '--headless',
        '--path',
        projectPath,  // Safe: passed as argument, not interpolated into shell command
        '--script',
        this.operationsScriptPath,
        operation,
        paramsJson,  // Safe: passed as argument, not interpreted by shell
      ];

      
      if (GODOT_DEBUG_MODE) {
        args.push('--debug-godot');
      }

      this.logDebug(`Executing: ${this.godotPath} ${args.join(' ')}`);

      const { stdout, stderr } = await execFileAsync(this.godotPath!, args);

      return { stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (error: unknown) {
      // If execFileAsync throws, it still contains stdout/stderr
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        return {
          stdout: execError.stdout ?? '',
          stderr: execError.stderr ?? '',
        };
      }

      throw error;
    }
  }

  /**
   * Get the structure of a Godot project
   * @param projectPath Path to the Godot project
   * @returns Object representing the project structure
   */
  private async getProjectStructure(projectPath: string): Promise<any> {
    try {
      // Get top-level directories in the project
      const entries = readdirSync(projectPath, { withFileTypes: true });

      const structure: any = {
        scenes: [],
        scripts: [],
        assets: [],
        other: [],
      };

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name.toLowerCase();

          // Skip hidden directories
          if (dirName.startsWith('.')) {
            continue;
          }

          // Count files in common directories
          if (dirName === 'scenes' || dirName.includes('scene')) {
            structure.scenes.push(entry.name);
          } else if (dirName === 'scripts' || dirName.includes('script')) {
            structure.scripts.push(entry.name);
          } else if (
            dirName === 'assets' ||
            dirName === 'textures' ||
            dirName === 'models' ||
            dirName === 'sounds' ||
            dirName === 'music'
          ) {
            structure.assets.push(entry.name);
          } else {
            structure.other.push(entry.name);
          }
        }
      }

      return structure;
    } catch (error) {
      this.logDebug(`Error getting project structure: ${error}`);
      return { error: 'Failed to get project structure' };
    }
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
    const projects: Array<{ path: string; name: string }> = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    // Define available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: any[] = [
        {
          name: 'launch_editor',
          description: 'Launch Godot editor for a specific project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_project',
          description: 'Run the Godot project and capture output',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scene: {
                type: 'string',
                description: 'Optional: Specific scene to run',
              },
              withInputBridge: {
                type: 'boolean',
                description:
                  'Optional (default false). Start the game behind a temporary TCP input/capture bridge so send_input and bridge-based screenshot work. Wraps the scene in a bridge node; the MCP server removes the bridge files on stop_project.',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_debug_output',
          description: 'Get the current debug output and errors',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'stop_project',
          description: 'Stop the currently running Godot project',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_godot_version',
          description: 'Get the installed Godot version',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'list_projects',
          description: 'List Godot projects in a directory',
          inputSchema: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Directory to search for Godot projects',
              },
              recursive: {
                type: 'boolean',
                description: 'Whether to search recursively (default: false)',
              },
            },
            required: ['directory'],
          },
        },
        {
          name: 'get_project_info',
          description: 'Retrieve metadata about a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'create_scene',
          description: 'Create a new Godot scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path where the scene file will be saved (relative to project)',
              },
              rootNodeType: {
                type: 'string',
                description: 'Type of the root node (e.g., Node2D, Node3D)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'add_node',
          description: 'Add a node to an existing scene',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              parentNodePath: {
                type: 'string',
                description: 'Path to the parent node (e.g., "root" or "root/Player")',
              },
              nodeType: {
                type: 'string',
                description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)',
              },
              nodeName: {
                type: 'string',
                description: 'Name for the new node',
              },
              properties: {
                type: 'object',
                description: 'Optional properties to set on the node',
              },
            },
            required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
          },
        },
        {
          name: 'load_sprite',
          description: 'Load a sprite into a Sprite2D node',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the Sprite2D node (e.g., "root/Player/Sprite2D")',
              },
              texturePath: {
                type: 'string',
                description: 'Path to the texture file (relative to project)',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
          },
        },
        {
          name: 'export_mesh_library',
          description: 'Export a scene as a MeshLibrary resource',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (.tscn) to export',
              },
              outputPath: {
                type: 'string',
                description: 'Path where the mesh library (.res) will be saved',
              },
              meshItemNames: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description: 'Optional: Names of specific mesh items to include (defaults to all)',
              },
            },
            required: ['projectPath', 'scenePath', 'outputPath'],
          },
        },
        {
          name: 'save_scene',
          description: 'Save changes to a scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              newPath: {
                type: 'string',
                description: 'Optional: New path to save the scene to (for creating variants)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'get_uid',
          description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              filePath: {
                type: 'string',
                description: 'Path to the file (relative to project) for which to get the UID',
              },
            },
            required: ['projectPath', 'filePath'],
          },
        },
        {
          name: 'update_project_uids',
          description: 'Update UID references in a Godot project by resaving resources (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'edit_scene',
          description:
            'Apply many scene mutations in ONE Godot run with a single atomic, all-or-nothing save. Faster than repeated single edits, and a failed operation leaves the file untouched.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file path relative to project' },
              operations: {
                type: 'array',
                description:
                  'Ordered operations. Supported: {op:"add_node", parentNodePath?, nodeType, nodeName, properties?}, {op:"delete_node", nodePath}, {op:"move_node", nodePath, targetParentPath, index?}, {op:"set_property", nodePath, property, value}, {op:"duplicate_node", nodePath, newName?, targetParentPath?}, {op:"instantiate_scene", sourceScenePath, parentNodePath?, nodeName?}',
                items: { type: 'object' },
              },
            },
            required: ['projectPath', 'scenePath', 'operations'],
          },
        },
        {
          name: 'read_scene',
          description:
            'Read a scene file and return its full node tree: names, types, node paths, groups, attached scripts, and properties. Use this to inspect the current state of a scene before or after editing it.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file path relative to the project (e.g. "Main.tscn")' },
              maxDepth: { type: 'number', description: 'Maximum tree depth to return (default 8)' },
              includeProperties: { type: 'boolean', description: 'Include node properties (default true)' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'create_script',
          description: 'Create a new GDScript (.gd) file. Fails if the file exists unless overwrite is true (use edit_script to modify an existing script).',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scriptPath: { type: 'string', description: 'Script path relative to project (e.g. "scripts/player.gd")' },
              content: { type: 'string', description: 'Full script source. If omitted, a template is generated.' },
              template: {
                type: 'string',
                enum: ['empty', 'ready', 'process', 'tool'],
                description: 'Template when content is omitted (default "ready")',
              },
              extendsType: { type: 'string', description: 'Base type for templates (default "Node", e.g. "CharacterBody2D")' },
              className: { type: 'string', description: 'Optional class_name to declare' },
              overwrite: { type: 'boolean', description: 'Overwrite if the file exists (default false)' },
            },
            required: ['projectPath', 'scriptPath'],
          },
        },
        {
          name: 'edit_script',
          description:
            'Edit an existing GDScript file: either replace a unique string (oldString/newString), or overwrite it entirely with content.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scriptPath: { type: 'string', description: 'Script path relative to project' },
              oldString: { type: 'string', description: 'Exact text to find (must match unless replaceAll)' },
              newString: { type: 'string', description: 'Replacement text' },
              replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false)' },
              content: { type: 'string', description: 'Full new file contents (overwrites; use instead of oldString/newString)' },
            },
            required: ['projectPath', 'scriptPath'],
          },
        },
        {
          name: 'attach_script',
          description: 'Attach an existing script file to a node in a scene and save the scene.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file path relative to project' },
              nodePath: { type: 'string', description: 'Target node path (e.g. "root" or "root/Player")' },
              scriptPath: { type: 'string', description: 'Existing script path relative to project (create it first with create_script)' },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'scriptPath'],
          },
        },
        {
          name: 'validate_project',
          description:
            'Validate the project: parse-check every GDScript file (with line-accurate errors) and load/instantiate every scene, reporting failures. Run this after editing to catch errors before running the game.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              target: {
                type: 'string',
                enum: ['all', 'scripts', 'scenes'],
                description: 'What to validate (default "all")',
              },
              file: { type: 'string', description: 'Optional single script to check instead of all scripts' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'set_node_property',
          description:
            'Set a property on a node in a scene and save it. Values accept smart strings: "Vector2(100, 200)", "#ff0000", "Color(1,0,0)", "res://icon.svg", "true".',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file path relative to project' },
              nodePath: { type: 'string', description: 'Target node path (e.g. "root/Player")' },
              property: { type: 'string', description: 'Property name (e.g. "position", "text", "visible")' },
              value: { description: 'New value; strings, numbers, booleans, or smart strings like "Vector2(1, 2)"' },
              mode: {
                type: 'string',
                enum: ['auto', 'text', 'pack'],
                description:
                  '"auto" (default) edits the .tscn text directly when safe and falls back to repacking; "text" forces a surgical text edit (fails instead of falling back); "pack" forces the load-mutate-save path',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'property', 'value'],
          },
        },
        {
          name: 'delete_node',
          description: 'Delete a node from a scene and save it (the scene root cannot be deleted).',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file path relative to project' },
              nodePath: { type: 'string', description: 'Node path to delete (e.g. "root/OldEnemy")' },
            },
            required: ['projectPath', 'scenePath', 'nodePath'],
          },
        },
        {
          name: 'move_node',
          description: 'Reparent a node within a scene and save it.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file path relative to project' },
              nodePath: { type: 'string', description: 'Node path to move' },
              targetParentPath: { type: 'string', description: 'New parent node path (e.g. "root/UI")' },
              index: { type: 'number', description: 'Optional child index under the new parent' },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'targetParentPath'],
          },
        },
        {
          name: 'duplicate_node',
          description: 'Duplicate a node (with its subtree) inside a scene and save it.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file path relative to project' },
              nodePath: { type: 'string', description: 'Node path to duplicate' },
              newName: { type: 'string', description: 'Name for the copy (default: source name + "Copy")' },
              targetParentPath: { type: 'string', description: 'Optional parent for the copy (default: same parent)' },
            },
            required: ['projectPath', 'scenePath', 'nodePath'],
          },
        },
        {
          name: 'instantiate_scene',
          description: 'Add an instance of one scene as a child node inside another scene (nested scene composition).',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Host scene file path relative to project' },
              sourceScenePath: { type: 'string', description: 'Scene to instance (relative to project)' },
              parentNodePath: { type: 'string', description: 'Parent node path (default "root")' },
              nodeName: { type: 'string', description: 'Optional name override for the instance' },
            },
            required: ['projectPath', 'scenePath', 'sourceScenePath'],
          },
        },
        {
          name: 'screenshot',
          description:
            'Render a scene offscreen and save a PNG screenshot of the game window (opens a brief window). If the game is already running through run_project with withInputBridge, prefer send_input with a {"type":"capture"} event instead.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scene: { type: 'string', description: 'Scene to capture (relative to project). Defaults to the project main scene.' },
              outputPath: { type: 'string', description: 'Where to write the PNG (absolute path or res:// path; default project dir)' },
              frameDelay: { type: 'number', description: 'Frames to render before capturing (default 20)' },
              width: { type: 'number', description: 'Window width in pixels' },
              height: { type: 'number', description: 'Window height in pixels' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'send_input',
          description:
            'Send input events into a running game started with run_project {withInputBridge: true}. Events run in order. Types: {"type":"key","key":"space","action":"tap|press|release"}, {"type":"action","action":"jump","pressed":true}, {"type":"mouse","button":"left","action":"click","x":100,"y":200}, {"type":"text","text":"hello"}, {"type":"wait","ms":250}, {"type":"capture","path":"/abs/out.png"} (screenshot the running game), {"type":"query"} (scene/fps info), {"type":"quit"}.',
          inputSchema: {
            type: 'object',
            properties: {
              events: {
                type: 'array',
                items: { type: 'object' },
                description: 'Ordered list of input events to deliver to the running game',
              },
            },
            required: ['events'],
          },
        },
        {
          name: 'get_editor_log',
          description:
            'Read the Godot editor log/output: output captured from an editor launched via launch_editor, the .godot/mcp_editor.log file, or any other recent log files found in the project or Godot data directories.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Godot project directory (used to locate log files)' },
              maxLines: { type: 'number', description: 'Maximum lines to return, from the end (default 200)' },
            },
            required: [],
          },
        },
        {
          name: 'run_headless',
          description:
            'Run the project (or a specific scene/script) with --headless and return its full output and exit code. Ideal for CI-style checks that do not need rendering.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scene: { type: 'string', description: 'Optional scene to run (relative to project)' },
              script: { type: 'string', description: 'Optional SceneTree/MainLoop script to run (e.g. "tools/export.gd")' },
              extraArgs: { type: 'array', items: { type: 'string' }, description: 'Extra CLI args passed to Godot' },
              timeoutSeconds: { type: 'number', description: 'Kill the run after this long (default 30)' },
              quitAfter: { type: 'number', description: 'Quit automatically after N frames (safety for game scenes)' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_tests',
          description:
            'Run the project test suite headlessly. Auto-detects GUT (addons/gut) or gdUnit4 (addons/gdUnit4); GUT runs write a JUnit XML report to .godot/mcp_reports/. Reports which framework is missing (with install links) when neither is present.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              dir: { type: 'string', description: 'Restrict the run to a test directory ("res://test" style). GUT: -gdir. gdUnit4: -a.' },
              filter: { type: 'string', description: 'GUT only: select one test script by name (-gselect)' },
              junitXml: { type: 'boolean', description: 'GUT: write .godot/mcp_reports/last-gut-junit.xml (default true)' },
              extraArgs: { type: 'array', items: { type: 'string' }, description: 'Extra args passed through to the test runner' },
              timeoutSeconds: { type: 'number', description: 'Kill the run after this long (default 120)' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_project_setting',
          description:
            'Read a setting from project.godot. Use setting "section/key" (e.g. "application/run/main_scene"); omit setting to dump the whole file.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              setting: { type: 'string', description: 'Setting path like "application/run/main_scene" (section/key)' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'set_project_setting',
          description:
            'Write a setting in project.godot (preserves the rest of the file, including comments). setting is "section/key" (e.g. "application/run/main_scene"). Strings are auto-quoted unless they look like serialized Godot values; set rawValue to write the value verbatim.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              setting: { type: 'string', description: 'Setting path like "application/run/main_scene" (section/key)' },
              value: { description: 'New value (string, number, boolean, array, or object)' },
              rawValue: { type: 'boolean', description: 'Write the value verbatim without quoting (default false)' },
            },
            required: ['projectPath', 'setting', 'value'],
          },
        },
        {
          name: 'add_input_action',
          description:
            'Register an InputMap action in project.godot with key/mouse bindings, e.g. action "jump" with events ["space", {"mouse":"left"}]. Key names: letters, digits, "space", "enter", arrows, "f1"-"f12", "shift", "ctrl", "alt".',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              action: { type: 'string', description: 'Action name (e.g. "jump", "move_left")' },
              events: {
                type: 'array',
                items: {},
                description: 'Bindings: ["w", "space"] or [{"mouse":"left"}, {"key":"shift"}]',
              },
              deadzone: { type: 'number', description: 'Deadzone for the action (default 0.5)' },
            },
            required: ['projectPath', 'action', 'events'],
          },
        },
        {
          name: 'read_resource',
          description:
            'Read a resource or project file: returns text content for text formats (.tres, .tscn, .gd, .csv, .gdshader, ...) and a class/property dump for binary resources (.res, images, audio).',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              path: { type: 'string', description: 'File path relative to the project' },
            },
            required: ['projectPath', 'path'],
          },
        },
        {
          name: 'write_resource',
          description:
            'Create a resource file: either raw text content (for .tres/.tscn), or a structured resource built from a class name and properties (e.g. resourceClass "Gradient" with {"offsets": ..., "colors": ...}) saved via ResourceSaver.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              path: { type: 'string', description: 'File path relative to the project (e.g. "resources/palette.tres")' },
              content: { type: 'string', description: 'Raw file contents (for text-based resources)' },
              resourceClass: { type: 'string', description: 'Resource class name (e.g. "Gradient", "Curve2D") when building structurally' },
              properties: { type: 'object', description: 'Properties to set on the resource (when using resourceClass)' },
              overwrite: { type: 'boolean', description: 'Allow replacing an existing file (default true)' },
            },
            required: ['projectPath', 'path'],
          },
        },
        {
          name: 'search_project',
          description:
            'Search the project by filename and by content (line matches with context). Defaults to case-insensitive literal matching; set regex for regular expressions.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              query: { type: 'string', description: 'Text or regex to search for' },
              regex: { type: 'boolean', description: 'Treat query as a regular expression (default false)' },
              extensions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Restrict content search to extensions, e.g. ["gd", "tscn"]',
              },
              maxResults: { type: 'number', description: 'Maximum results (default 50)' },
            },
            required: ['projectPath', 'query'],
          },
        },
        {
          name: 'describe_class',
          description:
            'Introspect an engine class: properties (type + default), methods (signature + flags), signals, and the inheritance chain. Use this before setting properties or connecting signals so you never guess names.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Optional: pass a project so script classes registered via class_name resolve too' },
              className: { type: 'string', description: 'Class to describe, e.g. "CharacterBody2D"' },
              filter: { type: 'string', description: 'Only include members whose name contains this (case-insensitive) — use for huge classes like Control' },
              includeProperties: { type: 'boolean', description: 'Include properties (default true)' },
              includeMethods: { type: 'boolean', description: 'Include methods (default true)' },
              includeSignals: { type: 'boolean', description: 'Include signals (default true)' },
            },
            required: ['className'],
          },
        },
        {
          name: 'connect_signal',
          description:
            'Connect a node signal to a method on another node in the same scene and persist the connection into the .tscn file. Validates the signal exists, the target node exists, and that the target script defines the method.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, e.g. "Main.tscn"' },
              nodePath: { type: 'string', description: 'Source node that emits the signal (default "root")' },
              signal: { type: 'string', description: 'Signal name, e.g. "body_entered"' },
              targetPath: { type: 'string', description: 'Node that receives the signal' },
              method: { type: 'string', description: 'Method on the target node, e.g. "_on_body_entered"' },
            },
            required: ['projectPath', 'scenePath', 'signal', 'targetPath', 'method'],
          },
        },
        {
          name: 'disconnect_signal',
          description: 'Remove a signal connection from a scene. Idempotent: disconnecting an absent connection succeeds with disconnected: false.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, e.g. "Main.tscn"' },
              nodePath: { type: 'string', description: 'Source node (default "root")' },
              signal: { type: 'string', description: 'Signal name' },
              targetPath: { type: 'string', description: 'Target node' },
              method: { type: 'string', description: 'Method on the target node' },
            },
            required: ['projectPath', 'scenePath', 'signal', 'targetPath', 'method'],
          },
        },
        {
          name: 'add_autoload',
          description:
            'Add or replace a global autoload singleton (project.godot [application] autoload/* entry) while preserving every other setting and comment.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              name: { type: 'string', description: 'Autoload name (identifier), e.g. "GameState"' },
              path: { type: 'string', description: 'res:// path to a script or scene, e.g. "res://scripts/game_state.gd"' },
              singleton: { type: 'boolean', description: 'Register as singleton (*) so the name resolves to the instance (default true)' },
            },
            required: ['projectPath', 'name', 'path'],
          },
        },
        {
          name: 'remove_autoload',
          description: 'Remove an autoload singleton from project.godot. Succeeds with removed: false when the autoload does not exist.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              name: { type: 'string', description: 'Autoload name to remove' },
            },
            required: ['projectPath', 'name'],
          },
        },
        {
          name: 'list_autoloads',
          description: 'List every autoload singleton defined in project.godot, with name, path, and singleton flag.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'analyze_project',
          description:
            'Project linter: main-scene sanity, script compile failures, scene load failures, orphan nodes (changes not saved), never-referenced scripts, and unused resources — with counts. Read as a report before declaring work finished.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'export_project',
          description:
            'Headless export of the project against export_presets.cfg (Godot 4.x). Returns the output path and byte size; refuses to overwrite an existing file unless overwrite is set.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              output: { type: 'string', description: 'Output file path (absolute, or res:// relative), e.g. "build/game.x86_64"' },
              preset: { type: 'string', description: 'Export preset name (from list_export_presets). Optional when the project has exactly one preset.' },
              mode: { type: 'string', enum: ['release', 'debug'], description: 'export-release (default) or export-debug' },
              overwrite: { type: 'boolean', description: 'Replace an existing output file (default false)' },
            },
            required: ['projectPath', 'output'],
          },
        },
        {
          name: 'list_export_presets',
          description: 'List export presets from export_presets.cfg (name, platform, export_filter, saved export_path). Use before export_project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'doctor',
          description:
            'Self-diagnosis of the whole MCP pipeline: Godot binary and version, operations bridge script, project validity, main scene, filesystem write access, input-bridge port. Call this first when something else is not working.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Optional: project to diagnose alongside the server' },
            },
          },
        },
        {
          name: 'install_editor_bridge',
          description:
            'Install the MCP editor bridge addon into a project (addons/mcp_editor_bridge) and enable it in project.godot, preserving all other settings. The editor must be (re)started to activate it; editor_status reports when it is online.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'uninstall_editor_bridge',
          description: 'Disable and remove the MCP editor bridge addon from a project (files + project.godot entry).',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'editor_status',
          description:
            'Report whether the editor bridge plugin is reachable and what the editor is doing: open scenes, edited scene, selected nodes, versions. connected:false with no editor running is normal, not an error.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'editor_screenshot',
          description: 'Capture the editor window (full editor UI, not the game) to a PNG through the editor bridge plugin.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              outputPath: { type: 'string', description: 'Absolute path for the PNG' },
            },
            required: ['projectPath', 'outputPath'],
          },
        },
      ];
      // Attach MCP annotations (read-only / destructive / idempotent / open-world hints)
      for (const tool of tools) {
        const annotations = TOOL_ANNOTATIONS[tool.name];
        if (annotations) (tool as any).annotations = annotations;
      }
      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      const toolName = request.params.name;
      const toolArgs = request.params.arguments;
      const projectPath = String((toolArgs && (toolArgs.projectPath || toolArgs.project_path)) || '');
      // Mutations serialize per project so parallel tool calls cannot race on
      // the same scene or config file
      if (this.mutatingTools.has(toolName)) {
        return await this.withProjectLock(projectPath, () => this.dispatchTool(toolName, toolArgs));
      }
      return await this.dispatchTool(toolName, toolArgs);
    });
  }

  /** Route a tool call to its handler (split out so mutations can be locked) */
  private async dispatchTool(name: string, args: any): Promise<any> {
    // Prefer the open editor for scene mutations when it has our target scene
    // open (UndoRedo history + editor save). Any doubt falls back to the file path.
    if (this.editorRoutedTools.has(name)) {
      const via = await this.tryEditorRoute(name, args);
      if (via) return via;
    }
    switch (name) {
        case 'launch_editor':
          return await this.handleLaunchEditor(args);
        case 'run_project':
          return await this.handleRunProject(args);
        case 'get_debug_output':
          return await this.handleGetDebugOutput();
        case 'stop_project':
          return await this.handleStopProject();
        case 'get_godot_version':
          return await this.handleGetGodotVersion();
        case 'list_projects':
          return await this.handleListProjects(args);
        case 'get_project_info':
          return await this.handleGetProjectInfo(args);
        case 'create_scene':
          return await this.handleCreateScene(args);
        case 'add_node':
          return await this.handleAddNode(args);
        case 'load_sprite':
          return await this.handleLoadSprite(args);
        case 'export_mesh_library':
          return await this.handleExportMeshLibrary(args);
        case 'save_scene':
          return await this.handleSaveScene(args);
        case 'get_uid':
          return await this.handleGetUid(args);        case 'update_project_uids':
          return await this.handleUpdateProjectUids(args);
        case 'read_scene':
          return await this.handleReadScene(args);
        case 'create_script':
          return await this.handleCreateScript(args);
        case 'edit_script':
          return await this.handleEditScript(args);
        case 'attach_script':
          return await this.handleAttachScript(args);
        case 'validate_project':
          return await this.handleValidateProject(args);
        case 'set_node_property':
          return await this.handleSetNodeProperty(args);
        case 'delete_node':
          return await this.handleDeleteNode(args);
        case 'move_node':
          return await this.handleMoveNode(args);
        case 'duplicate_node':
          return await this.handleDuplicateNode(args);
        case 'instantiate_scene':
          return await this.handleInstantiateScene(args);
        case 'screenshot':
          return await this.handleScreenshot(args);
        case 'send_input':
          return await this.handleSendInput(args);
        case 'get_editor_log':
          return await this.handleGetEditorLog(args);
        case 'run_headless':
          return await this.handleRunHeadless(args);
        case 'run_tests':
          return await this.handleRunTests(args);
        case 'get_project_setting':
          return await this.handleGetProjectSetting(args);
        case 'set_project_setting':
          return await this.handleSetProjectSetting(args);
        case 'add_input_action':
          return await this.handleAddInputAction(args);
        case 'read_resource':
          return await this.handleReadResource(args);
        case 'write_resource':
          return await this.handleWriteResource(args);
        case 'search_project':
          return await this.handleSearchProject(args);
        case 'edit_scene':
          return await this.handleEditScene(args);
        case 'describe_class':
          return await this.handleDescribeClass(args);
        case 'connect_signal':
          return await this.handleConnectSignal(args);
        case 'disconnect_signal':
          return await this.handleDisconnectSignal(args);
        case 'add_autoload':
          return await this.handleAddAutoload(args);
        case 'remove_autoload':
          return await this.handleRemoveAutoload(args);
        case 'list_autoloads':
          return await this.handleListAutoloads(args);
        case 'analyze_project':
          return await this.handleAnalyzeProject(args);
        case 'export_project':
          return await this.handleExportProject(args);
        case 'list_export_presets':
          return await this.handleListExportPresets(args);
        case 'doctor':
          return await this.handleDoctor(args);
        case 'install_editor_bridge':
          return await this.handleInstallEditorBridge(args);
        case 'uninstall_editor_bridge':
          return await this.handleUninstallEditorBridge(args);
        case 'editor_status':
          return await this.handleEditorStatus(args);
        case 'editor_screenshot':
          return await this.handleEditorScreenshot(args);

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
    }
  }

  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);

      // Persist editor output to a log file so get_editor_log can read it later
      const logDir = join(args.projectPath, '.godot');
      const editorLogFile = join(logDir, 'mcp_editor.log');
      try {
        if (!existsSync(logDir)) {
          mkdirSync(logDir, { recursive: true });
        }
      } catch (error) {
        this.logDebug(`Could not prepare editor log dir: ${error}`);
      }

      const process = spawn(this.godotPath, ['-e', '--path', args.projectPath, '--log-file', editorLogFile], {
        stdio: 'pipe',
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot editor:', err);
      });

      const captureLine = (line: string) => {
        if (!line.trim()) return;
        this.editorOutput.push(line);
        if (this.editorOutput.length > 1000) this.editorOutput.splice(0, this.editorOutput.length - 1000);
      };
      process.stdout?.on('data', (data: Buffer) => {
        data.toString().split('\n').forEach(captureLine);
      });
      process.stderr?.on('data', (data: Buffer) => {
        data.toString().split('\n').forEach(captureLine);
      });
      this.editorProcess = process;

      return {
        content: [
          {
            type: 'text',
            text: `Godot editor launched successfully for project at ${args.projectPath}. Editor output is logged to ${editorLogFile} and available via get_editor_log.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to launch Godot editor: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the run_project tool
   * @param args Tool arguments
   */
  private async handleRunProject(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Kill any existing process
      if (this.activeProcess) {
        this.logDebug('Killing existing Godot process before starting a new one');
        this.activeProcess.process.kill();
      }

      const cmdArgs = ['-d', '--path', args.projectPath];
      const useBridge = args.withInputBridge === true;
      let targetSceneRes = '';
      if (args.scene && this.validatePath(args.scene)) {
        this.logDebug(`Adding scene parameter: ${args.scene}`);
        targetSceneRes = args.scene.startsWith('res://') ? args.scene : `res://${args.scene}`;
        // With the bridge enabled the scene is passed via MCP_TARGET_SCENE instead,
        // because the bridge wrapper must be the scene Godot launches.
        if (!useBridge) {
          cmdArgs.push(args.scene);
        }
      }

      const env: NodeJS.ProcessEnv = { ...globalThis.process.env };
      if (useBridge) {
        // Fresh temporary bridge files (cleaned up by stop_project)
        this.cleanupBridgeFiles();
        const bridgeGd = join(args.projectPath, 'godot_mcp_bridge.gd');
        const bridgeTscn = join(args.projectPath, 'godot_mcp_bridge.tscn');
        writeFileSync(bridgeGd, BRIDGE_SCRIPT, 'utf8');
        writeFileSync(bridgeTscn, BRIDGE_SCENE, 'utf8');
        this.bridgeFiles = [bridgeGd, bridgeTscn];
        cmdArgs.push('godot_mcp_bridge.tscn');
        env['MCP_TARGET_SCENE'] = targetSceneRes;
        env['MCP_BRIDGE_PORT'] = String(BRIDGE_PORT);
        this.bridgeToken = randomBytes(16).toString('hex');
        env['MCP_BRIDGE_TOKEN'] = this.bridgeToken;
        this.logDebug(`Input bridge enabled (port ${BRIDGE_PORT}, target scene: '${targetSceneRes}')`);
      }

      this.logDebug(`Running Godot project: ${args.projectPath}`);
      const process = spawn(this.godotPath!, cmdArgs, { stdio: 'pipe', env });
      const output: string[] = [];
      const errors: string[] = [];

      process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        output.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
        });
      });

      process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        errors.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stderr] ${line}`);
        });
      });

      process.on('exit', (code: number | null) => {
        this.logDebug(`Godot process exited with code ${code}`);
        // Capture unconditionally: stop_project nulls activeProcess *before*
        // this event fires, and the closure arrays are the freshest output either way.
        this.lastRunExit = {
          code,
          output: [...output].filter((l: string) => l.trim()).slice(-300),
          errors: [...errors].filter((l: string) => l.trim()).slice(-100),
        };
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
          // The game may quit itself (e.g. a bridge "quit" event); still clean up
          this.cleanupBridgeFiles();
        }
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
          this.cleanupBridgeFiles();
        }
      });

      this.lastRunExit = null;
      this.activeProcess = { process, output, errors };

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use get_debug_output to see output.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to run Godot project: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput() {
    const active = this.activeProcess;
    const last = this.lastRunExit;
    if (!active && !last) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                running: false,
                exitCode: null,
                output: [],
                errors: [],
                hint: 'run_project has not been started in this server session yet',
              },
              null,
              2
            ),
          },
        ],
      };
    }
    // While running: live output. After exit: the final output and exit code
    // instead of an error, so callers can tell "finished" from "never started".
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              running: Boolean(active),
              exitCode: active ? null : (last ? last.code : null),
              output: active ? active.output : (last ? last.output : []),
              errors: active ? active.errors : (last ? last.errors : []),
              ...(active ? {} : { hint: 'The game process has exited; showing its final output' }),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the stop_project tool
   */
  private async handleStopProject() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process to stop.',
        [
          'Use run_project to start a Godot project first',
          'The process may have already terminated',
        ]
      );
    }

    this.logDebug('Stopping active Godot process');
    this.activeProcess.process.kill();
    const output = this.activeProcess.output;
    const errors = this.activeProcess.errors;
    // Synchronously preserve final output; the process 'exit' event updates
    // this again (with its exit code) once the kernel reports it.
    this.lastRunExit = {
      code: null,
      output: [...output].filter((l: string) => l.trim()).slice(-300),
      errors: [...errors].filter((l: string) => l.trim()).slice(-100),
    };
    this.activeProcess = null;
    this.cleanupBridgeFiles();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Godot project stopped',
              finalOutput: output,
              finalErrors: errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      this.logDebug('Getting Godot version');
      const { stdout } = await execFileAsync(this.godotPath!, ['--version']);
      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to get Godot version: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
        ]
      );
    }
  }

  /**
   * Handle the list_projects tool
   */
  private async handleListProjects(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.directory) {
      return this.createErrorResponse(
        'Directory is required',
        ['Provide a valid directory path to search for Godot projects']
      );
    }

    if (!this.validatePath(args.directory)) {
      return this.createErrorResponse(
        'Invalid directory path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return this.createErrorResponse(
          `Directory does not exist: ${args.directory}`,
          ['Provide a valid directory path that exists on the system']
        );
      }

      const recursive = args.recursive === true;
      const projects = this.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list projects: ${error?.message || 'Unknown error'}`,
        [
          'Ensure the directory exists and is accessible',
          'Check if you have permission to read the directory',
        ]
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(projectPath: string): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });
          
          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);
            
            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            
            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();
              
              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };
        
        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({ 
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */
  private async handleGetProjectInfo(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }
  
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }
  
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }
  
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }
  
      this.logDebug(`Getting project info for: ${args.projectPath}`);
  
      // Get Godot version
      const execOptions = { timeout: 10000 }; // 10 second timeout
      const { stdout } = await execFileAsync(this.godotPath!, ['--version'], execOptions);
  
      // Get project structure using the recursive method
      const projectStructure = await this.getProjectStructureAsync(args.projectPath);
  
      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const fs = require('fs');
        const projectFileContent = fs.readFileSync(projectFile, 'utf8');
        const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
        if (configNameMatch && configNameMatch[1]) {
          projectName = configNameMatch[1];
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }
  
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: stdout.trim(),
                structure: projectStructure,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get project info: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the create_scene tool
   */
  private async handleCreateScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Project path and scene path are required',
        ['Provide valid paths for both the project and the scene']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    const rootNodeType = args.rootNodeType || 'Node2D';
    if (!this.validateClassName(rootNodeType)) {
      return this.createErrorResponse(
        'Invalid rootNodeType',
        ['rootNodeType must be a built-in Godot class name (no paths, no file extensions)']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to create scene: ${stderr}`,
          [
            'Check if the root node type is valid',
            'Ensure you have write permissions to the scene path',
            'Verify the scene path is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the add_node tool
   */
  private async handleAddNode(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodeType, and nodeName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    if (!this.validateClassName(args.nodeType)) {
      return this.createErrorResponse(
        'Invalid nodeType',
        ['nodeType must be a built-in Godot class name (no paths, no file extensions)']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to add node: ${stderr}`,
          [
            'Check if the node type is valid',
            'Ensure the parent node path exists',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to add node: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */
  private async handleLoadSprite(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and texturePath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.texturePath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Check if the texture file exists
      const texturePath = join(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return this.createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`,
          [
            'Ensure the texture path is correct',
            'Upload or create the texture file first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to load sprite: ${stderr}`,
          [
            'Check if the node path is correct',
            'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
            'Verify the texture file is a valid image format',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to load sprite: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the export_mesh_library tool
   */
  private async handleExportMeshLibrary(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, and outputPath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.outputPath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
        params.meshItemNames = args.meshItemNames;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('export_mesh_library', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to export mesh library: ${stderr}`,
          [
            'Check if the scene contains valid 3D meshes',
            'Ensure the output path is valid',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to export mesh library: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the save_scene tool
   */
  private async handleSaveScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !this.validatePath(args.newPath)) {
      return this.createErrorResponse(
        'Invalid new path',
        ['Provide a valid new path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to save scene: ${stderr}`,
          [
            'Check if the scene file is valid',
            'Ensure you have write permissions to the output path',
            'Verify the scene can be properly packed',
          ]
        );
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.filePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and filePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.filePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the file exists
      const filePath = join(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return this.createErrorResponse(
          `File does not exist: ${args.filePath}`,
          ['Ensure the file path is correct']
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to get UID: ${stderr}`,
          [
            'Check if the file is a valid Godot resource',
            'Ensure the file path is correct',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get UID: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        projectPath: args.projectPath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to update project UIDs: ${stderr}`,
          [
            'Check if the project is valid',
            'Ensure you have write permissions to the project directory',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  // ================================================================
  // Shared helpers for the extended tool set
  // ================================================================

  /** Validate that projectPath points at a Godot project; returns an error response or null */
  private requireProject(projectPath: any): any | null {
    if (!projectPath) {
      return this.createErrorResponse('Project path is required', ['Provide a valid path to a Godot project directory']);
    }
    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', ['Provide a valid path without ".." or other potentially unsafe characters']);
    }
    if (!existsSync(join(projectPath, 'project.godot'))) {
      return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
        'Ensure the path points to a directory containing a project.godot file',
        'Use list_projects to find valid Godot projects',
      ]);
    }
    return null;
  }

  /** Run Godot with explicit args, capturing output even when the process exits non-zero or is killed */
  private async runGodot(
    args: string[],
    timeoutMs = 60000
  ): Promise<{ stdout: string; stderr: string; killed: boolean; exitCode: number | null }> {
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }
    try {
      const { stdout, stderr } = await execFileAsync(this.godotPath!, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout: stdout ?? '', stderr: stderr ?? '', killed: false, exitCode: 0 };
    } catch (error: any) {
      if (error && typeof error === 'object' && 'stdout' in error) {
        return {
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? '',
          killed: Boolean(error.killed),
          exitCode: typeof error.code === 'number' ? error.code : null,
        };
      }
      throw error;
    }
  }

  /** Extract the MCP_JSON marker line an operation printed */
  private extractMcpJson(stdout: string): any | null {
    const lines = stdout.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('MCP_JSON:')) {
        try {
          return JSON.parse(lines[i].slice('MCP_JSON:'.length));
        } catch (e) {
          return null;
        }
      }
    }
    return null;
  }

  /** Execute an operation in godot_operations.gd and return its parsed JSON */
  private async runOperationJson(
    operation: string,
    params: OperationParams,
    projectPath: string,
    opts: { headless?: boolean; timeoutMs?: number; extraArgs?: string[]; noPath?: boolean } = {}
  ): Promise<{ json: any; stdout: string; stderr: string }> {
    const snakeCaseParams = this.convertCamelToSnakeCase(params);
    const args: string[] = [];
    if (opts.headless !== false) {
      args.push('--headless');
    }
    if (opts.noPath !== true && projectPath) {
      args.push('--path', projectPath);
    }
    args.push(
      '--script',
      this.operationsScriptPath,
      operation,
      JSON.stringify(snakeCaseParams),
      '--debug-godot'
    );
    if (opts.extraArgs) {
      args.push(...opts.extraArgs);
    }
    const { stdout, stderr } = await this.runGodot(args, opts.timeoutMs ?? 60000);
    return { json: this.extractMcpJson(stdout), stdout, stderr };
  }

  /** Build an error response for a failed operation, including the useful tail of stderr */
  private operationFailed(operation: string, json: any, stderr: string, solutions: string[]): any {
    const tail = stderr
      .trim()
      .split('\n')
      .slice(-15)
      .join('\n');
    let text = `Operation ${operation} did not complete.`;
    if (tail) text += `\n\n${tail}`;
    if (json) text += `\n\n${JSON.stringify(json, null, 2)}`;
    return this.createErrorResponse(text, solutions);
  }

  /** Walk the project and return file paths relative to it, using forward slashes */
  private walkProjectFiles(projectPath: string, skipDirs: string[] = ['.godot', '.git', 'node_modules']): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!skipDirs.includes(entry.name)) walk(full);
        } else if (entry.isFile()) {
          out.push(full.slice(projectPath.length + 1).split('\\').join('/'));
        }
      }
    };
    walk(projectPath);
    return out;
  }

  private tailLines(content: string, maxLines: number): string[] {
    const lines = content.split('\n');
    if (lines.length <= maxLines) return lines;
    return lines.slice(lines.length - maxLines);
  }

  private cleanupBridgeFiles(): void {
    for (const file of this.bridgeFiles) {
      try {
        if (existsSync(file)) unlinkSync(file);
        this.logDebug(`Removed bridge file: ${file}`);
      } catch (e) {
        this.logDebug(`Could not remove bridge file ${file}: ${e}`);
      }
    }
    this.bridgeFiles = [];
    this.bridgeToken = null;
  }

  /** Parse-check one GDScript file with --check-only and return line-accurate errors */
  private async checkScriptFile(projectPath: string, relativePath: string): Promise<{ file: string; ok: boolean; errors: any[] }> {
    const resPath = 'res://' + relativePath;
    const { stdout, stderr } = await this.runGodot(
      ['--headless', '--path', projectPath, '--check-only', '--script', resPath],
      30000
    );
    const lines = (stdout + '\n' + stderr).split('\n');
    const errors: any[] = [];
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^\s*SCRIPT ERROR:\s*(.*)$/);
      if (!match) continue;
      const entry: any = { message: match[1].trim() };
      const window = `${lines[i] || ''} ${lines[i + 1] || ''}`;
      const location = window.match(/\((res:\/\/[^)]+?):(\d+)\)/);
      if (location) {
        entry.file = location[1];
        entry.line = parseInt(location[2], 10);
      } else {
        entry.file = resPath;
      }
      errors.push(entry);
    }
    return { file: relativePath, ok: errors.length === 0, errors };
  }

  private findLogFiles(root: string, maxDepth = 3): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', '.git'].includes(entry.name)) walk(full, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.log')) {
          out.push(full);
        }
      }
    };
    walk(root, 0);
    return out;
  }

  /** Split "section/key" on the first slash (keys themselves may contain slashes) */
  private splitSettingPath(setting: string): { section: string; key: string } {
    const slash = setting.indexOf('/');
    if (slash === -1) return { section: '', key: setting };
    return { section: setting.slice(0, slash), key: setting.slice(slash + 1) };
  }

  private parseIniFile(content: string): {
    lines: string[];
    sections: { name: string; start: number; entries: { key: string; value: string; line: number }[] }[];
  } {
    const lines = content.split('\n');
    const sections: { name: string; start: number; entries: { key: string; value: string; line: number }[] }[] = [
      { name: '', start: -1, entries: [] },
    ];
    let current = sections[0];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const header = trimmed.match(/^\[(.+)\]$/);
      if (header) {
        current = { name: header[1], start: i, entries: [] };
        sections.push(current);
        continue;
      }
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        current.entries.push({ key: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim(), line: i });
      }
    }
    return { lines, sections };
  }

  private serializeIniValue(value: any, raw: boolean): string {
    if (raw) return String(value);
    if (typeof value === 'string') {
      // Serialized Godot expressions pass through raw; plain strings get quoted
      // (res:// and uid:// paths ARE quoted in project.godot).
      const looksSerialized = /^(Object\(|Packed[A-Za-z0-9_]*\(|@|\[|\{)/.test(value);
      if (looksSerialized) return value;
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  }

  /**
   * Net brace/bracket delta of a line, ignoring quoted strings
   */
  private braceDelta(text: string): number {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
    return depth;
  }

  /**
   * Insert or replace a key in project.godot lines, handling multi-line values
   * (Godot writes input actions as several lines) while preserving everything else.
   */
  private upsertIniValue(
    lines: string[],
    sections: { name: string; start: number; entries: { key: string; value: string; line: number }[] }[],
    section: string,
    key: string,
    serialized: string
  ): void {
    const newLines = serialized.split('\n').map((line, i) => (i === 0 ? `${key}=${line}` : line));
    const target = sections.find((s) => s.name === section);
    if (!target) {
      if (section === '') {
        lines.push(...newLines);
      } else {
        lines.push('', `[${section}]`, ...newLines);
      }
      return;
    }
    const entry = target.entries.find((e) => e.key === key);
    if (!entry) {
      lines.splice(target.start + 1, 0, ...newLines);
      return;
    }
    let end = entry.line;
    let depth = this.braceDelta(lines[entry.line]);
    while (depth > 0 && end + 1 < lines.length) {
      end++;
      depth += this.braceDelta(lines[end]);
    }
    lines.splice(entry.line, end - entry.line + 1, ...newLines);
  }

  /** Send one JSON command to the in-game bridge and await its ack */
  private sendBridgeCommand(socket: net.Socket, command: any, timeoutMs = 8000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const payload = { ...command, id, token: this.bridgeToken || '' };
      const timer = setTimeout(() => {
        socket.off('data', onData);
        reject(new Error(`Timed out waiting for the game to answer: ${command?.type || 'command'}`));
      }, timeoutMs);
      const onData = (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (message.id !== id) continue;
            clearTimeout(timer);
            socket.off('data', onData);
            // Both accepted and rejected commands resolve: the caller reports
            // per-event outcomes so one bad event does not abort the sequence.
            resolve(message);
            return;
          } catch (e) {
            // partial line or unrelated message; ignore
          }
        }
      };
      socket.on('data', onData);
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  }

  // ================================================================
  // Extended tool handlers
  // ================================================================

  /** read_scene */
  private async handleReadScene(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.scenePath) {
      return this.createErrorResponse('Scene path is required', ['Provide scenePath relative to the project, e.g. "Main.tscn"']);
    }
    if (!this.validatePath(args.scenePath)) {
      return this.createErrorResponse('Invalid scene path', ['Provide a path without ".." or other potentially unsafe characters']);
    }
    if (!existsSync(join(args.projectPath, args.scenePath))) {
      return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
        'Check the scene path',
        'Use search_project to locate scene files',
      ]);
    }
    try {
      const { json, stderr } = await this.runOperationJson(
        'read_scene',
        {
          scenePath: args.scenePath,
          maxDepth: args.maxDepth ?? 8,
          includeProperties: args.includeProperties !== false,
        },
        args.projectPath
      );
      if (!json) return this.operationFailed('read_scene', json, stderr, ['Verify the scene file is a valid .tscn', 'Check the scene loads in the Godot editor']);
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to read scene: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly', 'Verify the project path is accessible']);
    }
  }

  /** create_script */
  private async handleCreateScript(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.scriptPath) {
      return this.createErrorResponse('Script path is required', ['Provide scriptPath relative to the project, e.g. "scripts/player.gd"']);
    }
    if (!this.validatePath(args.scriptPath)) {
      return this.createErrorResponse('Invalid script path', ['Provide a path without ".." or other potentially unsafe characters']);
    }
    const absolutePath = join(args.projectPath, args.scriptPath);
    if (existsSync(absolutePath) && args.overwrite !== true) {
      return this.createErrorResponse(`Script already exists: ${args.scriptPath}`, [
        'Use edit_script to modify the existing file',
        'Pass overwrite: true to replace it entirely',
      ]);
    }
    try {
      let content = args.content;
      if (content === undefined || content === null) {
        const base = args.extendsType || 'Node';
        if (!this.validateClassName(base)) {
          return this.createErrorResponse('Invalid extendsType', ['extendsType must be a plain class name, e.g. "CharacterBody2D"']);
        }
        const classLine = args.className ? `class_name ${args.className}\n` : '';
        const template = args.template || 'ready';
        const header = `extends ${base}\n${classLine}`;
        switch (template) {
          case 'empty':
            content = header;
            break;
          case 'tool':
            content = `@tool\n${header}\nfunc _ready():\n    pass\n`;
            break;
          case 'process':
            content = `${header}\nfunc _ready():\n    pass\n\nfunc _process(_delta):\n    pass\n`;
            break;
          case 'ready':
          default:
            content = `${header}\nfunc _ready():\n    pass\n`;
            break;
        }
      }
      const dir = join(absolutePath, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(absolutePath, content, 'utf8');
      return {
        content: [
          {
            type: 'text',
            text: `Script written to ${args.scriptPath} (${content.split('\n').length} lines). Content:\n\n${content}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to create script: ${error?.message || 'Unknown error'}`, ['Check write permissions on the project directory']);
    }
  }

  /** edit_script */
  private async handleEditScript(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.scriptPath || !this.validatePath(args.scriptPath)) {
      return this.createErrorResponse('Valid scriptPath is required', ['Provide scriptPath relative to the project without ".."']);
    }
    const absolutePath = join(args.projectPath, args.scriptPath);
    if (!existsSync(absolutePath)) {
      return this.createErrorResponse(`Script does not exist: ${args.scriptPath}`, ['Use create_script to create it first']);
    }
    try {
      const original = readFileSync(absolutePath, 'utf8');
      let updated: string;
      let description: string;
      if (args.content !== undefined && args.content !== null) {
        updated = args.content;
        description = `Overwrote ${args.scriptPath} (${updated.split('\n').length} lines)`;
      } else if (args.oldString !== undefined && args.newString !== undefined) {
        const occurrences = original.split(args.oldString).length - 1;
        if (occurrences === 0) {
          return this.createErrorResponse(`oldString not found in ${args.scriptPath}`, [
            'Re-read the file with read_resource and copy the exact text, including whitespace',
            'Or pass content to overwrite the whole file',
          ]);
        }
        if (occurrences > 1 && args.replaceAll !== true) {
          return this.createErrorResponse(`oldString matches ${occurrences} times in ${args.scriptPath}`, [
            'Include more surrounding context so the match is unique',
            'Or pass replaceAll: true to replace every occurrence',
          ]);
        }
        updated = args.replaceAll === true ? original.split(args.oldString).join(args.newString) : original.replace(args.oldString, args.newString);
        description = `Replaced ${args.replaceAll === true ? occurrences : 1} occurrence(s) in ${args.scriptPath}`;
      } else {
        return this.createErrorResponse('Nothing to apply', ['Provide either content (full overwrite) or oldString + newString (targeted replace)']);
      }
      writeFileSync(absolutePath, updated, 'utf8');
      return { content: [{ type: 'text', text: description }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to edit script: ${error?.message || 'Unknown error'}`, ['Check write permissions on the project directory']);
    }
  }

  /** attach_script */
  private async handleAttachScript(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    for (const key of ['scenePath', 'nodePath', 'scriptPath']) {
      if (!args[key]) return this.createErrorResponse(`${key} is required`, [`Provide ${key}`]);
      if (!this.validatePath(args[key])) return this.createErrorResponse(`Invalid ${key}`, ['Provide a path without ".." or other potentially unsafe characters']);
    }
    if (!existsSync(join(args.projectPath, args.scenePath))) {
      return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, ['Check the scene path']);
    }
    if (!existsSync(join(args.projectPath, args.scriptPath))) {
      return this.createErrorResponse(`Script file does not exist: ${args.scriptPath}`, ['Use create_script to create it first']);
    }
    try {
      const { json, stderr } = await this.runOperationJson(
        'attach_script',
        { scenePath: args.scenePath, nodePath: args.nodePath, scriptPath: args.scriptPath },
        args.projectPath
      );
      if (!json) return this.operationFailed('attach_script', json, stderr, ['Check the node path exists (read_scene shows node paths)', 'Check the script parses (validate_project)']);
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to attach script: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly', 'Verify the project path is accessible']);
    }
  }

  /** edit_scene: many mutations, one Godot run, one atomic all-or-nothing save */
  private async handleEditScene(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.scenePath || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse('Valid scenePath is required', [
        'Provide scenePath relative to the project without ".."',
      ]);
    }
    if (!Array.isArray(args.operations) || args.operations.length === 0) {
      return this.createErrorResponse('operations must be a non-empty array', [
        'Example: [{"op":"add_node","parentNodePath":"root","nodeType":"Node2D","nodeName":"HUD"},{"op":"set_property","nodePath":"root/HUD","property":"z_index","value":10}]',
        'Supported ops: add_node, delete_node, move_node, set_property, duplicate_node, instantiate_scene',
      ]);
    }
    const supported = ['add_node', 'delete_node', 'move_node', 'set_property', 'duplicate_node', 'instantiate_scene'];
    for (let i = 0; i < args.operations.length; i++) {
      const op = args.operations[i];
      const where = `operations[${i}]`;
      if (!op || typeof op !== 'object') {
        return this.createErrorResponse(`${where} must be an object`, ['Each operation needs an "op" field']);
      }
      const kind = op.op || op.type;
      if (!supported.includes(kind)) {
        return this.createErrorResponse(`${where}: unknown op "${kind}"`, [
          `Supported ops: ${supported.join(', ')}`,
        ]);
      }
      if ((kind !== 'instantiate_scene' && !op.nodePath) && kind !== 'add_node') {
        if (kind !== 'add_node') {
          return this.createErrorResponse(`${where} (${kind}) requires nodePath`, ['Provide nodePath like "root/Player"']);
        }
      }
      if (kind === 'add_node') {
        if (!op.nodeType || !op.nodeName) {
          return this.createErrorResponse(`${where} (add_node) requires nodeType and nodeName`, ['Example: {"op":"add_node","nodeType":"Node2D","nodeName":"HUD"}']);
        }
        if (!this.validateClassName(op.nodeType)) {
          return this.createErrorResponse(`${where}: invalid nodeType`, ['nodeType must be a plain class name, e.g. "ColorRect"']);
        }
      }
      if (kind === 'move_node' && !op.targetParentPath) {
        return this.createErrorResponse(`${where} (move_node) requires targetParentPath`, ['Provide the destination parent path']);
      }
      if (kind === 'set_property' && !('value' in op)) {
        return this.createErrorResponse(`${where} (set_property) requires value`, ['Pass value (use null to clear)']);
      }
      if (kind === 'instantiate_scene') {
        if (!op.sourceScenePath) {
          return this.createErrorResponse(`${where} (instantiate_scene) requires sourceScenePath`, ['Provide the scene to instance']);
        }
        if (!this.validatePath(op.sourceScenePath)) {
          return this.createErrorResponse(`${where}: invalid sourceScenePath`, ['Provide a path without ".."']);
        }
        if (!existsSync(join(args.projectPath, op.sourceScenePath))) {
          return this.createErrorResponse(`${where}: source scene does not exist: ${op.sourceScenePath}`, ['Check the path with search_project']);
        }
      }
    }
    if (!existsSync(join(args.projectPath, args.scenePath))) {
      return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, ['Check the scene path']);
    }
    try {
      const { json, stderr } = await this.runOperationJson(
        'edit_scene',
        { scenePath: args.scenePath, operations: args.operations },
        args.projectPath,
        { timeoutMs: 120000 }
      );
      if (!json) {
        return this.operationFailed('edit_scene', json, stderr, [
          'The batch is all-or-nothing: fix the reported operation and retry',
          'Use read_scene to see current node paths',
        ]);
      }
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to edit scene: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  /** validate_project */
  private async handleValidateProject(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    const target = args.target || 'all';
    if (!['all', 'scripts', 'scenes'].includes(target)) {
      return this.createErrorResponse('Invalid target', ['target must be "all", "scripts", or "scenes"']);
    }
    try {
      const report: any = { ok: true, scripts: null, scenes: null };

      if (target === 'all' || target === 'scripts') {
        if (args.file && !this.validatePath(args.file)) {
          return this.createErrorResponse('Invalid file', ['Provide a path without ".."']);
        }
        // Single Godot run parses every script; details land on stderr with file:line
        const opParams: any = {};
        if (args.file) opParams.file = args.file;
        const { json, stderr } = await this.runOperationJson('validate_scripts', opParams, args.projectPath, {
          timeoutMs: 180000,
        });
        if (!json) {
          return this.operationFailed('validate_scripts', json, stderr, [
            'Check that Godot can open the project at all',
            'Try target: "scenes" to validate scenes only',
          ]);
        }
        const errorsByFile: Record<string, any[]> = {};
        const errLines = stderr.split('\n');
        for (let i = 0; i < errLines.length; i++) {
          const match = errLines[i].match(/^\s*SCRIPT ERROR:\s*(.*)$/);
          if (!match) continue;
          const locationWindow = `${errLines[i] || ''} ${errLines[i + 1] || ''}`;
          const location = locationWindow.match(/\((res:\/\/[^)]+?):(\d+)\)/);
          const entry: any = { message: match[1].trim() };
          if (location) {
            entry.file = location[1];
            entry.line = parseInt(location[2], 10);
          }
          const key = entry.file || '__unknown__';
          (errorsByFile[key] = errorsByFile[key] || []).push(entry);
        }
        const failedScripts = (json.scripts || []).filter((s: any) => !s.ok);
        report.scripts = {
          checked: json.total,
          failed: json.failed,
          errors: failedScripts.flatMap((s: any) => {
            const detail = (errorsByFile[s.path] || []).map((d: any) => ({ ...d, file: d.file || s.path }));
            return detail.length > 0
              ? detail
              : [{ file: s.path, message: 'Script failed to load/compile (no parser detail captured)' }];
          }),
        };
        if (json.failed > 0) report.ok = false;
      }

      if (target === 'all' || target === 'scenes') {
        const { json, stderr } = await this.runOperationJson('validate_scenes', { instantiate: true }, args.projectPath, { timeoutMs: 120000 });
        if (!json) {
          return this.operationFailed('validate_scenes', json, stderr, ['Check that Godot can open the project at all', 'Try target: "scripts" to validate scripts only']);
        }
        report.scenes = { checked: json.total, failed: json.failed, failures: (json.scenes || []).filter((s: any) => !s.ok) };
        if (json.failed > 0) report.ok = false;
      }

      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to validate project: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly', 'Check the project path']);
    }
  }

  /** set_node_property */
  private async handleSetNodeProperty(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.scenePath || !args.nodePath || !args.property) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, scenePath, nodePath, property, and value']);
    }
    if (!('value' in args)) {
      return this.createErrorResponse('Missing value', ['Provide value (use null to clear a value)']);
    }
    for (const key of ['scenePath', 'nodePath']) {
      if (!this.validatePath(args[key])) return this.createErrorResponse(`Invalid ${key}`, ['Provide a path without ".." or other potentially unsafe characters']);
    }
    if (!existsSync(join(args.projectPath, args.scenePath))) {
      return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, ['Check the scene path']);
    }
    try {
      const setPropertyParams: any = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        property: args.property,
        value: args.value,
      };
      if (args.mode) setPropertyParams.mode = args.mode;
      const { json, stderr } = await this.runOperationJson('set_node_property', setPropertyParams, args.projectPath);
      if (!json) return this.operationFailed('set_node_property', json, stderr, ['Check the node path exists (read_scene shows node paths)', 'Check the property name is valid for the node type']);
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to set property: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  private async handleDeleteNode(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.scenePath || !args.nodePath) return this.createErrorResponse('Missing required parameters', ['Provide projectPath, scenePath, and nodePath']);
    try {
      const { json, stderr } = await this.runOperationJson('delete_node', { scenePath: args.scenePath, nodePath: args.nodePath }, args.projectPath);
      if (!json) return this.operationFailed('delete_node', json, stderr, ['Check the node path exists (read_scene shows node paths)', 'The scene root cannot be deleted']);
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to delete node: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  private async handleMoveNode(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.scenePath || !args.nodePath || !args.targetParentPath) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, scenePath, nodePath, and targetParentPath']);
    }
    const params: any = { scenePath: args.scenePath, nodePath: args.nodePath, targetParentPath: args.targetParentPath };
    if (args.index !== undefined) params.index = args.index;
    try {
      const { json, stderr } = await this.runOperationJson('move_node', params, args.projectPath);
      if (!json) return this.operationFailed('move_node', json, stderr, ['Check both node paths exist (read_scene shows node paths)', 'A node cannot be moved into its own descendant']);
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to move node: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  private async handleDuplicateNode(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.scenePath || !args.nodePath) return this.createErrorResponse('Missing required parameters', ['Provide projectPath, scenePath, and nodePath']);
    const params: any = { scenePath: args.scenePath, nodePath: args.nodePath };
    if (args.newName) params.newName = args.newName;
    if (args.targetParentPath) params.targetParentPath = args.targetParentPath;
    try {
      const { json, stderr } = await this.runOperationJson('duplicate_node', params, args.projectPath);
      if (!json) return this.operationFailed('duplicate_node', json, stderr, ['Check the node path exists (read_scene shows node paths)']);
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to duplicate node: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  private async handleInstantiateScene(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.scenePath || !args.sourceScenePath) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, scenePath, and sourceScenePath']);
    }
    if (!existsSync(join(args.projectPath, args.sourceScenePath))) {
      return this.createErrorResponse(`Source scene does not exist: ${args.sourceScenePath}`, ['Check the source scene path']);
    }
    const params: any = { scenePath: args.scenePath, sourceScenePath: args.sourceScenePath };
    if (args.parentNodePath) params.parentNodePath = args.parentNodePath;
    if (args.nodeName) params.nodeName = args.nodeName;
    try {
      const { json, stderr } = await this.runOperationJson('instantiate_scene', params, args.projectPath);
      if (!json) return this.operationFailed('instantiate_scene', json, stderr, ['Check both scene paths exist', 'Check the parent node path exists']);
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to instantiate scene: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  /** screenshot */
  private async handleScreenshot(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (args.scene && !this.validatePath(args.scene)) {
      return this.createErrorResponse('Invalid scene path', ['Provide a path without ".." or other potentially unsafe characters']);
    }
    try {
      const frameDelay = Math.max(1, Number(args.frameDelay) || 20);
      const outputPath = args.outputPath
        ? args.outputPath.startsWith('/')
          ? args.outputPath
          : join(args.projectPath, args.outputPath)
        : join(args.projectPath, `screenshot_${Date.now()}.png`);
      const parentDir = join(outputPath, '..');
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

      const params: any = { outputPath, frameDelay };
      if (args.scene) params.scenePath = args.scene;

      const extraArgs: string[] = [];
      if (args.width && args.height) {
        extraArgs.push('--resolution', `${Math.round(args.width)}x${Math.round(args.height)}`);
      }
      // Safety net so a failed capture can never hang forever
      extraArgs.push('--quit-after', String(frameDelay + 900));

      const { json, stdout, stderr } = await this.runOperationJson('capture_screenshot', params, args.projectPath, {
        headless: false,
        timeoutMs: 90000,
        extraArgs,
      });
      if (json && existsSync(outputPath)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { outputPath: json.outputPath ?? outputPath, width: json.width, height: json.height, frames: json.frames },
                null,
                2
              ),
            },
          ],
        };
      }
      const tail = (stderr + '\n' + stdout).trim().split('\n').slice(-20).join('\n');
      return this.createErrorResponse(`Screenshot failed.\n\n${tail}`, [
        'Rendering needs a display: this fails over SSH or with --headless-only environments',
        'If the game is already running via run_project {withInputBridge: true}, use send_input with {"type":"capture","path":"/abs/path.png"} instead',
        'Try a higher frameDelay so the scene has time to render',
      ]);
    } catch (error: any) {
      return this.createErrorResponse(`Failed to capture screenshot: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  /** send_input */
  private async handleSendInput(args: any) {
    args = this.normalizeParameters(args || {});
    const events = args.events;
    if (!Array.isArray(events) || events.length === 0) {
      return this.createErrorResponse('events must be a non-empty array', [
        'Example: [{"type":"key","key":"space"},{"type":"wait","ms":250},{"type":"capture","path":"/tmp/game.png"}]',
      ]);
    }

    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: BRIDGE_PORT });
      let settled = false;
      const finish = (response: any) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch (e) {
          // ignore
        }
        resolve(response);
      };
      socket.setTimeout(30000);
      socket.on('timeout', () => {
        finish(this.createErrorResponse('Input bridge timed out', ['Check the game is still running', 'Restart it with run_project {withInputBridge: true}']));
      });
      socket.on('error', (err: Error) => {
        finish(
          this.createErrorResponse(`Could not reach the game input bridge: ${err.message}`, [
            'Start the game with run_project {projectPath, withInputBridge: true}',
            'send_input only works against a game this server started with withInputBridge',
            `The bridge listens on 127.0.0.1:${BRIDGE_PORT}; check it is not blocked`,
          ])
        );
      });
      socket.on('connect', async () => {
        try {
        const results: any[] = [];
        for (const event of events) {
          if (event && event.type === 'wait') {
            const ms = Math.max(0, Number(event.ms) || 0);
            await new Promise((r) => setTimeout(r, Math.min(ms, 10000)));
            results.push({ type: 'wait', ms });
            continue;
          }
          const ack = await this.sendBridgeCommand(socket, event);
          const detail: any = { type: event?.type || 'unknown', ok: ack.ok !== false };
          for (const key of ['path', 'width', 'height', 'scene', 'fps', 'key', 'action', 'chars']) {
            if (ack[key] !== undefined) detail[key] = ack[key];
          }
          if (ack.ok === false) detail.error = ack.error || 'command rejected by the bridge';
          results.push(detail);
        }
        finish({ content: [{ type: 'text', text: JSON.stringify({ sent: results.length, results }, null, 2) }] });
        } catch (error: any) {
          finish(
            this.createErrorResponse(`Failed while sending input: ${error?.message || 'Unknown error'}`, [
              'Check the event shape matches the tool description',
              'The game must still be running and reachable on the bridge port',
            ])
          );
        }
      });
    });
  }

  /** get_editor_log */
  private async handleGetEditorLog(args: any) {
    args = this.normalizeParameters(args || {});
    if (args.projectPath) {
      const projectError = this.requireProject(args.projectPath);
      if (projectError) return projectError;
    }
    const maxLines = Math.max(10, Number(args.maxLines) || 200);
    const sources: any[] = [];

    if (this.editorOutput.length > 0) {
      sources.push({ origin: 'captured output of an editor launched via launch_editor', lines: this.editorOutput.slice(-maxLines) });
    }

    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
    const roots: string[] = [];
    if (args.projectPath) {
      roots.push(join(args.projectPath, '.godot'), args.projectPath);
    }
    roots.push(join(dataHome, 'godot'), join(cacheHome, 'godot'));

    const seen = new Set<string>();
    const candidates: { path: string; mtime: number }[] = [];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const file of this.findLogFiles(root, root.endsWith('.godot') ? 2 : 4)) {
        if (seen.has(file)) continue;
        seen.add(file);
        try {
          const stat = statSync(file);
          const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
          if (ageDays > 60 || stat.size === 0) continue;
          candidates.push({ path: file, mtime: stat.mtimeMs });
        } catch (e) {
          // unreadable
        }
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);

    for (const candidate of candidates.slice(0, 5)) {
      try {
        const content = readFileSync(candidate.path, 'utf8');
        if (!content.trim()) continue;
        sources.push({
          origin: candidate.path,
          modified: new Date(candidate.mtime).toISOString(),
          lines: this.tailLines(content, maxLines),
        });
      } catch (e) {
        // skip unreadable files
      }
    }

    if (sources.length === 0) {
      return this.createErrorResponse('No editor log output found.', [
        'Launch the editor through launch_editor so its output is captured and written to <project>/.godot/mcp_editor.log',
        'Pass projectPath so log files inside the project can be located',
        'Use validate_project to surface parse errors without the editor',
      ]);
    }

    return { content: [{ type: 'text', text: JSON.stringify({ sourceCount: sources.length, sources }, null, 2) }] };
  }

  /** run_headless */
  private async handleRunHeadless(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    const cliArgs = ['--headless', '--path', args.projectPath];
    if (args.script) {
      if (!this.validatePath(args.script)) return this.createErrorResponse('Invalid script path', ['Provide a path without ".."']);
      cliArgs.push('--script', args.script.startsWith('res://') ? args.script : `res://${args.script}`);
    } else if (args.scene) {
      if (!this.validatePath(args.scene)) return this.createErrorResponse('Invalid scene path', ['Provide a path without ".."']);
      cliArgs.push(args.scene);
    }
    if (args.quitAfter !== undefined) cliArgs.push('--quit-after', String(Math.round(args.quitAfter)));
    if (Array.isArray(args.extraArgs)) cliArgs.push(...args.extraArgs.map(String));

    const timeoutSeconds = Math.max(1, Number(args.timeoutSeconds) || 30);
    try {
      const started = Date.now();
      const { stdout, stderr, killed, exitCode } = await this.runGodot(cliArgs, timeoutSeconds * 1000);
      const outLines = stdout.split('\n');
      const errLines = stderr.split('\n');
      const report = {
        command: ['godot', ...cliArgs].join(' '),
        exitCode,
        timedOut: killed,
        durationMs: Date.now() - started,
        stdoutLines: outLines.length,
        stderrLines: errLines.length,
        stdout: outLines.slice(-400),
        stderr: errLines.slice(-400),
      };
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to run headless: ${error?.message || 'Unknown error'}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
        'If the process hangs, lower timeoutSeconds or pass quitAfter',
      ]);
    }
  }

  /** run_tests */
  private async handleRunTests(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;

    const timeoutSeconds = Math.max(5, Number(args.timeoutSeconds) || 120);
    const extraArgs = Array.isArray(args.extraArgs) ? args.extraArgs.map(String) : [];
    const testDir = args.dir ? String(args.dir) : '';
    const filter = args.filter ? String(args.filter) : '';

    const gutScript = join(args.projectPath, 'addons', 'gut', 'gut_cmdln.gd');
    const gdUnitCandidates = [
      join(args.projectPath, 'addons', 'gdUnit4', 'bin', 'GdUnitCmdTool.gd'),
      join(args.projectPath, 'addons', 'gdUnit4', 'GdUnitCmdTool.gd'),
    ];
    const watDir = join(args.projectPath, 'addons', 'wat');

    let framework: 'gut' | 'gdunit4' | null = null;
    let runnerScript = '';
    if (existsSync(gutScript)) {
      framework = 'gut';
      runnerScript = gutScript;
    } else {
      const found = gdUnitCandidates.find((p) => existsSync(p));
      if (found) {
        framework = 'gdunit4';
        runnerScript = found;
      }
    }

    if (!framework) {
      const solutions = [
        'Install GUT: copy addons/gut from https://github.com/bitwes/Gut into your project, then re-run',
        'Or install gdUnit4: copy addons/gdUnit4 from https://github.com/MikeSchulze/gdUnit4 into your project',
        'No framework yet? Use run_headless with a SceneTree script of your own as a stopgap',
      ];
      if (existsSync(watDir)) solutions.unshift('WAT was detected but is not supported by run_tests; use run_headless with the WAT command line');
      return this.createErrorResponse('No supported test framework found (looked for GUT at addons/gut and gdUnit4 at addons/gdUnit4).', solutions);
    }

    const runnerRel = runnerScript.slice(args.projectPath.length + 1).split('\\').join('/');
    const cliArgs = ['--headless', '--path', args.projectPath, '-s', runnerRel];
    let junitFile: string | null = null;

    if (framework === 'gut') {
      cliArgs.push('-gexit');
      if (testDir) cliArgs.push(`-gdir=${testDir.startsWith('res://') ? testDir : 'res://' + testDir}`);
      if (filter) cliArgs.push(`-gselect=${filter}`);
      // Always leave a JUnit report CI can consume (GUT writes it itself)
      if (args.junitXml !== false) {
        const reportDir = join(args.projectPath, '.godot', 'mcp_reports');
        mkdirSync(reportDir, { recursive: true });
        junitFile = join(reportDir, 'last-gut-junit.xml');
        cliArgs.push(`-gjunit_xml_file=${junitFile}`, '-gjunit_xml_timestamp=false');
      }
    } else {
      if (testDir) cliArgs.push('-a', testDir.startsWith('res://') ? testDir : 'res://' + testDir);
      if (filter) {
        return this.createErrorResponse('filter is only supported when the project uses GUT', [
          'gdUnit4 has no test-name filter through this tool',
          'Pass dir to narrow the run to a folder instead, or drop filter',
        ]);
      }
    }
    cliArgs.push(...extraArgs);

    try {
      const started = Date.now();
      const { stdout, stderr, killed, exitCode } = await this.runGodot(cliArgs, timeoutSeconds * 1000);
      const combined = stdout + '\n' + stderr;
      const passedMatch = combined.match(/Passed:\s*(\d+)/i);
      const failedMatch = combined.match(/Failed:\s*(\d+)/i);
      const report = {
        framework: framework === 'gut' ? 'GUT' : 'gdUnit4',
        ok: !killed && exitCode === 0,
        exitCode,
        timedOut: killed,
        durationMs: Date.now() - started,
        passed: passedMatch ? parseInt(passedMatch[1], 10) : null,
        failed: failedMatch ? parseInt(failedMatch[1], 10) : null,
        junitFile: junitFile && existsSync(junitFile) ? junitFile : null,
        command: ['godot', ...cliArgs],
        output: (stdout + stderr).split('\n').slice(-300),
      };
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to run tests: ${error?.message || 'Unknown error'}`, [
        'Ensure Godot is installed correctly',
        `Check the ${framework === 'gut' ? 'GUT' : 'gdUnit4'} version matches your Godot version`,
      ]);
    }
  }

  /** get_project_setting */
  private async handleGetProjectSetting(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    const projectFile = join(args.projectPath, 'project.godot');
    try {
      const content = readFileSync(projectFile, 'utf8');
      const { sections } = this.parseIniFile(content);

      if (!args.setting) {
        const dump: any = {};
        for (const section of sections) {
          if (section.entries.length === 0 && section.name === '') continue;
          const bucket = dump[section.name] || (dump[section.name] = {});
          for (const entry of section.entries) bucket[entry.key] = entry.value;
        }
        return { content: [{ type: 'text', text: JSON.stringify(dump, null, 2) }] };
      }

      const { section, key } = this.splitSettingPath(String(args.setting));
      const target = sections.find((s) => s.name === section);
      if (!target) {
        return this.createErrorResponse(`Section not found: [${section}]`, [
          `Available sections: ${sections
            .filter((s) => s.name)
            .map((s) => s.name)
            .join(', ')}`,
        ]);
      }
      const entry = target.entries.find((e) => e.key === key);
      if (!entry) {
        return this.createErrorResponse(`Setting not found: ${args.setting}`, [
          `Keys in [${section}]: ${target.entries.map((e) => e.key).join(', ') || '(none)'}`,
          'Use set_project_setting to create it',
        ]);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ section, key, setting: args.setting, value: entry.value }, null, 2) }],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to read project settings: ${error?.message || 'Unknown error'}`, ['Verify project.godot exists and is readable']);
    }
  }

  /** set_project_setting */
  private async handleSetProjectSetting(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.setting) return this.createErrorResponse('setting is required', ['Use "section/key", e.g. "application/run/main_scene"']);
    if (!('value' in args)) return this.createErrorResponse('value is required', ['Provide the new value']);

    const projectFile = join(args.projectPath, 'project.godot');
    try {
      const content = readFileSync(projectFile, 'utf8');
      const { lines, sections } = this.parseIniFile(content);
      const { section, key } = this.splitSettingPath(String(args.setting));
      const serialized = this.serializeIniValue(args.value, args.rawValue === true);
      const replacement = `${key}=${serialized}`;

      const target = sections.find((s) => s.name === section);
      if (!target && section !== '') {
        lines.push('', `[${section}]`);
        sections.push({ name: section, start: lines.length - 1, entries: [] });
      }
      this.upsertIniValue(lines, sections, section, key, serialized);

      writeFileSync(projectFile, lines.join('\n'), 'utf8');
      // Verify it still parses
      this.parseIniFile(readFileSync(projectFile, 'utf8'));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ setting: args.setting, section, key, value: serialized, written: true }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to write project setting: ${error?.message || 'Unknown error'}`, ['Check write permissions on project.godot']);
    }
  }

  /** add_input_action */
  private async handleAddInputAction(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.action || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(args.action))) {
      return this.createErrorResponse('Invalid action name', ['Use a plain identifier like "jump" or "move_left"']);
    }
    if (!Array.isArray(args.events) || args.events.length === 0) {
      return this.createErrorResponse('events must be a non-empty array', ['Example: ["w", "space"] or [{"mouse":"left"}]']);
    }
    const projectFile = join(args.projectPath, 'project.godot');
    try {
      const params: any = { action: args.action, events: args.events };
      if (args.deadzone !== undefined) params.deadzone = args.deadzone;
      const { json, stderr } = await this.runOperationJson('add_input_action', params, args.projectPath);
      if (!json || typeof json.value !== 'string') {
        return this.operationFailed('add_input_action', json, stderr, [
          'Use key names like "w", "space", "f1", or {"mouse":"left"} objects',
          'Check project.godot is writable',
        ]);
      }
      // Write the Godot-serialized value straight into project.godot: comments and
      // every other setting survive (unlike ProjectSettings.save()).
      const { lines, sections } = this.parseIniFile(readFileSync(projectFile, 'utf8'));
      this.upsertIniValue(lines, sections, 'input', String(json.action), json.value);
      writeFileSync(projectFile, lines.join('\n'), 'utf8');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                action: json.action,
                events: json.events,
                deadzone: json.deadzone,
                setting: json.setting,
                written: true,
                note: 'Written directly into project.godot; comments and other settings preserved.',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to add input action: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  /** read_resource */
  private async handleReadResource(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.path) return this.createErrorResponse('path is required', ['Provide a file path relative to the project']);
    if (!this.validatePath(args.path)) return this.createErrorResponse('Invalid path', ['Provide a path without ".." or other potentially unsafe characters']);
    const absolutePath = join(args.projectPath, args.path);
    if (!existsSync(absolutePath)) {
      return this.createErrorResponse(`File does not exist: ${args.path}`, ['Use search_project to locate files']);
    }

    const textExtensions = new Set([
      'gd', 'cs', 'tscn', 'tres', 'cfg', 'conf', 'csv', 'txt', 'md', 'json', 'gdshader', 'gdcshader',
      'import', 'godot', 'uid', 'ini', 'toml', 'yml', 'yaml', 'svg', 'glsl', 'gd', 'gdextension', 'import', 'cfg',
    ]);
    const extension = (args.path.split('.').pop() || '').toLowerCase();
    if (textExtensions.has(extension)) {
      try {
        const stat = statSync(absolutePath);
        const MAX = 512 * 1024;
        let content = readFileSync(absolutePath, 'utf8');
        let truncated = false;
        if (stat.size > MAX) {
          content = content.slice(0, MAX);
          truncated = true;
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ path: args.path, kind: 'text', size: stat.size, truncated, content }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return this.createErrorResponse(`Failed to read file: ${error?.message || 'Unknown error'}`, ['Check file permissions']);
      }
    }

    try {
      let { json, stderr } = await this.runOperationJson('read_resource', { path: args.path }, args.projectPath);
      if (!json) {
        // Freshly written assets are often not imported yet: run an import pass and retry
        this.logDebug(`read_resource could not load ${args.path}; running --import and retrying`);
        await this.runGodot(['--headless', '--path', args.projectPath, '--import'], 120000);
        ({ json, stderr } = await this.runOperationJson('read_resource', { path: args.path }, args.projectPath));
      }
      if (!json) {
        return this.operationFailed('read_resource', json, stderr, [
          'Check the resource path is correct',
          'The file may not be a format Godot can load',
          'Run launch_editor once so the asset database is built',
        ]);
      }
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to read resource: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  /** write_resource */
  private async handleWriteResource(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.path) return this.createErrorResponse('path is required', ['Provide a file path relative to the project']);
    if (!this.validatePath(args.path)) return this.createErrorResponse('Invalid path', ['Provide a path without ".." or other potentially unsafe characters']);
    const absolutePath = join(args.projectPath, args.path);
    if (existsSync(absolutePath) && args.overwrite === false) {
      return this.createErrorResponse(`File already exists: ${args.path}`, ['Pass overwrite: true to replace it']);
    }

    if (args.content !== undefined && args.content !== null) {
      try {
        const dir = join(absolutePath, '..');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(absolutePath, args.content, 'utf8');
        return { content: [{ type: 'text', text: `Wrote ${args.path} (${args.content.length} bytes) from raw content.` }] };
      } catch (error: any) {
        return this.createErrorResponse(`Failed to write resource: ${error?.message || 'Unknown error'}`, ['Check write permissions on the project directory']);
      }
    }

    if (!args.resourceClass) {
      return this.createErrorResponse('Nothing to write', ['Provide either content (raw text) or resourceClass + properties (structured build)']);
    }
    if (!this.validateClassName(args.resourceClass)) {
      return this.createErrorResponse('Invalid resourceClass', ['resourceClass must be a plain class name, e.g. "Gradient" or "Curve2D"']);
    }
    try {
      const params: any = { path: args.path, resourceClass: args.resourceClass };
      if (args.properties) params.properties = args.properties;
      const { json, stderr } = await this.runOperationJson('write_resource', params, args.projectPath);
      if (!json) {
        return this.operationFailed('write_resource', json, stderr, [
          'Check the class name is a Resource subclass (e.g. Gradient, Curve2D, GradientTexture2D)',
          'Check property names/types for that resource class',
        ]);
      }
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to write resource: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  /** search_project */
  private async handleSearchProject(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.query) return this.createErrorResponse('query is required', ['Provide text to search for']);
    const maxResults = Math.max(1, Math.min(500, Number(args.maxResults) || 50));

    let matcher: RegExp;
    try {
      matcher = args.regex === true ? new RegExp(String(args.query), 'i') : new RegExp(this.escapeRegExp(String(args.query)), 'i');
    } catch (error: any) {
      return this.createErrorResponse(`Invalid regular expression: ${error?.message || ''}`, ['Fix the regex or set regex: false for a literal search']);
    }

    const contentExtensions = args.extensions && Array.isArray(args.extensions)
      ? new Set(args.extensions.map((e: string) => String(e).replace(/^\./, '').toLowerCase()))
      : null;
    const defaultTextExtensions = new Set(['gd', 'cs', 'tscn', 'tres', 'cfg', 'csv', 'txt', 'md', 'json', 'gdshader', 'godot', 'import', 'ini', 'yml', 'yaml', 'uid']);

    try {
      const files = this.walkProjectFiles(args.projectPath);
      const results: any[] = [];
      for (const file of files) {
        if (results.length >= maxResults) break;
        const baseName = file.split('/').pop() || file;
        if (matcher.test(baseName)) {
          results.push({ file, type: 'name' });
          if (results.length >= maxResults) break;
        }
        const extension = (file.split('.').pop() || '').toLowerCase();
        const searchable = contentExtensions ? contentExtensions.has(extension) : defaultTextExtensions.has(extension);
        if (!searchable) continue;
        let stat;
        try {
          stat = statSync(join(args.projectPath, file));
        } catch (e) {
          continue;
        }
        if (stat.size > 2 * 1024 * 1024) continue;
        let content: string;
        try {
          content = readFileSync(join(args.projectPath, file), 'utf8');
        } catch (e) {
          continue;
        }
        if (content.includes('\u0000')) continue; // binary
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break;
          if (matcher.test(lines[i])) {
            results.push({ file, line: i + 1, type: 'content', text: lines[i].trim().slice(0, 240) });
          }
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ query: args.query, regex: args.regex === true, total: results.length, truncated: results.length >= maxResults, results }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to search project: ${error?.message || 'Unknown error'}`, ['Check the project path is readable']);
    }
  }

  // ================================================================
  // Phase 2 handlers: introspection, signals, autoloads, lint, export, doctor
  // ================================================================

  /** describe_class */
  private async handleDescribeClass(args: any) {
    args = this.normalizeParameters(args || {});
    if (!args.className) return this.createErrorResponse('className is required', ['Example: {className: "CharacterBody2D"}']);
    try {
      const params: any = { className: String(args.className) };
      if (args.filter) params.filter = String(args.filter);
      if (args.includeProperties !== undefined) params.includeProperties = args.includeProperties === true;
      if (args.includeMethods !== undefined) params.includeMethods = args.includeMethods === true;
      if (args.includeSignals !== undefined) params.includeSignals = args.includeSignals === true;
      // No project needed for native classes; with one, script class_name globals resolve too.
      const { json, stderr } = await this.runOperationJson('describe_class', params, args.projectPath || '', {
        noPath: !args.projectPath,
      });
      if (!json) return this.operationFailed('describe_class', json, stderr, [
        'Check the exact class name (describe_class suggestions appear for near-misses)',
        'Only engine classes are guaranteed; script classes need class_name and a loaded project',
      ]);
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to describe class: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  /** connect_signal */
  private async handleConnectSignal(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.scenePath || !args.signal || !args.targetPath || !args.method) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, scenePath, signal, targetPath, and method (nodePath defaults to "root")']);
    }
    if (!this.validatePath(args.scenePath)) return this.createErrorResponse('Invalid scenePath', ['Provide a path without ".."']);
    try {
      const params: any = {
        scenePath: args.scenePath,
        nodePath: args.nodePath || 'root',
        signal: String(args.signal),
        targetPath: String(args.targetPath),
        method: String(args.method),
      };
      const { json, stderr } = await this.runOperationJson('connect_signal', params, args.projectPath);
      if (!json) return this.operationFailed('connect_signal', json, stderr, [
        'describe_class shows the valid signals of a node type',
        'The target node must exist in the same scene (read_scene shows node paths)',
        'The target script must define the method — add it with edit_script first',
      ]);
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to connect signal: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  /** disconnect_signal */
  private async handleDisconnectSignal(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.scenePath || !args.signal || !args.targetPath || !args.method) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, scenePath, signal, targetPath, and method']);
    }
    try {
      const params: any = {
        scenePath: args.scenePath,
        nodePath: args.nodePath || 'root',
        signal: String(args.signal),
        targetPath: String(args.targetPath),
        method: String(args.method),
      };
      const { json, stderr } = await this.runOperationJson('disconnect_signal', params, args.projectPath);
      if (!json) return this.operationFailed('disconnect_signal', json, stderr, ['Check the connection exists (read_scene lists connections)']);
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to disconnect signal: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  /** Delete a key (and any continuation lines) from parsed project.godot lines */
  private removeIniValue(
    lines: string[],
    sections: { name: string; start: number; entries: { key: string; value: string; line: number }[] }[],
    section: string,
    key: string
  ): boolean {
    const target = sections.find((s) => s.name === section);
    if (!target) return false;
    const entry = target.entries.find((e) => e.key === key);
    if (!entry) return false;
    let end = entry.line;
    let depth = this.braceDelta(lines[entry.line]);
    while (depth > 0 && end + 1 < lines.length) {
      end++;
      depth = this.braceDelta(lines[end]);
    }
    lines.splice(entry.line, end - entry.line + 1);
    return true;
  }

  /** add_autoload */
  private async handleAddAutoload(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    const name = String(args.name || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return this.createErrorResponse('Invalid autoload name', ['Use an identifier: letters, digits, underscore; must not start with a digit']);
    }
    const resPath = String(args.path || '').trim();
    if (!resPath.startsWith('res://')) {
      return this.createErrorResponse('path must start with res://', ['Example: "res://scripts/game_state.gd" or "res://scenes/game_state.tscn"']);
    }
    const fsPath = join(args.projectPath, resPath.replace(/^res:\/\//, ''));
    if (!existsSync(fsPath)) {
      return this.createErrorResponse(`File does not exist: ${resPath}`, ['Create it first with create_script or create_scene']);
    }
    const singleton = args.singleton !== false;
    const value = singleton ? `*${resPath}` : resPath;
    const projectFile = join(args.projectPath, 'project.godot');
    try {
      const { lines, sections } = this.parseIniFile(readFileSync(projectFile, 'utf8'));
      const key = `autoload/${name}`;
      const app = sections.find((s) => s.name === 'application');
      const existing = app?.entries.find((e) => e.key === key);
      const serialized = this.serializeIniValue(value, false);
      this.upsertIniValue(lines, sections, 'application', key, serialized);
      writeFileSync(projectFile, lines.join('\n'), 'utf8');
      // Verify the file still parses before declaring success
      this.parseIniFile(readFileSync(projectFile, 'utf8'));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ name, path: resPath, singleton, value: serialized, existed: Boolean(existing), previousValue: existing ? existing.value : null, written: true }, null, 2),
        }],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to write autoload: ${error?.message || 'Unknown error'}`, ['Check write permissions on project.godot']);
    }
  }

  /** remove_autoload */
  private async handleRemoveAutoload(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    const name = String(args.name || '').trim();
    if (!name) return this.createErrorResponse('name is required', ['Provide the autoload name to remove']);
    const projectFile = join(args.projectPath, 'project.godot');
    try {
      const { lines, sections } = this.parseIniFile(readFileSync(projectFile, 'utf8'));
      const key = `autoload/${name}`;
      const app = sections.find((s) => s.name === 'application');
      const existing = app?.entries.find((e) => e.key === key);
      if (!existing) {
        return { content: [{ type: 'text', text: JSON.stringify({ name, removed: false, exists: false }, null, 2) }] };
      }
      this.removeIniValue(lines, sections, 'application', key);
      writeFileSync(projectFile, lines.join('\n'), 'utf8');
      this.parseIniFile(readFileSync(projectFile, 'utf8'));
      return { content: [{ type: 'text', text: JSON.stringify({ name, removed: true, exists: false, previousValue: existing.value }, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to remove autoload: ${error?.message || 'Unknown error'}`, ['Check write permissions on project.godot']);
    }
  }

  /** list_autoloads */
  private async handleListAutoloads(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    try {
      const { sections } = this.parseIniFile(readFileSync(join(args.projectPath, 'project.godot'), 'utf8'));
      const app = sections.find((s) => s.name === 'application');
      const autoloads = (app?.entries || [])
        .filter((e) => e.key.startsWith('autoload/'))
        .map((e) => {
          const raw = e.value.replace(/^"|"$/g, '');
          const singleton = raw.startsWith('*');
          return { name: e.key.slice('autoload/'.length), path: raw.replace(/^\*/, ''), singleton };
        });
      return { content: [{ type: 'text', text: JSON.stringify({ count: autoloads.length, autoloads }, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to list autoloads: ${error?.message || 'Unknown error'}`, ['Verify project.godot exists and is readable']);
    }
  }

  /** analyze_project */
  private async handleAnalyzeProject(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    try {
      const { json, stderr } = await this.runOperationJson('analyze_project', { projectPath: args.projectPath }, args.projectPath, {
        timeoutMs: 300000,
      });
      if (!json) return this.operationFailed('analyze_project', json, stderr, ['Check that Godot can open the project', 'Run validate_project for script-level detail']);
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to analyze project: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly']);
    }
  }

  /** export_project */
  private async handleExportProject(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.output) {
      return this.createErrorResponse('output is required', [
        'Example: {projectPath, output: "build/game.x86_64"}',
        'list_export_presets shows each preset\u2019s saved export_path',
      ]);
    }
    if (String(args.output).includes('..')) return this.createErrorResponse('Invalid output path', ['Provide a plain path without ".."']);
    try {
      const params: any = {
        output: String(args.output),
        mode: args.mode === 'debug' ? 'debug' : 'release',
        overwrite: args.overwrite === true,
      };
      if (args.preset) params.preset = String(args.preset);
      const { json, stderr } = await this.runOperationJson('export_project', params, args.projectPath, { timeoutMs: 600000 });
      if (!json) return this.operationFailed('export_project', json, stderr, [
        'list_export_presets shows available preset names',
        'Install export templates: Editor > Manage Export Templates > Download and Install',
        'Run the preset once in the editor to confirm it works, then retry',
      ]);
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to export: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed correctly', 'Check the export preset']);
    }
  }

  /** list_export_presets (plain file parse — no Godot launch) */
  private async handleListExportPresets(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    const cfgPath = join(args.projectPath, 'export_presets.cfg');
    if (!existsSync(cfgPath)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ exists: false, count: 0, presets: [], hint: 'No export_presets.cfg — create presets in the editor via Project > Export' }, null, 2),
        }],
      };
    }
    try {
      const lines = readFileSync(cfgPath, 'utf8').split('\n');
      const presets: any[] = [];
      let current: any = null;
      let inOptions = false;
      const unq = (v: string): string => {
        const m = v.trim().match(/^"(.*)"$/);
        return m ? m[1] : v.trim();
      };
      for (const raw of lines) {
        const line = raw.trim();
        const exact = line.match(/^\[preset\.(\d+)\]$/);
        if (exact) {
          current = { index: parseInt(exact[1], 10), name: '', platform: '', exportFilter: '', exportPath: '' };
          inOptions = false;
          presets.push(current);
          continue;
        }
        if (/^\[preset\.\d+\.options\]$/.test(line)) {
          inOptions = true;
          continue;
        }
        if (line.startsWith('[')) {
          current = null;
          inOptions = false;
          continue;
        }
        if (!current) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const value = unq(line.slice(eq + 1));
        if (inOptions) {
          if (key === 'export_path') current.exportPath = value;
          continue;
        }
        if (key === 'name') current.name = value;
        else if (key === 'platform') current.platform = value;
        else if (key === 'export_filter') current.exportFilter = value;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ exists: true, count: presets.length, presets }, null, 2) }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to read export_presets.cfg: ${error?.message || 'Unknown error'}`, ['Check file permissions on export_presets.cfg']);
    }
  }

  /** True when something is listening on 127.0.0.1:port */
  private probePortOpen(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const finish = (open: boolean): void => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, '127.0.0.1');
    });
  }

  /** doctor */
  private async handleDoctor(args: any) {
    args = this.normalizeParameters(args || {});
    const checks: any[] = [];
    const issues: any[] = [];
    const add = (id: string, ok: boolean, detail: string, fix?: string, severity: 'error' | 'warn' = 'error') => {
      checks.push({ id, ok, detail });
      if (!ok && fix) issues.push({ severity, check: id, message: detail, fix });
    };

    if (!this.godotPath) {
      try {
        await this.detectGodotPath();
      } catch (e) {
        // reported by the check below
      }
    }
    add(
      'godotBinary',
      Boolean(this.godotPath),
      this.godotPath || 'No Godot executable found',
      "Install Godot or set the GODOT_PATH environment variable in this server's config env"
    );

    if (this.godotPath) {
      try {
        const v = await this.runGodot(['--version'], 20000);
        const firstLine = ((v.stdout || v.stderr) || '').split('\n')[0].trim();
        add('godotVersion', v.exitCode === 0 && firstLine.length > 0, firstLine || 'godot --version produced no output',
          'GODOT_PATH may not point at a Godot binary; fix the path in the MCP config');
      } catch (error: any) {
        add('godotVersion', false, `godot --version failed: ${error?.message || 'unknown'}`, 'Reinstall Godot or fix GODOT_PATH');
      }
    }

    const bridgeOk = existsSync(this.operationsScriptPath);
    add('operationsBridge', bridgeOk, bridgeOk ? this.operationsScriptPath : `Missing: ${this.operationsScriptPath}`,
      'Rebuild the server (npm run build); scripts/godot_operations.gd must be copied next to build/index.js');

    if (args.projectPath) {
      const projErr = this.requireProject(args.projectPath);
      add('project', !projErr,
        projErr ? `Not a valid Godot project: ${args.projectPath}` : `Valid project: ${args.projectPath}`,
        'projectPath must point to a directory containing project.godot');
      if (!projErr) {
        try {
          const { sections } = this.parseIniFile(readFileSync(join(args.projectPath, 'project.godot'), 'utf8'));
          const app = sections.find((s) => s.name === 'application');
          const msEntry = app?.entries.find((e) => e.key === 'run/main_scene');
          const msValue = msEntry ? msEntry.value.replace(/^"|"$/g, '') : '';
          if (!msValue) {
            add('mainScene', false, 'No application/run/main_scene set; bare run_project will fail',
              'Set one: set_project_setting {setting: "application/run/main_scene", value: "res://Main.tscn"}', 'warn');
          } else {
            const msOk = existsSync(join(args.projectPath, msValue.replace(/^res:\/\//, '')));
            if (msOk) {
              add('mainScene', true, msValue);
            } else {
              add('mainScene', false, `Main scene file is missing: ${msValue}`,
                'Fix run/main_scene or restore the scene file');
            }
          }
        } catch (error: any) {
          add('mainScene', false, `Could not read project.godot: ${error?.message || ''}`, 'Repair or recreate project.godot');
        }
        try {
          accessSync(args.projectPath, constants.W_OK);
          add('writeAccess', true, 'Project directory is writable');
        } catch (e) {
          add('writeAccess', false, 'Project directory is NOT writable', 'Scene edits, backups, and exports will fail; fix directory permissions');
        }
        // Bridge round-trip through Godot itself
        if (bridgeOk && this.godotPath) {
          try {
            const started = Date.now();
            const { json } = await this.runOperationJson('describe_class', { className: 'Node' }, args.projectPath, { timeoutMs: 45000 });
            add('bridgeRoundTrip', Boolean(json), json ? `Godot answered in ${Date.now() - started}ms` : 'Godot produced no MCP_JSON answer',
              'The operations bridge failed to respond; check GODOT_PATH and rebuild the server');
          } catch (error: any) {
            add('bridgeRoundTrip', false, `Bridge call threw: ${error?.message || 'unknown'}`, 'Check GODOT_PATH and server build output');
          }
        } else {
          checks.push({ id: 'bridgeRoundTrip', ok: true, detail: 'Skipped (Godot binary or bridge script unavailable)' });
        }
      }
    } else {
      checks.push({ id: 'project', ok: true, detail: 'Skipped (no projectPath provided)' });
    }

    const bridgeListening = await this.probePortOpen(BRIDGE_PORT, 300);
    checks.push({
      id: 'inputBridgePort',
      ok: true,
      detail: bridgeListening
        ? `127.0.0.1:${BRIDGE_PORT} in use (a bridged game is running)`
        : `127.0.0.1:${BRIDGE_PORT} idle (no bridged game running — normal)`,
    });

    const ok = !issues.some((i) => i.severity === 'error');
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok,
          checks,
          issues,
          server: { script: __filename, node: process.version, godotPath: this.godotPath },
        }, null, 2),
      }],
    };
  }

  // ================================================================
  // Editor bridge: install/status/screenshot + mutation routing
  // ================================================================

  /** Send one JSON command to the editor-bridge plugin; null on any failure */
  private sendEditorCommand(command: any, timeoutMs: number): Promise<any | null> {
    return new Promise((resolve) => {
      let settled = false;
      const socket = new net.Socket();
      const finish = (value: any | null): void => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (e) { /* ignore */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      socket.on('timeout', () => { clearTimeout(timer); finish(null); });
      socket.on('error', () => { clearTimeout(timer); finish(null); });
      let buf = '';
      socket.on('data', (data: Buffer) => {
        buf += data.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            clearTimeout(timer);
            finish(JSON.parse(line));
            return;
          } catch (e) { /* partial line; keep buffering */ }
        }
      });
      socket.connect(EDITOR_BRIDGE_PORT, '127.0.0.1', () => {
        socket.write(JSON.stringify(command) + '\n');
      });
    });
  }

  /** Read the per-run token the plugin wrote; null when no editor is active */
  private readEditorToken(projectPath: string): string | null {
    try {
      const tokenPath = join(projectPath, '.godot', 'mcp_editor_bridge.token');
      if (!existsSync(tokenPath)) return null;
      const token = readFileSync(tokenPath, 'utf8').trim();
      return token || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Try to execute a scene mutation through the open editor (UndoRedo + editor
   * save). Returns an MCP response on success, or null to fall back to the
   * direct file path — unreachable plugin, foreign scene open, unsupported op,
   * or an editor that cannot save.
   */
  private async tryEditorRoute(toolName: string, rawArgs: any): Promise<any | null> {
    try {
      const args: any = this.normalizeParameters(rawArgs || {});
      const projectPath = String(args.projectPath || '');
      const scenePath = String(args.scenePath || '');
      if (!projectPath || !scenePath) return null;
      const token = this.readEditorToken(projectPath);
      if (!token) return null;
      const statusReply = await this.sendEditorCommand({ type: 'status', token }, 700);
      if (!statusReply || statusReply.ok !== true || typeof statusReply.status !== 'object') return null;
      const edited = String(statusReply.status.editedScene || '');
      const norm = (p: string): string => {
        const s = p.trim();
        if (!s) return '';
        return s.startsWith('res://') ? s : `res://${s.replace(/^\.\//, '')}`;
      };
      const autoOpen = edited === '';
      if (!autoOpen && norm(edited) !== norm(scenePath)) {
        return null; // editor is busy with a different scene; do not hijack it
      }
      const reply = await this.sendEditorCommand(
        { type: 'apply_and_save', token, op: toolName, payload: args, autoOpen },
        3000
      );
      if (!reply || reply.ok !== true) {
        if (reply && reply.ok === false && reply.error) {
          return this.createErrorResponse(`Editor bridge rejected ${toolName}: ${reply.error}`, [
            'Fix the arguments (describe_class / read_scene show valid names)',
            'Call editor_status to confirm the editor bridge is healthy',
          ]);
        }
        return null;
      }
      if (reply.handled !== true || reply.saved !== true) {
        return null; // scene not open / unsupported / unsaved — use the file path
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ...reply, viaEditor: true }, null, 2) }] };
    } catch (e) {
      return null;
    }
  }

  /** Enable/disable an editor plugin in project.godot, merging the enabled array */
  private setEditorPluginEnabled(projectPath: string, pluginResPath: string, enabled: boolean): void {
    const projectFile = join(projectPath, 'project.godot');
    const { lines, sections } = this.parseIniFile(readFileSync(projectFile, 'utf8'));
    let entries: string[] = [];
    const sec = sections.find((s) => s.name === 'editor_plugins');
    if (sec) {
      const entry = sec.entries.find((e) => e.key === 'enabled');
      if (entry) {
        const m = entry.value.match(/PackedStringArray\(([\s\S]*)\)/);
        if (m && m[1].trim()) {
          entries = (m[1].match(/"[^"]*"/g) || []).map((s) => s.slice(1, -1));
        }
      }
    }
    entries = entries.filter((e) => e !== pluginResPath);
    if (enabled) entries.push(pluginResPath);
    const serialized = `PackedStringArray(${entries.map((e) => `"${e}"`).join(', ')})`;
    this.upsertIniValue(lines, sections, 'editor_plugins', 'enabled', serialized);
    writeFileSync(projectFile, lines.join('\n'), 'utf8');
    // Verify the file still parses before declaring success
    this.parseIniFile(readFileSync(projectFile, 'utf8'));
  }

  private async handleInstallEditorBridge(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    try {
      const dir = join(args.projectPath, 'addons', 'mcp_editor_bridge');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'plugin.cfg'), EDITOR_PLUGIN_CFG, 'utf8');
      writeFileSync(join(dir, 'plugin.gd'), EDITOR_PLUGIN_GD, 'utf8');
      this.setEditorPluginEnabled(args.projectPath, 'res://addons/mcp_editor_bridge/plugin.cfg', true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            installed: true,
            files: ['res://addons/mcp_editor_bridge/plugin.cfg', 'res://addons/mcp_editor_bridge/plugin.gd'],
            enabled: true,
            hint: '(Re)start the editor to activate the plugin; editor_status reports when it is online',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to install editor bridge: ${error?.message || 'Unknown error'}`, [
        'Check write permissions on the project\u2019s addons/ directory',
      ]);
    }
  }

  private async handleUninstallEditorBridge(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    try {
      this.setEditorPluginEnabled(args.projectPath, 'res://addons/mcp_editor_bridge/plugin.cfg', false);
      const dir = join(args.projectPath, 'addons', 'mcp_editor_bridge');
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(args.projectPath, '.godot', 'mcp_editor_bridge.token'), { force: true });
      return {
        content: [{
          text: JSON.stringify({
            uninstalled: true,
            filesRemoved: !existsSync(join(dir, 'plugin.gd')),
            disabled: !readFileSync(join(args.projectPath, 'project.godot'), 'utf8').includes('mcp_editor_bridge'),
          }, null, 2),
          type: 'text',
        }],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to uninstall editor bridge: ${error?.message || 'Unknown error'}`, ['Check write permissions on project.godot']);
    }
  }

  private async handleEditorStatus(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    const token = this.readEditorToken(args.projectPath);
    if (!token) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          connected: false,
          port: EDITOR_BRIDGE_PORT,
          hint: 'No editor token found — run install_editor_bridge and (re)start the editor',
        }, null, 2) }],
      };
    }
    const reply = await this.sendEditorCommand({ type: 'status', token }, 900);
    if (!reply || reply.ok !== true || typeof reply.status !== 'object') {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          connected: false,
          port: EDITOR_BRIDGE_PORT,
          hint: reply?.error
            ? String(reply.error)
            : 'Nothing is listening on the editor bridge port — is the editor running with the plugin enabled?',
        }, null, 2) }],
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ connected: true, port: EDITOR_BRIDGE_PORT, ...reply.status }, null, 2) }] };
  }

  private async handleEditorScreenshot(args: any) {
    args = this.normalizeParameters(args || {});
    const projectError = this.requireProject(args.projectPath);
    if (projectError) return projectError;
    if (!args.outputPath) return this.createErrorResponse('outputPath is required', ['Provide an absolute path for the PNG']);
    const token = this.readEditorToken(args.projectPath);
    if (!token) {
      return this.createErrorResponse('Editor bridge is not active', [
        'Run install_editor_bridge, then (re)start the editor',
        'editor_status reports whether the bridge is reachable',
      ]);
    }
    const reply = await this.sendEditorCommand({ type: 'screenshot', token, path: String(args.outputPath) }, 4000);
    if (!reply || reply.ok !== true) {
      return this.createErrorResponse(`Editor screenshot failed: ${reply?.error || 'editor bridge unreachable'}`, [
        'editor_status shows whether the editor is running with the plugin',
        'A headless editor has no real viewport texture — use a windowed editor',
      ]);
    }
    const bytes = existsSync(String(args.outputPath)) ? statSync(String(args.outputPath)).size : 0;
    return { content: [{ type: 'text', text: JSON.stringify({ ...reply, bytes }, null, 2) }] };
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Run the MCP server
   */
  async run() {
    try {
      // Detect Godot path before starting the server
      await this.detectGodotPath();

      if (!this.godotPath) {
        console.error('[SERVER] Failed to find a valid Godot executable path');
        console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
        process.exit(1);
      }

      // Check if the path is valid
      const isValid = await this.isValidGodotPath(this.godotPath);

      if (!isValid) {
        if (this.strictPathValidation) {
          // In strict mode, exit if the path is invalid
          console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path');
          process.exit(1);
        } else {
          // In compatibility mode, warn but continue with the default path
          console.error(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] This may cause issues when executing Godot commands');
          console.error('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
        }
      }

      console.error(`[SERVER] Using Godot at: ${this.godotPath}`);

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

// Create and run the server
const server = new GodotServer();
server.run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', errorMessage);
  process.exit(1);
});
