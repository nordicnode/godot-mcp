#!/usr/bin/env -S godot --headless --script
extends SceneTree

# Debug mode flag
var debug_mode = false

# When true, _init returns without quitting so async work (e.g. screenshots)
# can complete over subsequent frames.
var defer_quit = false

# State for the capture_screenshot operation (member vars so the
# process_frame lambda can mutate them reliably)
var cap_output_path = ""
var cap_frame_delay = 20
var cap_target_scene = ""
var cap_frame_count = 0
var cap_scene_added = false

func _init():
    var args = OS.get_cmdline_args()
    
    # Check for debug flag
    debug_mode = "--debug-godot" in args
    
    # Find the script argument and determine the positions of operation and params
    var script_index = args.find("--script")
    if script_index == -1:
        log_error("Could not find --script argument")
        quit(1)
    
    # The operation should be 2 positions after the script path (script_index + 1 is the script path itself)
    var operation_index = script_index + 2
    # The params should be 3 positions after the script path
    var params_index = script_index + 3
    
    if args.size() <= params_index:
        log_error("Usage: godot --headless --script godot_operations.gd <operation> <json_params>")
        log_error("Not enough command-line arguments provided.")
        quit(1)
        return
    
    # Log all arguments for debugging
    log_debug("All arguments: " + str(args))
    log_debug("Script index: " + str(script_index))
    log_debug("Operation index: " + str(operation_index))
    log_debug("Params index: " + str(params_index))
    
    var operation = args[operation_index]
    var params_json = args[params_index]
    
    log_info("Operation: " + operation)
    log_debug("Params JSON: " + params_json)
    
    # Parse JSON using Godot 4.x API
    var json = JSON.new()
    var error = json.parse(params_json)
    var params = null
    
    if error == OK:
        params = json.get_data()
    else:
        log_error("Failed to parse JSON parameters: " + params_json)
        log_error("JSON Error: " + json.get_error_message() + " at line " + str(json.get_error_line()))
        quit(1)
        return
    
    # Note: NOT `if not params` — an empty Dictionary ({}) is a valid,
    # meaningful params object (e.g. analyze_project) and is falsey in GDScript.
    if params == null or typeof(params) != TYPE_DICTIONARY:
        log_error("JSON parameters must be an object: " + params_json)
        quit(1)
        return
    
    log_info("Executing operation: " + operation)
    
    match operation:
        "create_scene":
            create_scene(params)
        "add_node":
            add_node(params)
        "load_sprite":
            load_sprite(params)
        "export_mesh_library":
            export_mesh_library(params)
        "save_scene":
            save_scene(params)
        "get_uid":
            get_uid(params)
        "resave_resources":
            resave_resources(params)
        "read_scene":
            read_scene(params)
        "attach_script":
            attach_script(params)
        "set_node_property":
            set_node_property(params)
        "delete_node":
            delete_node(params)
        "move_node":
            move_node(params)
        "duplicate_node":
            duplicate_node(params)
        "instantiate_scene":
            instantiate_scene(params)
        "validate_scenes":
            validate_scenes(params)
        "add_input_action":
            add_input_action(params)
        "write_resource":
            write_resource(params)
        "read_resource":
            read_resource(params)
        "capture_screenshot":
            capture_screenshot(params)
        "validate_scripts":
            validate_scripts(params)
        "edit_scene":
            edit_scene(params)
        "describe_class":
            describe_class(params)
        "connect_signal":
            connect_signal(params)
        "disconnect_signal":
            disconnect_signal(params)
        "analyze_project":
            analyze_project(params)
        "export_project":
            export_project(params)
        _:
            log_error("Unknown operation: " + operation)
            quit(1)

    if defer_quit:
        log_debug("Deferring quit; operation will finish over coming frames")
        return
    
    quit()

# Logging functions
func log_debug(message):
    if debug_mode:
        print("[DEBUG] " + message)

func log_info(message):
    print("[INFO] " + message)

func log_error(message):
    printerr("[ERROR] " + message)

# Get a script by registered class name.
# Only looks up names via the project's global class registry. Raw paths
# (e.g. "res://evil.gd") are intentionally not accepted here to prevent
# arbitrary script instantiation from agent-supplied input.
func get_script_by_name(name_of_class):
    if debug_mode:
        print("Attempting to get script for class: " + name_of_class)

    # Search for it in the global class registry if it's a class name
    var global_classes = ProjectSettings.get_global_class_list()
    if debug_mode:
        print("Searching through " + str(global_classes.size()) + " global classes")
    
    for global_class in global_classes:
        var found_name_of_class = global_class["class"]
        var found_path = global_class["path"]
        
        if found_name_of_class == name_of_class:
            if debug_mode:
                print("Found matching class in registry: " + found_name_of_class + " at path: " + found_path)
            var script = load(found_path) as Script
            if script:
                if debug_mode:
                    print("Successfully loaded script from registry")
                return script
            else:
                printerr("Failed to load script from registry path: " + found_path)
                break
    
    printerr("Could not find script for class: " + name_of_class)
    return null

# Instantiate a class by name
func instantiate_class(name_of_class):
    if name_of_class.is_empty():
        printerr("Cannot instantiate class: name is empty")
        return null
    
    var result = null
    if debug_mode:
        print("Attempting to instantiate class: " + name_of_class)
    
    # Check if it's a built-in class
    if ClassDB.class_exists(name_of_class):
        if debug_mode:
            print("Class exists in ClassDB, using ClassDB.instantiate()")
        if ClassDB.can_instantiate(name_of_class):
            result = ClassDB.instantiate(name_of_class)
            if result == null:
                printerr("ClassDB.instantiate() returned null for class: " + name_of_class)
        else:
            printerr("Class exists but cannot be instantiated: " + name_of_class)
            printerr("This may be an abstract class or interface that cannot be directly instantiated")
    else:
        # Try to get the script
        if debug_mode:
            print("Class not found in ClassDB, trying to get script")
        var script = get_script_by_name(name_of_class)
        if script is GDScript:
            if debug_mode:
                print("Found GDScript, creating instance")
            result = script.new()
        else:
            printerr("Failed to get script for class: " + name_of_class)
            return null
    
    if result == null:
        printerr("Failed to instantiate class: " + name_of_class)
    elif debug_mode:
        print("Successfully instantiated class: " + name_of_class + " of type: " + result.get_class())
    
    return result

# Create a new scene with a specified root node type
func create_scene(params):
    print("Creating scene: " + params.scene_path)
    
    # Get project paths and log them for debugging
    var project_res_path = "res://"
    var project_user_path = "user://"
    var global_res_path = ProjectSettings.globalize_path(project_res_path)
    var global_user_path = ProjectSettings.globalize_path(project_user_path)
    
    if debug_mode:
        print("Project paths:")
        print("- res:// path: " + project_res_path)
        print("- user:// path: " + project_user_path)
        print("- Globalized res:// path: " + global_res_path)
        print("- Globalized user:// path: " + global_user_path)
        
        # Print some common environment variables for debugging
        print("Environment variables:")
        var env_vars = ["PATH", "HOME", "USER", "TEMP", "GODOT_PATH"]
        for env_var in env_vars:
            if OS.has_environment(env_var):
                print("  " + env_var + " = " + OS.get_environment(env_var))
    
    # Normalize the scene path
    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    if debug_mode:
        print("Scene path (with res://): " + full_scene_path)
    
    # Convert resource path to an absolute path
    var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
    if debug_mode:
        print("Absolute scene path: " + absolute_scene_path)
    
    # Get the scene directory paths
    var scene_dir_res = full_scene_path.get_base_dir()
    var scene_dir_abs = absolute_scene_path.get_base_dir()
    if debug_mode:
        print("Scene directory (resource path): " + scene_dir_res)
        print("Scene directory (absolute path): " + scene_dir_abs)
    
    # Only do extensive testing in debug mode
    if debug_mode:
        # Try to create a simple test file in the project root to verify write access
        var initial_test_file_path = "res://godot_mcp_test_write.tmp"
        var initial_test_file = FileAccess.open(initial_test_file_path, FileAccess.WRITE)
        if initial_test_file:
            initial_test_file.store_string("Test write access")
            initial_test_file.close()
            print("Successfully wrote test file to project root: " + initial_test_file_path)
            
            # Verify the test file exists
            var initial_test_file_exists = FileAccess.file_exists(initial_test_file_path)
            print("Test file exists check: " + str(initial_test_file_exists))
            
            # Clean up the test file
            if initial_test_file_exists:
                var remove_error = DirAccess.remove_absolute(ProjectSettings.globalize_path(initial_test_file_path))
                print("Test file removal result: " + str(remove_error))
        else:
            var write_error = FileAccess.get_open_error()
            printerr("Failed to write test file to project root: " + str(write_error))
            printerr("This indicates a serious permission issue with the project directory")
    
    # Use traditional if-else statement for better compatibility
    var root_node_type = "Node2D"  # Default value
    if params.has("root_node_type"):
        root_node_type = params.root_node_type
    if debug_mode:
        print("Root node type: " + root_node_type)
    
    # Create the root node
    var scene_root = instantiate_class(root_node_type)
    if not scene_root:
        printerr("Failed to instantiate node of type: " + root_node_type)
        printerr("Make sure the class exists and can be instantiated")
        printerr("Check if the class is registered in ClassDB or available as a script")
        quit(1)
    
    scene_root.name = "root"
    if debug_mode:
        print("Root node created with name: " + scene_root.name)
    
    # Set the owner of the root node to itself (important for scene saving)
    scene_root.owner = scene_root
    
    # Pack the scene
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")
    
    if result == OK:
        # Only do extensive testing in debug mode
        if debug_mode:
            # First, let's verify we can write to the project directory
            print("Testing write access to project directory...")
            var test_write_path = "res://test_write_access.tmp"
            var test_write_abs = ProjectSettings.globalize_path(test_write_path)
            var test_file = FileAccess.open(test_write_path, FileAccess.WRITE)
            
            if test_file:
                test_file.store_string("Write test")
                test_file.close()
                print("Successfully wrote test file to project directory")
                
                # Clean up test file
                if FileAccess.file_exists(test_write_path):
                    var remove_error = DirAccess.remove_absolute(test_write_abs)
                    print("Test file removal result: " + str(remove_error))
            else:
                var write_error = FileAccess.get_open_error()
                printerr("Failed to write test file to project directory: " + str(write_error))
                printerr("This may indicate permission issues with the project directory")
                # Continue anyway, as the scene directory might still be writable
        
        # Ensure the scene directory exists using DirAccess
        if debug_mode:
            print("Ensuring scene directory exists...")
        
        # Get the scene directory relative to res://
        var scene_dir_relative = scene_dir_res.substr(6)  # Remove "res://" prefix
        if debug_mode:
            print("Scene directory (relative to res://): " + scene_dir_relative)
        
        # Create the directory if needed
        if not scene_dir_relative.is_empty():
            # First check if it exists
            var dir_exists = DirAccess.dir_exists_absolute(scene_dir_abs)
            if debug_mode:
                print("Directory exists check (absolute): " + str(dir_exists))
            
            if not dir_exists:
                if debug_mode:
                    print("Directory doesn't exist, creating: " + scene_dir_relative)
                
                # Try to create the directory using DirAccess
                var dir = DirAccess.open("res://")
                if dir == null:
                    var open_error = DirAccess.get_open_error()
                    printerr("Failed to open res:// directory: " + str(open_error))
                    
                    # Try alternative approach with absolute path
                    if debug_mode:
                        print("Trying alternative directory creation approach...")
                    var make_dir_error = DirAccess.make_dir_recursive_absolute(scene_dir_abs)
                    if debug_mode:
                        print("Make directory result (absolute): " + str(make_dir_error))
                    
                    if make_dir_error != OK:
                        printerr("Failed to create directory using absolute path")
                        printerr("Error code: " + str(make_dir_error))
                        quit(1)
                else:
                    # Create the directory using the DirAccess instance
                    if debug_mode:
                        print("Creating directory using DirAccess: " + scene_dir_relative)
                    var make_dir_error = dir.make_dir_recursive(scene_dir_relative)
                    if debug_mode:
                        print("Make directory result: " + str(make_dir_error))
                    
                    if make_dir_error != OK:
                        printerr("Failed to create directory: " + scene_dir_relative)
                        printerr("Error code: " + str(make_dir_error))
                        quit(1)
                
                # Verify the directory was created
                dir_exists = DirAccess.dir_exists_absolute(scene_dir_abs)
                if debug_mode:
                    print("Directory exists check after creation: " + str(dir_exists))
                
                if not dir_exists:
                    printerr("Directory reported as created but does not exist: " + scene_dir_abs)
                    printerr("This may indicate a problem with path resolution or permissions")
                    quit(1)
            elif debug_mode:
                print("Directory already exists: " + scene_dir_abs)
        
        # Save the scene
        if debug_mode:
            print("Saving scene to: " + full_scene_path)
        var save_error = atomic_save_resource(packed_scene, full_scene_path)
        if debug_mode:
            print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")
        
        if save_error == OK:
            # Only do extensive testing in debug mode
            if debug_mode:
                # Wait a moment to ensure file system has time to complete the write
                print("Waiting for file system to complete write operation...")
                OS.delay_msec(500)  # 500ms delay
                
                # Verify the file was actually created using multiple methods
                var file_check_abs = FileAccess.file_exists(absolute_scene_path)
                print("File exists check (absolute path): " + str(file_check_abs))
                
                var file_check_res = FileAccess.file_exists(full_scene_path)
                print("File exists check (resource path): " + str(file_check_res))
                
                var res_exists = ResourceLoader.exists(full_scene_path)
                print("Resource exists check: " + str(res_exists))
                
                # If file doesn't exist by absolute path, try to create a test file in the same directory
                if not file_check_abs and not file_check_res:
                    printerr("Scene file not found after save. Trying to diagnose the issue...")
                    
                    # Try to write a test file to the same directory
                    var test_scene_file_path = scene_dir_res + "/test_scene_file.tmp"
                    var test_scene_file = FileAccess.open(test_scene_file_path, FileAccess.WRITE)
                    
                    if test_scene_file:
                        test_scene_file.store_string("Test scene directory write")
                        test_scene_file.close()
                        print("Successfully wrote test file to scene directory: " + test_scene_file_path)
                        
                        # Check if the test file exists
                        var test_file_exists = FileAccess.file_exists(test_scene_file_path)
                        print("Test file exists: " + str(test_file_exists))
                        
                        if test_file_exists:
                            # Directory is writable, so the issue is with scene saving
                            printerr("Directory is writable but scene file wasn't created.")
                            printerr("This suggests an issue with ResourceSaver.save() or the packed scene.")
                            
                            # Try saving with a different approach
                            print("Trying alternative save approach...")
                            var alt_save_error = ResourceSaver.save(packed_scene, test_scene_file_path + ".tscn")
                            print("Alternative save result: " + str(alt_save_error))
                            
                            # Clean up test files
                            DirAccess.remove_absolute(ProjectSettings.globalize_path(test_scene_file_path))
                            if alt_save_error == OK:
                                DirAccess.remove_absolute(ProjectSettings.globalize_path(test_scene_file_path + ".tscn"))
                        else:
                            printerr("Test file couldn't be verified. This suggests filesystem access issues.")
                    else:
                        var write_error = FileAccess.get_open_error()
                        printerr("Failed to write test file to scene directory: " + str(write_error))
                        printerr("This confirms there are permission or path issues with the scene directory.")
                    
                    # Return error since we couldn't create the scene file
                    printerr("Failed to create scene: " + params.scene_path)
                    quit(1)
                
                # If we get here, at least one of our file checks passed
                if file_check_abs or file_check_res or res_exists:
                    print("Scene file verified to exist!")
                    
                    # Try to load the scene to verify it's valid
                    var test_load = ResourceLoader.load(full_scene_path)
                    if test_load:
                        print("Scene created and verified successfully at: " + params.scene_path)
                        print("Scene file can be loaded correctly.")
                    else:
                        print("Scene file exists but cannot be loaded. It may be corrupted or incomplete.")
                        # Continue anyway since the file exists
                    
                    print("Scene created successfully at: " + params.scene_path)
                else:
                    printerr("All file existence checks failed despite successful save operation.")
                    printerr("This indicates a serious issue with file system access or path resolution.")
                    quit(1)
            else:
                # In non-debug mode, just check if the file exists
                var file_exists = FileAccess.file_exists(full_scene_path)
                if file_exists:
                    print("Scene created successfully at: " + params.scene_path)
                else:
                    printerr("Failed to create scene: " + params.scene_path)
                    quit(1)
        else:
            # Handle specific error codes
            var error_message = "Failed to save scene. Error code: " + str(save_error)
            
            if save_error == ERR_CANT_CREATE:
                error_message += " (ERR_CANT_CREATE - Cannot create the scene file)"
            elif save_error == ERR_CANT_OPEN:
                error_message += " (ERR_CANT_OPEN - Cannot open the scene file for writing)"
            elif save_error == ERR_FILE_CANT_WRITE:
                error_message += " (ERR_FILE_CANT_WRITE - Cannot write to the scene file)"
            elif save_error == ERR_FILE_NO_PERMISSION:
                error_message += " (ERR_FILE_NO_PERMISSION - No permission to write the scene file)"
            
            printerr(error_message)
            quit(1)
    else:
        printerr("Failed to pack scene: " + str(result))
        printerr("Error code: " + str(result))
        quit(1)

# Add a node to an existing scene
func add_node(params):
    print("Adding node to scene: " + params.scene_path)
    
    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    if debug_mode:
        print("Scene path (with res://): " + full_scene_path)
    
    var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
    if debug_mode:
        print("Absolute scene path: " + absolute_scene_path)
    
    if not FileAccess.file_exists(absolute_scene_path):
        printerr("Scene file does not exist at: " + absolute_scene_path)
        quit(1)
    
    var scene = load(full_scene_path)
    if not scene:
        printerr("Failed to load scene: " + full_scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Use traditional if-else statement for better compatibility
    var parent_path = "root"  # Default value
    if params.has("parent_node_path"):
        parent_path = params.parent_node_path
    if debug_mode:
        print("Parent path: " + parent_path)
    
    var parent = scene_root
    if parent_path != "root":
        parent = scene_root.get_node(parent_path.replace("root/", ""))
        if not parent:
            printerr("Parent node not found: " + parent_path)
            quit(1)
    if debug_mode:
        print("Parent node found: " + parent.name)
    
    if debug_mode:
        print("Instantiating node of type: " + params.node_type)
    var new_node = instantiate_class(params.node_type)
    if not new_node:
        printerr("Failed to instantiate node of type: " + params.node_type)
        printerr("Make sure the class exists and can be instantiated")
        printerr("Check if the class is registered in ClassDB or available as a script")
        quit(1)
    new_node.name = params.node_name
    if debug_mode:
        print("New node created with name: " + new_node.name)
    
    if params.has("properties"):
        if debug_mode:
            print("Setting properties on node")
        var properties = params.properties
        for property in properties:
            if debug_mode:
                print("Setting property: " + property + " = " + str(properties[property]))
            var value = properties[property]
            if typeof(value) == TYPE_STRING and value.begins_with("res://"):
                value = load(value)
                if debug_mode:
                    print("Loaded resource for property: " + property + " -> " + str(value))
            new_node.set(property, value)
    
    parent.add_child(new_node)
    new_node.owner = scene_root
    if debug_mode:
        print("Node added to parent and ownership set")
    
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")
    
    if result == OK:
        if debug_mode:
            print("Saving scene to: " + absolute_scene_path)
        var save_error = atomic_save_resource(packed_scene, full_scene_path)
        if debug_mode:
            print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")
        if save_error == OK:
            if debug_mode:
                var file_check_after = FileAccess.file_exists(absolute_scene_path)
                print("File exists check after save: " + str(file_check_after))
                if file_check_after:
                    print("Node '" + params.node_name + "' of type '" + params.node_type + "' added successfully")
                else:
                    printerr("File reported as saved but does not exist at: " + absolute_scene_path)
            else:
                print("Node '" + params.node_name + "' of type '" + params.node_type + "' added successfully")
        else:
            printerr("Failed to save scene: " + str(save_error))
    else:
        printerr("Failed to pack scene: " + str(result))

# Load a sprite into a Sprite2D node
func load_sprite(params):
    print("Loading sprite into scene: " + params.scene_path)
    
    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    
    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)
    
    # Check if the scene file exists
    var file_check = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))
    
    if not file_check:
        printerr("Scene file does not exist at: " + full_scene_path)
        # Get the absolute path for reference
        var absolute_path = ProjectSettings.globalize_path(full_scene_path)
        printerr("Absolute file path that doesn't exist: " + absolute_path)
        quit(1)
    
    # Ensure the texture path starts with res:// for Godot's resource system
    var full_texture_path = params.texture_path
    if not full_texture_path.begins_with("res://"):
        full_texture_path = "res://" + full_texture_path
    
    if debug_mode:
        print("Full texture path (with res://): " + full_texture_path)
    
    # Load the scene
    var scene = load(full_scene_path)
    if not scene:
        printerr("Failed to load scene: " + full_scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Find the sprite node
    var node_path = params.node_path
    if debug_mode:
        print("Original node path: " + node_path)
    
    if node_path.begins_with("root/"):
        node_path = node_path.substr(5)  # Remove "root/" prefix
        if debug_mode:
            print("Node path after removing 'root/' prefix: " + node_path)
    
    var sprite_node = null
    if node_path == "":
        # If no node path, assume root is the sprite
        sprite_node = scene_root
        if debug_mode:
            print("Using root node as sprite node")
    else:
        sprite_node = scene_root.get_node(node_path)
        if sprite_node and debug_mode:
            print("Found sprite node: " + sprite_node.name)
    
    if not sprite_node:
        printerr("Node not found: " + params.node_path)
        quit(1)
    
    # Check if the node is a Sprite2D or compatible type
    if debug_mode:
        print("Node class: " + sprite_node.get_class())
    if not (sprite_node is Sprite2D or sprite_node is Sprite3D or sprite_node is TextureRect):
        printerr("Node is not a sprite-compatible type: " + sprite_node.get_class())
        quit(1)
    
    # Load the texture
    if debug_mode:
        print("Loading texture from: " + full_texture_path)
    var texture = load(full_texture_path)
    if not texture:
        printerr("Failed to load texture: " + full_texture_path)
        quit(1)
    
    if debug_mode:
        print("Texture loaded successfully")
    
    # Set the texture on the sprite
    if sprite_node is Sprite2D or sprite_node is Sprite3D:
        sprite_node.texture = texture
        if debug_mode:
            print("Set texture on Sprite2D/Sprite3D node")
    elif sprite_node is TextureRect:
        sprite_node.texture = texture
        if debug_mode:
            print("Set texture on TextureRect node")
    
    # Save the modified scene
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")
    
    if result == OK:
        if debug_mode:
            print("Saving scene to: " + full_scene_path)
        var error = atomic_save_resource(packed_scene, full_scene_path)
        if debug_mode:
            print("Save result: " + str(error) + " (OK=" + str(OK) + ")")
        
        if error == OK:
            # Verify the file was actually updated
            if debug_mode:
                var file_check_after = FileAccess.file_exists(full_scene_path)
                print("File exists check after save: " + str(file_check_after))
                
                if file_check_after:
                    print("Sprite loaded successfully with texture: " + full_texture_path)
                    # Get the absolute path for reference
                    var absolute_path = ProjectSettings.globalize_path(full_scene_path)
                    print("Absolute file path: " + absolute_path)
                else:
                    printerr("File reported as saved but does not exist at: " + full_scene_path)
            else:
                print("Sprite loaded successfully with texture: " + full_texture_path)
        else:
            printerr("Failed to save scene: " + str(error))
    else:
        printerr("Failed to pack scene: " + str(result))

# Export a scene as a MeshLibrary resource
func export_mesh_library(params):
    print("Exporting MeshLibrary from scene: " + params.scene_path)
    
    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    
    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)
    
    # Ensure the output path starts with res:// for Godot's resource system
    var full_output_path = params.output_path
    if not full_output_path.begins_with("res://"):
        full_output_path = "res://" + full_output_path
    
    if debug_mode:
        print("Full output path (with res://): " + full_output_path)
    
    # Check if the scene file exists
    var file_check = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))
    
    if not file_check:
        printerr("Scene file does not exist at: " + full_scene_path)
        # Get the absolute path for reference
        var absolute_path = ProjectSettings.globalize_path(full_scene_path)
        printerr("Absolute file path that doesn't exist: " + absolute_path)
        quit(1)
    
    # Load the scene
    if debug_mode:
        print("Loading scene from: " + full_scene_path)
    var scene = load(full_scene_path)
    if not scene:
        printerr("Failed to load scene: " + full_scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Create a new MeshLibrary
    var mesh_library = MeshLibrary.new()
    if debug_mode:
        print("Created new MeshLibrary")
    
    # Get mesh item names if provided
    var mesh_item_names = params.mesh_item_names if params.has("mesh_item_names") else []
    var use_specific_items = mesh_item_names.size() > 0
    
    if debug_mode:
        if use_specific_items:
            print("Using specific mesh items: " + str(mesh_item_names))
        else:
            print("Using all mesh items in the scene")
    
    # Process all child nodes
    var item_id = 0
    if debug_mode:
        print("Processing child nodes...")
    
    for child in scene_root.get_children():
        if debug_mode:
            print("Checking child node: " + child.name)
        
        # Skip if not using all items and this item is not in the list
        if use_specific_items and not (child.name in mesh_item_names):
            if debug_mode:
                print("Skipping node " + child.name + " (not in specified items list)")
            continue
            
        # Check if the child has a mesh
        var mesh_instance = null
        if child is MeshInstance3D:
            mesh_instance = child
            if debug_mode:
                print("Node " + child.name + " is a MeshInstance3D")
        else:
            # Try to find a MeshInstance3D in the child's descendants
            if debug_mode:
                print("Searching for MeshInstance3D in descendants of " + child.name)
            for descendant in child.get_children():
                if descendant is MeshInstance3D:
                    mesh_instance = descendant
                    if debug_mode:
                        print("Found MeshInstance3D in descendant: " + descendant.name)
                    break
        
        if mesh_instance and mesh_instance.mesh:
            if debug_mode:
                print("Adding mesh: " + child.name)
            
            # Add the mesh to the library
            mesh_library.create_item(item_id)
            mesh_library.set_item_name(item_id, child.name)
            mesh_library.set_item_mesh(item_id, mesh_instance.mesh)
            if debug_mode:
                print("Added mesh to library with ID: " + str(item_id))
            
            # Add collision shape if available
            var collision_added = false
            for collision_child in child.get_children():
                if collision_child is CollisionShape3D and collision_child.shape:
                    mesh_library.set_item_shapes(item_id, [collision_child.shape])
                    if debug_mode:
                        print("Added collision shape from: " + collision_child.name)
                    collision_added = true
                    break
            
            if debug_mode and not collision_added:
                print("No collision shape found for mesh: " + child.name)
            
            # Add preview if available
            if mesh_instance.mesh:
                mesh_library.set_item_preview(item_id, mesh_instance.mesh)
                if debug_mode:
                    print("Added preview for mesh: " + child.name)
            
            item_id += 1
        elif debug_mode:
            print("Node " + child.name + " has no valid mesh")
    
    if debug_mode:
        print("Processed " + str(item_id) + " meshes")
    
    # Create directory if it doesn't exist
    var dir = DirAccess.open("res://")
    if dir == null:
        printerr("Failed to open res:// directory")
        printerr("DirAccess error: " + str(DirAccess.get_open_error()))
        quit(1)
        
    var output_dir = full_output_path.get_base_dir()
    if debug_mode:
        print("Output directory: " + output_dir)
    
    if output_dir != "res://" and not dir.dir_exists(output_dir.substr(6)):  # Remove "res://" prefix
        if debug_mode:
            print("Creating directory: " + output_dir)
        var error = dir.make_dir_recursive(output_dir.substr(6))  # Remove "res://" prefix
        if error != OK:
            printerr("Failed to create directory: " + output_dir + ", error: " + str(error))
            quit(1)
    
    # Save the mesh library
    if item_id > 0:
        if debug_mode:
            print("Saving MeshLibrary to: " + full_output_path)
        var error = atomic_save_resource(mesh_library, full_output_path)
        if debug_mode:
            print("Save result: " + str(error) + " (OK=" + str(OK) + ")")
        
        if error == OK:
            # Verify the file was actually created
            if debug_mode:
                var file_check_after = FileAccess.file_exists(full_output_path)
                print("File exists check after save: " + str(file_check_after))
                
                if file_check_after:
                    print("MeshLibrary exported successfully with " + str(item_id) + " items to: " + full_output_path)
                    # Get the absolute path for reference
                    var absolute_path = ProjectSettings.globalize_path(full_output_path)
                    print("Absolute file path: " + absolute_path)
                else:
                    printerr("File reported as saved but does not exist at: " + full_output_path)
            else:
                print("MeshLibrary exported successfully with " + str(item_id) + " items to: " + full_output_path)
        else:
            printerr("Failed to save MeshLibrary: " + str(error))
    else:
        printerr("No valid meshes found in the scene")

# Find files with a specific extension recursively
func find_files(path, extension):
    var files = []
    var dir = DirAccess.open(path)
    
    if dir:
        dir.list_dir_begin()
        var file_name = dir.get_next()
        
        while file_name != "":
            if dir.current_is_dir() and not file_name.begins_with("."):
                files.append_array(find_files(path + file_name + "/", extension))
            elif file_name.ends_with(extension):
                files.append(path + file_name)
            
            file_name = dir.get_next()
    
    return files

# Get UID for a specific file
func get_uid(params):
    if not params.has("file_path"):
        printerr("File path is required")
        quit(1)
    
    # Ensure the file path starts with res:// for Godot's resource system
    var file_path = params.file_path
    if not file_path.begins_with("res://"):
        file_path = "res://" + file_path
    
    print("Getting UID for file: " + file_path)
    if debug_mode:
        print("Full file path (with res://): " + file_path)
    
    # Get the absolute path for reference
    var absolute_path = ProjectSettings.globalize_path(file_path)
    if debug_mode:
        print("Absolute file path: " + absolute_path)
    
    # Ensure the file exists
    var file_check = FileAccess.file_exists(file_path)
    if debug_mode:
        print("File exists check: " + str(file_check))
    
    if not file_check:
        printerr("File does not exist at: " + file_path)
        printerr("Absolute file path that doesn't exist: " + absolute_path)
        quit(1)
    
    # Check if the UID file exists
    var uid_path = file_path + ".uid"
    if debug_mode:
        print("UID file path: " + uid_path)
    
    var uid_check = FileAccess.file_exists(uid_path)
    if debug_mode:
        print("UID file exists check: " + str(uid_check))
    
    var f = FileAccess.open(uid_path, FileAccess.READ)
    
    if f:
        # Read the UID content
        var uid_content = f.get_as_text()
        f.close()
        if debug_mode:
            print("UID content read successfully")
        
        # Return the UID content
        var result = {
            "file": file_path,
            "absolutePath": absolute_path,
            "uid": uid_content.strip_edges(),
            "exists": true
        }
        if debug_mode:
            print("UID result: " + JSON.stringify(result))
        print(JSON.stringify(result))
    else:
        if debug_mode:
            print("UID file does not exist or could not be opened")
        
        # UID file doesn't exist
        var result = {
            "file": file_path,
            "absolutePath": absolute_path,
            "exists": false,
            "message": "UID file does not exist for this file. Use resave_resources to generate UIDs."
        }
        if debug_mode:
            print("UID result: " + JSON.stringify(result))
        print(JSON.stringify(result))

# Resave all resources to update UID references
func resave_resources(params):
    print("Resaving all resources to update UID references...")
    
    # Get project path if provided
    var project_path = "res://"
    if params.has("project_path"):
        project_path = params.project_path
        if not project_path.begins_with("res://"):
            project_path = "res://" + project_path
        if not project_path.ends_with("/"):
            project_path += "/"
    
    if debug_mode:
        print("Using project path: " + project_path)
    
    # Get all .tscn files
    if debug_mode:
        print("Searching for scene files in: " + project_path)
    var scenes = find_files(project_path, ".tscn")
    if debug_mode:
        print("Found " + str(scenes.size()) + " scenes")
    
    # Resave each scene
    var success_count = 0
    var error_count = 0
    
    for scene_path in scenes:
        if debug_mode:
            print("Processing scene: " + scene_path)
        
        # Check if the scene file exists
        var file_check = FileAccess.file_exists(scene_path)
        if debug_mode:
            print("Scene file exists check: " + str(file_check))
        
        if not file_check:
            printerr("Scene file does not exist at: " + scene_path)
            error_count += 1
            continue
        
        # Load the scene
        var scene = load(scene_path)
        if scene:
            if debug_mode:
                print("Scene loaded successfully, saving...")
            var error = atomic_save_resource(scene, scene_path)
            if debug_mode:
                print("Save result: " + str(error) + " (OK=" + str(OK) + ")")
            
            if error == OK:
                success_count += 1
                if debug_mode:
                    print("Scene saved successfully: " + scene_path)
                
                    # Verify the file was actually updated
                    var file_check_after = FileAccess.file_exists(scene_path)
                    print("File exists check after save: " + str(file_check_after))
                
                    if not file_check_after:
                        printerr("File reported as saved but does not exist at: " + scene_path)
            else:
                error_count += 1
                printerr("Failed to save: " + scene_path + ", error: " + str(error))
        else:
            error_count += 1
            printerr("Failed to load: " + scene_path)
    
    # Get all .gd and .shader files
    if debug_mode:
        print("Searching for script and shader files in: " + project_path)
    var scripts = find_files(project_path, ".gd") + find_files(project_path, ".shader") + find_files(project_path, ".gdshader")
    if debug_mode:
        print("Found " + str(scripts.size()) + " scripts/shaders")
    
    # Check for missing .uid files
    var missing_uids = 0
    var generated_uids = 0
    
    for script_path in scripts:
        if debug_mode:
            print("Checking UID for: " + script_path)
        var uid_path = script_path + ".uid"
        
        var uid_check = FileAccess.file_exists(uid_path)
        if debug_mode:
            print("UID file exists check: " + str(uid_check))
        
        var f = FileAccess.open(uid_path, FileAccess.READ)
        if not f:
            missing_uids += 1
            if debug_mode:
                print("Missing UID file for: " + script_path + ", generating...")
            
            # Force a save to generate UID
            var res = load(script_path)
            if res:
                var error = atomic_save_resource(res, script_path)
                if debug_mode:
                    print("Save result: " + str(error) + " (OK=" + str(OK) + ")")
                
                if error == OK:
                    generated_uids += 1
                    if debug_mode:
                        print("Generated UID for: " + script_path)
                    
                        # Verify the UID file was actually created
                        var uid_check_after = FileAccess.file_exists(uid_path)
                        print("UID file exists check after save: " + str(uid_check_after))
                    
                        if not uid_check_after:
                            printerr("UID file reported as generated but does not exist at: " + uid_path)
                else:
                    printerr("Failed to generate UID for: " + script_path + ", error: " + str(error))
            else:
                printerr("Failed to load resource: " + script_path)
        elif debug_mode:
            print("UID file already exists for: " + script_path)
    
    if debug_mode:
        print("Summary:")
        print("- Scenes processed: " + str(scenes.size()))
        print("- Scenes successfully saved: " + str(success_count))
        print("- Scenes with errors: " + str(error_count))
        print("- Scripts/shaders missing UIDs: " + str(missing_uids))
        print("- UIDs successfully generated: " + str(generated_uids))
    print("Resave operation complete")

# Save changes to a scene file
func save_scene(params):
    print("Saving scene: " + params.scene_path)
    
    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    
    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)
    
    # Check if the scene file exists
    var file_check = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))
    
    if not file_check:
        printerr("Scene file does not exist at: " + full_scene_path)
        # Get the absolute path for reference
        var absolute_path = ProjectSettings.globalize_path(full_scene_path)
        printerr("Absolute file path that doesn't exist: " + absolute_path)
        quit(1)
    
    # Load the scene
    var scene = load(full_scene_path)
    if not scene:
        printerr("Failed to load scene: " + full_scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Determine save path
    var save_path = params.new_path if params.has("new_path") else full_scene_path
    if params.has("new_path") and not save_path.begins_with("res://"):
        save_path = "res://" + save_path
    
    if debug_mode:
        print("Save path: " + save_path)
    
    # Create directory if it doesn't exist
    if params.has("new_path"):
        var dir = DirAccess.open("res://")
        if dir == null:
            printerr("Failed to open res:// directory")
            printerr("DirAccess error: " + str(DirAccess.get_open_error()))
            quit(1)
            
        var scene_dir = save_path.get_base_dir()
        if debug_mode:
            print("Scene directory: " + scene_dir)
        
        if scene_dir != "res://" and not dir.dir_exists(scene_dir.substr(6)):  # Remove "res://" prefix
            if debug_mode:
                print("Creating directory: " + scene_dir)
            var error = dir.make_dir_recursive(scene_dir.substr(6))  # Remove "res://" prefix
            if error != OK:
                printerr("Failed to create directory: " + scene_dir + ", error: " + str(error))
                quit(1)
    
    # Create a packed scene
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")
    
    if result == OK:
        if debug_mode:
            print("Saving scene to: " + save_path)
        var error = atomic_save_resource(packed_scene, save_path)
        if debug_mode:
            print("Save result: " + str(error) + " (OK=" + str(OK) + ")")
        
        if error == OK:
            # Verify the file was actually created/updated
            if debug_mode:
                var file_check_after = FileAccess.file_exists(save_path)
                print("File exists check after save: " + str(file_check_after))
                
                if file_check_after:
                    print("Scene saved successfully to: " + save_path)
                    # Get the absolute path for reference
                    var absolute_path = ProjectSettings.globalize_path(save_path)
                    print("Absolute file path: " + absolute_path)
                else:
                    printerr("File reported as saved but does not exist at: " + save_path)
            else:
                print("Scene saved successfully to: " + save_path)
        else:
            printerr("Failed to save scene: " + str(error))
    else:
        printerr("Failed to pack scene: " + str(result))

# ============================================================
# Extended tool operations
# ============================================================

# Properties included when dumping a node through read_scene
const MCP_DUMP_PROPS = [
    "position", "size", "scale", "rotation", "pivot_offset", "visible",
    "modulate", "self_modulate", "z_index", "text", "color",
    "custom_minimum_size", "offset_left", "offset_top", "offset_right",
    "offset_bottom", "anchor_left", "anchor_top", "anchor_right",
    "anchor_bottom", "texture", "icon", "disabled", "pressed", "value",
    "min_value", "max_value", "step", "editable", "max_length", "mass",
    "gravity_scale", "freeze", "shape", "mesh", "environment",
]

# Normalize a caller-supplied path to res://
func resolve_res_path(path_str):
    var s = str(path_str)
    if s.begins_with("res://"):
        return s
    return "res://" + s

# Load a scene, reporting a clean error (and setting the exit code) on failure
func load_scene_checked(scene_path):
    var full = resolve_res_path(scene_path)
    if not FileAccess.file_exists(full):
        printerr("[ERROR] Scene file does not exist: " + full)
        quit(1)
        return null
    var packed = load(full)
    if packed == null or not (packed is PackedScene):
        printerr("[ERROR] Failed to load scene: " + full)
        quit(1)
        return null
    return packed

# Resolve a node path like "root", "root/Player" or "Player/Target" inside a scene instance
func resolve_node(scene_root, path_str):
    if scene_root == null or path_str == null:
        return null
    var p = str(path_str).strip_edges()
    if p == "" or p == "." or p == "root":
        return scene_root
    if p.begins_with("root/"):
        p = p.substr(5)
    return scene_root.get_node_or_null(NodePath(p))

# Save a resource durably: write a temp file, verify it loads, keep one hidden
# backup of the previous version, then atomically swap it into place.
# Returns an Error code compatible with ResourceSaver.save().
func atomic_save_resource(resource, res_path):
    var extension = res_path.get_extension()
    if extension == "":
        return ResourceSaver.save(resource, res_path)
    var tmp_path = res_path + ".mcp_tmp." + extension
    var abs_tmp = ProjectSettings.globalize_path(tmp_path)
    var write_error = ResourceSaver.save(resource, tmp_path)
    if write_error != OK:
        DirAccess.remove_absolute(abs_tmp)
        return write_error
    var verify = ResourceLoader.load(tmp_path, "", ResourceLoader.CACHE_MODE_IGNORE)
    if verify == null:
        DirAccess.remove_absolute(abs_tmp)
        printerr("[ERROR] Temporary file failed verification; original left untouched: " + res_path)
        return ERR_FILE_CANT_READ
    backup_target_file(res_path)
    var swap_error = DirAccess.rename_absolute(abs_tmp, ProjectSettings.globalize_path(res_path))
    if swap_error != OK:
        DirAccess.remove_absolute(abs_tmp)
        printerr("[ERROR] Failed to swap file into place: " + res_path + " (" + str(swap_error) + ")")
        return swap_error
    return OK

# Keep one generation of the previous file under .godot/mcp_backups (hidden)
func backup_target_file(res_path):
    if not FileAccess.file_exists(res_path):
        return
    var backup_dir = ProjectSettings.globalize_path("res://.godot/mcp_backups")
    if not DirAccess.dir_exists_absolute(backup_dir):
        DirAccess.make_dir_recursive_absolute(backup_dir)
    var backup_path = backup_dir.path_join(res_path.get_file() + ".bak")
    var copy_error = DirAccess.copy_absolute(ProjectSettings.globalize_path(res_path), backup_path)
    if copy_error != OK:
        printerr("[WARN] Could not write backup copy: " + str(copy_error))

# Pack an instanced scene tree and write it back to disk (atomically)
func pack_and_save_scene(scene_root, full_scene_path):
    var packed_scene = PackedScene.new()
    var pack_result = packed_scene.pack(scene_root)
    if pack_result != OK:
        printerr("[ERROR] Failed to pack scene: " + str(pack_result))
        return false
    var save_error = atomic_save_resource(packed_scene, full_scene_path)
    if save_error != OK:
        printerr("[ERROR] Failed to save scene: " + str(save_error))
        return false
    if not FileAccess.file_exists(full_scene_path):
        printerr("[ERROR] Scene reported saved but file is missing: " + full_scene_path)
        return false
    return true

# Recursively set owner so nodes serialize when the scene is packed
func set_owner_recursive(node, owner_node):
    node.owner = owner_node
    for child in node.get_children():
        set_owner_recursive(child, owner_node)

# Interpret agent-friendly value strings: "Vector2(1, 2)", "#ff0000", "res://x.png",
# "true", numbers (already typed via JSON), etc.
func parse_incoming_value(value):
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
    if s.contains("(") and (s.begins_with("Vector") or s.begins_with("Color") or s.begins_with("Rect2") or s.begins_with("Rect2i") or s.begins_with("Transform") or s.begins_with("Basis") or s.begins_with("Quaternion") or s.begins_with("Plane") or s.begins_with("Projection") or s.begins_with("Packed") or s.begins_with("NodePath")):
        var parsed = str_to_var(s)
        if parsed != null:
            return parsed
    if s == "[]" or s == "{}":
        var parsed_bracket = str_to_var(s)
        if parsed_bracket != null:
            return parsed_bracket
    return value

# Dump a node (and its children) into a JSON-friendly dictionary
func node_to_dict(node, node_path_str, depth, max_depth, include_props, connections_by_path = null):
    var entry = {}
    entry["path"] = node_path_str
    entry["name"] = str(node.name)
    entry["type"] = node.get_class()

    if connections_by_path != null and connections_by_path.has(node_path_str):
        entry["connections"] = connections_by_path[node_path_str]

    var groups = node.get_groups()
    if groups.size() > 0:
        var group_names = []
        for g in groups:
            group_names.append(str(g))
        entry["groups"] = group_names

    var script = node.get_script()
    if script != null:
        entry["script"] = script.resource_path
        if script is GDScript:
            var global_name = script.get_global_name()
            if str(global_name) != "":
                entry["class_name"] = str(global_name)

    if include_props:
        entry["properties"] = node_properties_for_dump(node)

    if depth < max_depth:
        var children = []
        for child in node.get_children():
            children.append(node_to_dict(child, node_path_str + "/" + str(child.name), depth + 1, max_depth, include_props, connections_by_path))
        entry["children"] = children
    elif node.get_child_count() > 0:
        entry["childCount"] = node.get_child_count()
        entry["truncated"] = true
    return entry

# Curated common properties plus every script-defined property on the node
func node_properties_for_dump(node):
    var out = {}
    var available = {}
    for p in node.get_property_list():
        available[str(p.name)] = true
    for prop_name in MCP_DUMP_PROPS:
        if available.has(prop_name):
            out[prop_name] = str(node.get(prop_name))
    var script = node.get_script()
    if script != null and script.has_method("get_script_property_list"):
        for p in script.get_script_property_list():
            var script_prop = str(p.name)
            if available.has(script_prop) and not out.has(script_prop):
                out[script_prop] = str(node.get(script_prop))
    return out

# Recursively collect files with a given extension under res://
func collect_files_by_extension(dir_path, extension, out_array):
    var dir = DirAccess.open(dir_path)
    if dir == null:
        return
    dir.list_dir_begin()
    var fname = dir.get_next()
    while fname != "":
        if dir.current_is_dir():
            if not fname.begins_with(".") and fname != "node_modules":
                collect_files_by_extension(dir_path.path_join(fname), extension, out_array)
        elif fname.to_lower().ends_with(extension):
            out_array.append(dir_path.path_join(fname))
        fname = dir.get_next()
    dir.list_dir_end()

# read_scene: full node tree of a scene file
func read_scene(params):
    print("Reading scene: " + str(params.scene_path))
    var packed = load_scene_checked(params.scene_path)
    if packed == null:
        return
    var instance = packed.instantiate()
    var max_depth = int(params.get("max_depth", 8))
    if max_depth < 0:
        max_depth = 0
    var include_props = bool(params.get("include_properties", true))
    var connections_by_path = scene_state_connections(packed)
    var tree = node_to_dict(instance, "root", 0, max_depth, include_props, connections_by_path)
    tree["scene"] = resolve_res_path(params.scene_path)
    print("MCP_JSON:" + JSON.stringify(tree))
    instance.free()

# Normalize a SceneState from/to value (".", "A/B", absolute or an index)
# into the "root/..." path style used everywhere else in this tool.
func normalize_state_node_path(state, value):
    if typeof(value) == TYPE_INT:
        if state.has_method("get_node_path"):
            return normalize_state_node_path(state, state.get_node_path(value))
        return "root"
    var s = str(value)
    if s == "" or s == ".":
        return "root"
    if s.begins_with("/"):
        s = s.substr(1)
    if s == "root":
        return "root"
    if s.begins_with("root/"):
        return s
    return "root/" + s

# Outgoing signal connections as stored in the scene file, grouped by
# source node path ("root/...").
func scene_state_connections(packed):
    var by_path = {}
    var state = packed.get_state()
    var count = state.get_connection_count()
    for i in range(count):
        var entry = {
            "signal": str(state.get_connection_signal(i)),
            "to": normalize_state_node_path(state, state.get_connection_target(i)),
            "method": str(state.get_connection_method(i)),
        }
        if state.has_method("get_connection_binds"):
            var binds = state.get_connection_binds(i)
            if typeof(binds) == TYPE_ARRAY and binds.size() > 0:
                var bind_values = []
                for b in binds:
                    bind_values.append(str(b))
                entry["binds"] = bind_values
        var key = normalize_state_node_path(state, state.get_connection_source(i))
        if not by_path.has(key):
            by_path[key] = []
        by_path[key].append(entry)
    return by_path

# attach_script: point a node at an existing script file
func attach_script(params):
    print("Attaching script to node: " + str(params.node_path))
    var packed = load_scene_checked(params.scene_path)
    if packed == null:
        return
    var script_path = resolve_res_path(params.script_path)
    if not FileAccess.file_exists(script_path):
        printerr("[ERROR] Script file does not exist: " + script_path)
        printerr("[HINT] Create it first with the create_script tool")
        quit(1)
        return
    var script_resource = load(script_path)
    if script_resource == null or not (script_resource is Script):
        printerr("[ERROR] Failed to load script: " + script_path)
        quit(1)
        return
    # load() can return a script that has parse errors; recompile so we fail
    # loudly instead of silently attaching a script that does nothing.
    if script_resource is GDScript:
        var compile_error = script_resource.reload()
        if compile_error != OK:
            printerr("[ERROR] Script does not compile: " + script_path)
            printerr("[HINT] Run validate_project (target: \"scripts\") to see the exact errors")
            quit(1)
            return
    elif script_resource.has_method("can_instantiate") and not script_resource.can_instantiate():
        printerr("[ERROR] Script cannot be instantiated: " + script_path)
        quit(1)
        return
    var instance = packed.instantiate()
    var node = resolve_node(instance, params.node_path)
    if node == null:
        printerr("[ERROR] Node not found: " + str(params.node_path))
        instance.free()
        quit(1)
        return
    var previous = node.get_script()
    node.set_script(script_resource)
    if not pack_and_save_scene(instance, resolve_res_path(params.scene_path)):
        instance.free()
        quit(1)
        return
    print("MCP_JSON:" + JSON.stringify({
        "scene": resolve_res_path(params.scene_path),
        "nodePath": str(params.node_path),
        "script": script_path,
        "replacedScript": previous.resource_path if previous != null else "",
    }))
    instance.free()

# set_node_property: change one property on one node and save the scene.
# mode "auto" (default) edits the .tscn text directly when the node block exists
# and the value is a plain Variant (byte-fidelity for the rest of the file),
# falling back to the pack-based path otherwise. mode "text"/"pack" forces one.
func set_node_property(params):
    var prop_name = str(params.property)
    print("Setting property '" + prop_name + "' on " + str(params.node_path))
    var scene_path = resolve_res_path(params.scene_path)
    var mode = str(params.get("mode", "auto"))
    if mode != "auto" and mode != "text" and mode != "pack":
        printerr("[ERROR] Invalid mode: " + mode + " (use auto, text, or pack)")
        quit(1)
        return
    var new_value = parse_incoming_value(params.value)
    var value_is_resource = typeof(new_value) == TYPE_OBJECT
    if mode == "text" and value_is_resource:
        printerr("[ERROR] Resource values cannot be set in text mode (they need ext_resource entries)")
        printerr("[HINT] Use mode \"auto\" or \"pack\" for texture/script/resource values")
        quit(1)
        return
    if mode != "pack" and not value_is_resource:
        if try_set_property_text(scene_path, str(params.node_path), prop_name, new_value):
            return
        if mode == "text":
            printerr("[ERROR] Text edit could not be applied or failed verification")
            printerr("[HINT] The node may live inside an instanced scene, not exist in the file, or the value may not round-trip")
            quit(1)
            return
        print("[INFO] Text edit not applicable; using pack-based path")

    var packed = load_scene_checked(params.scene_path)
    if packed == null:
        return
    var instance = packed.instantiate()
    var node = resolve_node(instance, params.node_path)
    if node == null:
        printerr("[ERROR] Node not found: " + str(params.node_path))
        instance.free()
        quit(1)
        return
    var found = false
    for p in node.get_property_list():
        if str(p.name) == prop_name:
            found = true
            break
    if not found:
        var suggestions = property_suggestions(node, prop_name)
        printerr("[ERROR] Property does not exist on " + str(node.get_class()) + ": " + prop_name)
        if suggestions.size() > 0:
            printerr("[HINT] Closest matches: " + ", ".join(suggestions))
        instance.free()
        quit(1)
        return
    var old_value = node.get(prop_name)
    node.set(prop_name, new_value)
    var applied = node.get(prop_name)
    if not pack_and_save_scene(instance, scene_path):
        instance.free()
        quit(1)
        return
    print("MCP_JSON:" + JSON.stringify({
        "scene": scene_path,
        "nodePath": str(params.node_path),
        "property": prop_name,
        "mode": "pack",
        "previousValue": str(old_value),
        "value": str(applied),
    }))
    instance.free()

# Typo-tolerant property name suggestions for a node
func property_suggestions(node, prop_name):
    var candidates = []
    for p in node.get_property_list():
        candidates.append(str(p.name))
    var suggestions = []
    for candidate in candidates:
        if candidate.findn(prop_name) != -1:
            suggestions.append(candidate)
        if suggestions.size() >= 8:
            break
    if suggestions.size() == 0:
        var scored = []
        for candidate in candidates:
            var distance = edit_distance(candidate.to_lower(), prop_name.to_lower())
            if distance <= 3:
                scored.append([distance, candidate])
        scored.sort_custom(func(a, b): return a[0] < b[0])
        for entry in scored.slice(0, 5):
            suggestions.append(entry[1])
    return suggestions

# Read one attribute out of a [node ...] header line
func _extract_attr(line: String, attr: String) -> String:
    var key = attr + "=\""
    var idx = line.find(key)
    if idx == -1:
        return ""
    var value_start = idx + key.length()
    var end_idx = line.find("\"", value_start)
    if end_idx == -1:
        return ""
    return line.substr(value_start, end_idx - value_start)

# Index every [node ...] block in a .tscn by its root-relative path
func build_node_block_index(text: String):
    var lines = text.split("\n")
    var blocks = {}
    var cur_path = ""
    var cur_start = -1
    for i in range(lines.size()):
        var stripped = lines[i].strip_edges()
        if stripped.begins_with("[node "):
            if cur_path != "":
                blocks[cur_path] = {"start": cur_start, "end": i}
            var node_name = _extract_attr(stripped, "name")
            var parent_attr = _extract_attr(stripped, "parent")
            if parent_attr == "":
                cur_path = "root"
            elif parent_attr == ".":
                cur_path = "root/" + node_name
            else:
                cur_path = "root/" + parent_attr + "/" + node_name
            cur_start = i
        elif stripped.begins_with("[") and cur_path != "":
            blocks[cur_path] = {"start": cur_start, "end": i}
            cur_path = ""
            cur_start = -1
    if cur_path != "":
        blocks[cur_path] = {"start": cur_start, "end": lines.size()}
    return {"lines": lines, "blocks": blocks}

# True when two values represent the same thing despite int/float typing quirks
func values_equivalent(a, b):
    if typeof(a) == typeof(b) and str(a) == str(b):
        return true
    var sa = str(a)
    var sb = str(b)
    if sa.is_valid_number() and sb.is_valid_number():
        return float(sa) == float(sb)
    if (typeof(a) == TYPE_INT or typeof(a) == TYPE_FLOAT) and (typeof(b) == TYPE_INT or typeof(b) == TYPE_FLOAT):
        return float(a) == float(b)
    if var_to_str(a) == var_to_str(b):
        return true
    return false

# Splice a property straight into the .tscn, verifying against a temp copy
# (parsed + instantiated + value-compared) BEFORE swapping it into place.
func try_set_property_text(scene_path, node_path, prop_name, value):
    if not FileAccess.file_exists(scene_path):
        return false
    var file = FileAccess.open(scene_path, FileAccess.READ)
    if file == null:
        printerr("[WARN] Could not open scene for text edit: " + scene_path)
        return false
    var text = file.get_as_text()
    file.close()
    var index = build_node_block_index(text)
    var blocks = index.blocks
    if not blocks.has(node_path):
        return false
    var lines = index.lines
    var block = blocks[node_path]
    var value_text = var_to_str(value)
    var previous = "(not previously set)"
    var replaced = false
    for i in range(block.start + 1, block.end):
        var stripped = lines[i].strip_edges()
        var eq = stripped.find("=")
        if eq > 0 and stripped.substr(0, eq).strip_edges() == prop_name:
            previous = stripped.substr(eq + 1).strip_edges()
            lines[i] = prop_name + " = " + value_text
            replaced = true
            break
    if not replaced:
        lines.insert(block.start + 1, prop_name + " = " + value_text)
    var updated = "\n".join(lines)

    var tmp_path = scene_path.get_basename() + ".mcp_tmp.tscn"
    var abs_tmp = ProjectSettings.globalize_path(tmp_path)
    var out = FileAccess.open(tmp_path, FileAccess.WRITE)
    if out == null:
        printerr("[WARN] Could not write temp scene: " + tmp_path)
        return false
    out.store_string(updated)
    out.close()

    var verify = ResourceLoader.load(tmp_path, "", ResourceLoader.CACHE_MODE_IGNORE)
    if verify == null or not (verify is PackedScene):
        DirAccess.remove_absolute(abs_tmp)
        printerr("[WARN] Text edit failed parse verification; original left untouched")
        return false
    var inst = verify.instantiate()
    var target = resolve_node(inst, node_path)
    var verified = false
    if target != null:
        var has_prop = false
        for p in target.get_property_list():
            if str(p.name) == prop_name:
                has_prop = true
                break
        if has_prop and values_equivalent(target.get(prop_name), value):
            verified = true
        elif not has_prop:
            printerr("[WARN] Property does not exist on the node (typo?): " + prop_name)
        else:
            printerr("[WARN] Value did not round-trip through text edit: expected " + str(value) + " got " + str(target.get(prop_name)))
    inst.free()
    if not verified:
        DirAccess.remove_absolute(abs_tmp)
        return false

    backup_target_file(scene_path)
    var swap_error = DirAccess.rename_absolute(abs_tmp, ProjectSettings.globalize_path(scene_path))
    if swap_error != OK:
        DirAccess.remove_absolute(abs_tmp)
        printerr("[ERROR] Failed to swap edited scene into place: " + str(swap_error))
        return false
    print("MCP_JSON:" + JSON.stringify({
        "scene": scene_path,
        "nodePath": node_path,
        "property": prop_name,
        "mode": "text",
        "previousValue": previous,
        "value": value_text,
    }))
    return true

# delete_node: remove a node (never the scene root) and save
func delete_node(params):
    print("Deleting node: " + str(params.node_path))
    var packed = load_scene_checked(params.scene_path)
    if packed == null:
        return
    var instance = packed.instantiate()
    var node = resolve_node(instance, params.node_path)
    if node == null:
        printerr("[ERROR] Node not found: " + str(params.node_path))
        instance.free()
        quit(1)
        return
    if node == instance:
        printerr("[ERROR] Refusing to delete the scene root node")
        instance.free()
        quit(1)
        return
    var removed_name = str(node.name)
    var parent = node.get_parent()
    parent.remove_child(node)
    node.free()
    if not pack_and_save_scene(instance, resolve_res_path(params.scene_path)):
        instance.free()
        quit(1)
        return
    print("MCP_JSON:" + JSON.stringify({
        "scene": resolve_res_path(params.scene_path),
        "removed": removed_name,
        "parent": str(parent.name),
    }))
    instance.free()

# move_node: reparent a node within the scene
func move_node(params):
    print("Moving node: " + str(params.node_path) + " -> " + str(params.target_parent_path))
    var packed = load_scene_checked(params.scene_path)
    if packed == null:
        return
    var instance = packed.instantiate()
    var node = resolve_node(instance, params.node_path)
    if node == null:
        printerr("[ERROR] Node not found: " + str(params.node_path))
        instance.free()
        quit(1)
        return
    if node == instance:
        printerr("[ERROR] Refusing to move the scene root node")
        instance.free()
        quit(1)
        return
    var new_parent = resolve_node(instance, params.target_parent_path)
    if new_parent == null:
        printerr("[ERROR] Target parent not found: " + str(params.target_parent_path))
        instance.free()
        quit(1)
        return
    var cursor = new_parent
    while cursor != null:
        if cursor == node:
            printerr("[ERROR] Cannot move a node into its own descendant")
            instance.free()
            quit(1)
            return
        cursor = cursor.get_parent()
    var old_parent = node.get_parent()
    old_parent.remove_child(node)
    new_parent.add_child(node)
    node.owner = instance
    var index = int(params.get("index", -1))
    if index >= 0 and index < new_parent.get_child_count():
        new_parent.move_child(node, index)
    if not pack_and_save_scene(instance, resolve_res_path(params.scene_path)):
        instance.free()
        quit(1)
        return
    print("MCP_JSON:" + JSON.stringify({
        "scene": resolve_res_path(params.scene_path),
        "node": str(node.name),
        "from": str(old_parent.name),
        "to": str(new_parent.name),
        "index": index,
    }))
    instance.free()

# duplicate_node: copy a node (and subtree) within the scene
func duplicate_node(params):
    print("Duplicating node: " + str(params.node_path))
    var packed = load_scene_checked(params.scene_path)
    if packed == null:
        return
    var instance = packed.instantiate()
    var node = resolve_node(instance, params.node_path)
    if node == null:
        printerr("[ERROR] Node not found: " + str(params.node_path))
        instance.free()
        quit(1)
        return
    if node == instance:
        printerr("[ERROR] Refusing to duplicate the scene root node")
        instance.free()
        quit(1)
        return
    var target_parent = node.get_parent()
    if params.has("target_parent_path"):
        target_parent = resolve_node(instance, params.target_parent_path)
        if target_parent == null:
            printerr("[ERROR] Target parent not found: " + str(params.target_parent_path))
            instance.free()
            quit(1)
            return
    var duplicate = node.duplicate()
    if duplicate == null:
        printerr("[ERROR] Failed to duplicate node: " + str(node.name))
        instance.free()
        quit(1)
        return
    var new_name = str(params.get("new_name", str(node.name) + "Copy"))
    duplicate.name = new_name
    target_parent.add_child(duplicate, true)
    set_owner_recursive(duplicate, instance)
    if not pack_and_save_scene(instance, resolve_res_path(params.scene_path)):
        instance.free()
        quit(1)
        return
    print("MCP_JSON:" + JSON.stringify({
        "scene": resolve_res_path(params.scene_path),
        "source": str(params.node_path),
        "duplicate": str(target_parent.name) + "/" + str(duplicate.name),
    }))
    instance.free()

# instantiate_scene: add an instance of another scene as a child
func instantiate_scene(params):
    print("Instancing scene into scene: " + str(params.source_scene_path))
    var packed = load_scene_checked(params.scene_path)
    if packed == null:
        return
    var source_path = resolve_res_path(params.source_scene_path)
    if not FileAccess.file_exists(source_path):
        printerr("[ERROR] Source scene does not exist: " + source_path)
        quit(1)
        return
    var source_packed = load(source_path)
    if source_packed == null or not (source_packed is PackedScene):
        printerr("[ERROR] Failed to load source scene: " + source_path)
        quit(1)
        return
    var instance = packed.instantiate()
    var parent = resolve_node(instance, params.get("parent_node_path", "root"))
    if parent == null:
        printerr("[ERROR] Parent node not found: " + str(params.get("parent_node_path", "root")))
        instance.free()
        quit(1)
        return
    var child = source_packed.instantiate()
    if params.has("node_name"):
        child.name = str(params.node_name)
    parent.add_child(child, true)
    set_owner_recursive(child, instance)
    child.owner = instance
    if not pack_and_save_scene(instance, resolve_res_path(params.scene_path)):
        instance.free()
        quit(1)
        return
    print("MCP_JSON:" + JSON.stringify({
        "scene": resolve_res_path(params.scene_path),
        "source": source_path,
        "instancePath": str(params.get("parent_node_path", "root")) + "/" + str(child.name),
    }))
    instance.free()

# validate_scenes: load every .tscn in the project and report failures
func validate_scenes(params):
    var files = []
    collect_files_by_extension("res://", ".tscn", files)
    files.sort()
    var instantiate_check = bool(params.get("instantiate", true))
    var results = []
    var failed = 0
    for f in files:
        var entry = {"path": f, "ok": true, "error": ""}
        var res = ResourceLoader.load(f, "", ResourceLoader.CACHE_MODE_IGNORE)
        if res == null or not (res is PackedScene):
            entry["ok"] = false
            entry["error"] = "Failed to parse scene resource"
        elif instantiate_check:
            var inst = res.instantiate()
            if inst == null:
                entry["ok"] = false
                entry["error"] = "Failed to instantiate scene"
            else:
                inst.free()
        if not entry["ok"]:
            failed += 1
        results.append(entry)
    print("MCP_JSON:" + JSON.stringify({"scenes": results, "total": results.size(), "failed": failed}))

# Translate a friendly key/mouse spec into an InputEvent
func lookup_keycode(name_lower):
    var named = {
        "space": KEY_SPACE, "enter": KEY_ENTER, "return": KEY_ENTER,
        "escape": KEY_ESCAPE, "tab": KEY_TAB, "backspace": KEY_BACKSPACE,
        "delete": KEY_DELETE, "insert": KEY_INSERT, "home": KEY_HOME,
        "end": KEY_END, "pageup": KEY_PAGEUP, "pagedown": KEY_PAGEDOWN,
        "left": KEY_LEFT, "right": KEY_RIGHT, "up": KEY_UP, "down": KEY_DOWN,
        "shift": KEY_SHIFT, "ctrl": KEY_CTRL, "alt": KEY_ALT, "meta": KEY_META,
        "super": KEY_META, "minus": KEY_MINUS, "equal": KEY_EQUAL,
        "comma": KEY_COMMA, "period": KEY_PERIOD, "slash": KEY_SLASH,
        "backslash": KEY_BACKSLASH, "semicolon": KEY_SEMICOLON,
        "apostrophe": KEY_APOSTROPHE, "quoteleft": KEY_QUOTELEFT,
        "bracketleft": KEY_BRACKETLEFT, "bracketright": KEY_BRACKETRIGHT,
        "capslock": KEY_CAPSLOCK,
    }
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

func describe_input_event(ev):
    if ev is InputEventKey:
        var label = OS.get_keycode_string(ev.keycode)
        if label == "":
            label = str(ev.keycode)
        return "key:" + label
    if ev is InputEventMouseButton:
        return "mouse:" + str(ev.button_index)
    return ev.get_class()

# add_input_action: register an InputMap action and persist it to project.godot
func add_input_action(params):
    var action = str(params.action)
    if action.is_empty():
        printerr("[ERROR] Action name is empty")
        quit(1)
        return
    var deadzone = 0.5
    if params.has("deadzone"):
        deadzone = float(params.deadzone)
    if not InputMap.has_action(action):
        InputMap.add_action(action, deadzone)
    InputMap.action_set_deadzone(action, deadzone)
    var specs = params.get("events", [])
    if typeof(specs) != TYPE_ARRAY or specs.size() == 0:
        printerr("[ERROR] 'events' must be a non-empty array, e.g. [\"w\", \"space\"]")
        quit(1)
        return
    var built = []
    var described = []
    for spec in specs:
        var ev = null
        if typeof(spec) == TYPE_STRING and str(spec).begins_with("mouse_"):
            ev = build_input_event({"mouse": str(spec).substr(6)})
        else:
            ev = build_input_event(spec)
        if ev == null:
            printerr("[ERROR] Could not interpret input event spec: " + str(spec))
            printerr("[HINT] Use key names like \"w\", \"space\", \"f1\" or mouse specs like {\"mouse\": \"left\"}")
            quit(1)
            return
        InputMap.action_add_event(action, ev)
        built.append(ev)
        described.append(describe_input_event(ev))
    # Serialize with Godot's own Variant text format. The TypeScript side writes
    # this into project.godot directly, which preserves comments and every other
    # setting (ProjectSettings.save() from a headless run loses settings).
    var serialized = var_to_str({"deadzone": deadzone, "events": built})
    print("MCP_JSON:" + JSON.stringify({
        "action": action,
        "events": described,
        "deadzone": deadzone,
        "setting": "input/" + action,
        "value": serialized,
    }))

func build_input_event(spec):
    if typeof(spec) == TYPE_STRING:
        spec = {"key": str(spec)}
    if typeof(spec) != TYPE_DICTIONARY:
        return null
    if spec.has("mouse"):
        var buttons = {
            "left": MOUSE_BUTTON_LEFT, "right": MOUSE_BUTTON_RIGHT,
            "middle": MOUSE_BUTTON_MIDDLE, "x1": MOUSE_BUTTON_XBUTTON1,
            "x2": MOUSE_BUTTON_XBUTTON2, "wheel_up": MOUSE_BUTTON_WHEEL_UP,
            "wheel_down": MOUSE_BUTTON_WHEEL_DOWN,
        }
        var button_name = str(spec.mouse).to_lower()
        if not buttons.has(button_name):
            return null
        var mouse_ev = InputEventMouseButton.new()
        mouse_ev.button_index = buttons[button_name]
        mouse_ev.pressed = true
        if spec.has("x") and spec.has("y"):
            mouse_ev.position = Vector2(float(spec.x), float(spec.y))
        return mouse_ev
    if spec.has("key"):
        var key_name = str(spec.key).to_lower()
        var code = lookup_keycode(key_name)
        if code == KEY_NONE:
            return null
        var key_ev = InputEventKey.new()
        key_ev.keycode = code
        key_ev.physical_keycode = code
        key_ev.pressed = true
        return key_ev
    return null

# Levenshtein distance, used for typo-tolerant property suggestions
func edit_distance(a, b):
    if a == b:
        return 0
    var m = a.length()
    var n = b.length()
    if m == 0:
        return n
    if n == 0:
        return m
    var prev = []
    for j in range(n + 1):
        prev.append(j)
    for i in range(1, m + 1):
        var curr = [i]
        for j in range(1, n + 1):
            var cost = 0
            if a[i - 1] != b[j - 1]:
                cost = 1
            curr.append(min(min(prev[j] + 1, curr[j - 1] + 1), prev[j - 1] + cost))
        prev = curr
    return prev[n]

# write_resource: create or replace a .tres/.res resource from a class + properties
func write_resource(params):
    var path = resolve_res_path(params.path)
    if not params.has("resource_class"):
        printerr("[ERROR] resource_class is required (e.g. \"Gradient\", \"Curve2D\", \"GradientTexture2D\")")
        quit(1)
        return
    var resource = instantiate_class(str(params.resource_class))
    if resource == null:
        quit(1)
        return
    if not (resource is Resource):
        printerr("[ERROR] Class is not a Resource: " + str(params.resource_class))
        quit(1)
        return
    var applied = {}
    if params.has("properties") and typeof(params.properties) == TYPE_DICTIONARY:
        for key in params.properties:
            var value = parse_incoming_value(params.properties[key])
            resource.set(str(key), value)
            applied[str(key)] = str(resource.get(str(key)))
    var absolute = ProjectSettings.globalize_path(path)
    var parent_dir = absolute.get_base_dir()
    if not DirAccess.dir_exists_absolute(parent_dir):
        var make_err = DirAccess.make_dir_recursive_absolute(parent_dir)
        if make_err != OK:
            printerr("[ERROR] Failed to create directory: " + parent_dir)
            quit(1)
            return
    var save_error = atomic_save_resource(resource, path)
    if save_error != OK:
        printerr("[ERROR] Failed to save resource: " + path + " (" + str(save_error) + ")")
        quit(1)
        return
    print("MCP_JSON:" + JSON.stringify({
        "path": path,
        "class": resource.get_class(),
        "properties": applied,
        "saved": true,
    }))

# read_resource: inspect a (usually binary) resource as a property dump
func read_resource(params):
    var path = resolve_res_path(params.path)
    if not ResourceLoader.exists(path):
        printerr("[ERROR] Resource does not exist or is not loadable: " + path)
        quit(1)
        return
    var resource = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
    if resource == null:
        printerr("[ERROR] Failed to load resource: " + path)
        quit(1)
        return
    var props = {}
    for p in resource.get_property_list():
        if (p.usage & PROPERTY_USAGE_STORAGE) != 0:
            props[str(p.name)] = str(resource.get(str(p.name)))
    print("MCP_JSON:" + JSON.stringify({
        "path": path,
        "class": resource.get_class(),
        "resourceName": resource.resource_name,
        "properties": props,
    }))

# capture_screenshot: run with a real renderer (NOT --headless), instance the
# target scene, wait for frames to render, then save the window texture to PNG.
func capture_screenshot(params):
    cap_output_path = str(params.get("output_path", "user://mcp_screenshot.png"))
    if cap_output_path.begins_with("res://"):
        cap_output_path = ProjectSettings.globalize_path(cap_output_path)
    cap_frame_delay = int(params.get("frame_delay", 20))
    if cap_frame_delay < 1:
        cap_frame_delay = 1
    cap_target_scene = ""
    if params.has("scene_path"):
        cap_target_scene = resolve_res_path(params.scene_path)
    cap_frame_count = 0
    cap_scene_added = false
    defer_quit = true
    print("Screenshot capture scheduled for frame " + str(cap_frame_delay))
    var callback = func():
        cap_frame_count += 1
        if not cap_scene_added:
            cap_scene_added = true
            if cap_target_scene != "":
                var packed = load(cap_target_scene)
                if packed != null and packed is PackedScene:
                    root.add_child(packed.instantiate())
                else:
                    printerr("[ERROR] Failed to load scene for capture: " + cap_target_scene)
                    quit(1)
        if cap_frame_count >= cap_frame_delay:
            finish_capture()
    process_frame.connect(callback)

func finish_capture():
    var img = root.get_texture().get_image()
    if img == null or img.is_empty():
        printerr("[ERROR] Could not read the window texture for a screenshot")
        quit(1)
        return
    var save_error = img.save_png(cap_output_path)
    if save_error != OK:
        printerr("[ERROR] Failed to save screenshot to " + cap_output_path + " (" + str(save_error) + ")")
        quit(1)
        return
    print("MCP_JSON:" + JSON.stringify({
        "outputPath": cap_output_path,
        "width": img.get_width(),
        "height": img.get_height(),
        "frames": cap_frame_count,
    }))
    quit(0)

# ============================================================
# Batch editing, fast validation
# ============================================================

# Fetch an argument from an operation object that may use either casing
# (top-level params are converted to snake_case; array elements are not)
func op_arg(op, camel_key, snake_key, default_value = null):
    if typeof(op) == TYPE_DICTIONARY and op.has(camel_key):
        return op[camel_key]
    if typeof(op) == TYPE_DICTIONARY and op.has(snake_key):
        return op[snake_key]
    return default_value

# Apply one operation of an edit_scene batch to an instanced scene tree.
# Returns an empty string on success, or a human-readable error.
func apply_scene_operation(instance, op, op_name):
    if typeof(op) != TYPE_DICTIONARY:
        return "operation must be an object"
    match op_name:
        "add_node":
            var node_type = str(op_arg(op, "nodeType", "node_type", ""))
            var node_name = str(op_arg(op, "nodeName", "node_name", ""))
            if node_type == "" or node_name == "":
                return "add_node requires nodeType and nodeName"
            var parent_path = str(op_arg(op, "parentNodePath", "parent_node_path", "root"))
            var parent = resolve_node(instance, parent_path)
            if parent == null:
                return "parent node not found: " + parent_path
            var new_node = instantiate_class(node_type)
            if new_node == null:
                return "could not instantiate node type: " + node_type
            new_node.name = node_name
            var properties = op_arg(op, "properties", "properties", null)
            if typeof(properties) == TYPE_DICTIONARY:
                for key in properties:
                    new_node.set(str(key), parse_incoming_value(properties[key]))
            parent.add_child(new_node, true)
            set_owner_recursive(new_node, instance)
            return ""
        "delete_node":
            var del_path = str(op_arg(op, "nodePath", "node_path", ""))
            if del_path == "":
                return "delete_node requires nodePath"
            var del_target = resolve_node(instance, del_path)
            if del_target == null:
                return "node not found: " + del_path
            if del_target == instance:
                return "refusing to delete the scene root"
            var del_parent = del_target.get_parent()
            del_parent.remove_child(del_target)
            del_target.free()
            return ""
        "move_node":
            var move_path = str(op_arg(op, "nodePath", "node_path", ""))
            var target_path = str(op_arg(op, "targetParentPath", "target_parent_path", ""))
            if move_path == "" or target_path == "":
                return "move_node requires nodePath and targetParentPath"
            var move_node = resolve_node(instance, move_path)
            if move_node == null:
                return "node not found: " + move_path
            if move_node == instance:
                return "refusing to move the scene root"
            var new_parent = resolve_node(instance, target_path)
            if new_parent == null:
                return "target parent not found: " + target_path
            var cursor = new_parent
            while cursor != null:
                if cursor == move_node:
                    return "cannot move a node into its own descendant"
                cursor = cursor.get_parent()
            move_node.get_parent().remove_child(move_node)
            new_parent.add_child(move_node)
            move_node.owner = instance
            var move_index = int(op_arg(op, "index", "index", -1))
            if move_index >= 0 and move_index < new_parent.get_child_count():
                new_parent.move_child(move_node, move_index)
            return ""
        "set_property":
            var set_path = str(op_arg(op, "nodePath", "node_path", ""))
            var set_prop = str(op_arg(op, "property", "property", ""))
            if set_path == "" or set_prop == "":
                return "set_property requires nodePath and property"
            if not op.has("value"):
                return "set_property requires value"
            var set_target = resolve_node(instance, set_path)
            if set_target == null:
                return "node not found: " + set_path
            var has_prop = false
            for p in set_target.get_property_list():
                if str(p.name) == set_prop:
                    has_prop = true
                    break
            if not has_prop:
                var sugg = property_suggestions(set_target, set_prop)
                var msg = "property does not exist on " + str(set_target.get_class()) + ": " + set_prop
                if sugg.size() > 0:
                    msg += " (closest: " + ", ".join(sugg) + ")"
                return msg
            set_target.set(set_prop, parse_incoming_value(op["value"]))
            return ""
        "duplicate_node":
            var dup_path = str(op_arg(op, "nodePath", "node_path", ""))
            if dup_path == "":
                return "duplicate_node requires nodePath"
            var dup_source = resolve_node(instance, dup_path)
            if dup_source == null:
                return "node not found: " + dup_path
            if dup_source == instance:
                return "refusing to duplicate the scene root"
            var dup_parent = dup_source.get_parent()
            var dup_parent_path = op_arg(op, "targetParentPath", "target_parent_path", null)
            if dup_parent_path != null and str(dup_parent_path) != "":
                dup_parent = resolve_node(instance, dup_parent_path)
                if dup_parent == null:
                    return "target parent not found: " + str(dup_parent_path)
            var duplicate = dup_source.duplicate()
            if duplicate == null:
                return "failed to duplicate node: " + str(dup_source.name)
            duplicate.name = str(op_arg(op, "newName", "new_name", str(dup_source.name) + "Copy"))
            dup_parent.add_child(duplicate, true)
            set_owner_recursive(duplicate, instance)
            return ""
        "instantiate_scene":
            var source_path = resolve_res_path(str(op_arg(op, "sourceScenePath", "source_scene_path", "")))
            if not FileAccess.file_exists(source_path):
                return "source scene does not exist: " + source_path
            var source_packed = load(source_path)
            if source_packed == null or not (source_packed is PackedScene):
                return "failed to load source scene: " + source_path
            var host_parent_path = str(op_arg(op, "parentNodePath", "parent_node_path", "root"))
            var host_parent = resolve_node(instance, host_parent_path)
            if host_parent == null:
                return "parent node not found: " + host_parent_path
            var child = source_packed.instantiate()
            var child_name = op_arg(op, "nodeName", "node_name", null)
            if child_name != null and str(child_name) != "":
                child.name = str(child_name)
            host_parent.add_child(child, true)
            set_owner_recursive(child, instance)
            child.owner = instance
            return ""
    return "unknown operation: " + op_name

# edit_scene: apply many mutations in ONE Godot run with ONE atomic save.
# All-or-nothing: if any operation fails, nothing is written.
func edit_scene(params):
    var scene_path = resolve_res_path(params.scene_path)
    print("Batch-editing scene: " + scene_path)
    var operations = params.get("operations", [])
    if typeof(operations) != TYPE_ARRAY or operations.size() == 0:
        printerr("[ERROR] operations must be a non-empty array")
        quit(1)
        return
    var packed = load_scene_checked(scene_path)
    if packed == null:
        return
    var instance = packed.instantiate()
    var applied = []
    for i in range(operations.size()):
        var op = operations[i]
        var op_name = ""
        if typeof(op) == TYPE_DICTIONARY:
            op_name = str(op.get("op", op.get("type", "")))
        var error_message = apply_scene_operation(instance, op, op_name)
        if error_message != "":
            printerr("[ERROR] edit_scene aborted at operation #" + str(i + 1) + " (" + op_name + "): " + error_message)
            printerr("[HINT] Batch is all-or-nothing; the scene on disk was NOT modified")
            instance.free()
            quit(1)
            return
        applied.append(op_name)
    if not pack_and_save_scene(instance, scene_path):
        instance.free()
        quit(1)
        return
    print("MCP_JSON:" + JSON.stringify({
        "scene": scene_path,
        "applied": applied,
        "count": applied.size(),
        "saved": true,
    }))
    instance.free()

# validate_scripts: parse-check every .gd in ONE Godot run.
# Detailed parse errors (with file:line) are printed to stderr by Godot itself.
func validate_scripts(params):
    var files = []
    if params.has("file") and str(params.file) != "":
        files.append(resolve_res_path(params.file))
    else:
        collect_files_by_extension("res://", ".gd", files)
    files.sort()
    var results = []
    var failed = 0
    for path in files:
        var entry = {"path": path, "ok": true}
        var res = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_REPLACE)
        if res == null:
            entry["ok"] = false
        elif res is GDScript:
            var compile_error = res.reload()
            if compile_error != OK:
                entry["ok"] = false
        elif res is Script and res.has_method("can_instantiate") and not res.can_instantiate():
            entry["ok"] = false
        if not entry["ok"]:
            failed += 1
        results.append(entry)
    print("MCP_JSON:" + JSON.stringify({"scripts": results, "total": results.size(), "failed": failed}))

# describe_class: introspect a class through a temporary instance.
# ClassDB.get_property_list(type) cannot be called from GDScript (Object's
# no-arg get_property_list shadows it), so we instantiate instead.
func describe_class(params):
    var cname = str(op_arg(params, "className", "class_name", op_arg(params, "class", "class", "")))
    if cname == "":
        printerr("[ERROR] class_name is required")
        quit(1)
        return
    if not ClassDB.class_exists(cname):
        printerr("[ERROR] Unknown class: " + cname)
        var suggestions = []
        for known in ClassDB.get_class_list():
            if edit_distance(cname.to_lower(), str(known).to_lower()) <= 3:
                suggestions.append(str(known))
        if suggestions.size() > 0:
            printerr("[HINT] Similar: " + ", ".join(suggestions))
        printerr("[HINT] Project script classes are not always visible here; native engine classes always are")
        quit(1)
        return
    if not ClassDB.can_instantiate(cname):
        printerr("[ERROR] Class cannot be instantiated, cannot introspect: " + cname)
        quit(1)
        return
    var inst = ClassDB.instantiate(cname)
    if inst == null:
        printerr("[ERROR] Failed to instantiate class: " + cname)
        quit(1)
        return
    var include_props = bool(params.get("includeProperties", params.get("include_properties", true)))
    var include_methods = bool(params.get("includeMethods", params.get("include_methods", true)))
    var include_signals = bool(params.get("includeSignals", params.get("include_signals", true)))
    var filter = str(params.get("filter", "")).to_lower()
    var info = {"class": cname}
    var chain = []
    var cursor = cname
    while cursor != "":
        chain.append(cursor)
        cursor = ClassDB.get_parent_class(cursor)
    info["inheritance"] = chain
    info["instantiable"] = true
    if include_props:
        var props = []
        for p in inst.get_property_list():
            var pname = str(p.get("name", ""))
            if pname == "" or pname.begins_with("__"):
                continue
            var usage = int(p.get("usage", 0))
            if (usage & PROPERTY_USAGE_CATEGORY) != 0 or (usage & PROPERTY_USAGE_GROUP) != 0:
                continue
            if filter != "" and pname.to_lower().find(filter) == -1:
                continue
            props.append({
                "name": pname,
                "type": type_string(int(p.get("type", TYPE_NIL))),
                "default": str(inst.get(pname)),
            })
        info["properties"] = props
    if include_methods:
        var methods = []
        for m in inst.get_method_list():
            var mname = str(m.get("name", ""))
            if mname == "" or mname.begins_with("__"):
                continue
            if filter != "" and mname.to_lower().find(filter) == -1:
                continue
            var mflags = int(m.get("flags", 0))
            var arg_descs = []
            for a in m.get("args", []):
                arg_descs.append(str(a.get("name", "")) + ":" + type_string(int(a.get("type", TYPE_NIL))))
            var mentry = {"name": mname, "args": arg_descs, "defaultArgs": m.get("default_args", []).size()}
            if (mflags & METHOD_FLAG_STATIC) != 0:
                mentry["static"] = true
            if (mflags & METHOD_FLAG_CONST) != 0:
                mentry["const"] = true
            if (mflags & METHOD_FLAG_VIRTUAL) != 0:
                mentry["virtual"] = true
            methods.append(mentry)
        info["methods"] = methods
    if include_signals:
        var sigs = []
        for s in inst.get_signal_list():
            var sname = str(s.get("name", ""))
            if filter != "" and sname.to_lower().find(filter) == -1:
                continue
            var sargs = []
            for a in s.get("args", []):
                sargs.append(str(a.get("name", "")) + ":" + type_string(int(a.get("type", TYPE_NIL))))
            sigs.append({"name": sname, "args": sargs})
        info["signals"] = sigs
    if inst is Node:
        inst.free()
    elif inst is RefCounted:
        inst = null
    elif inst is Object:
        inst.free()
    print("MCP_JSON:" + JSON.stringify({"classInfo": info}))

# connect_signal: wire a node's signal to a method on another node in the
# same scene and persist the connection. CONNECT_PERSIST is mandatory:
# PackedScene.pack() silently drops connections without that flag.
func connect_signal(params):
    var scene_path = resolve_res_path(op_arg(params, "scenePath", "scene_path", ""))
    var node_path_str = str(op_arg(params, "nodePath", "node_path", "root"))
    var signal_name = str(params.get("signal", ""))
    var target_path_str = str(op_arg(params, "targetPath", "target_path", ""))
    var method_name = str(params.get("method", ""))
    if signal_name == "" or target_path_str == "" or method_name == "":
        printerr("[ERROR] Required: scenePath, signal, targetPath, method")
        quit(1)
        return
    var packed = load_scene_checked(scene_path)
    if packed == null:
        return
    var instance = packed.instantiate()
    var node = resolve_node(instance, node_path_str)
    var target = resolve_node(instance, target_path_str)
    if node == null or target == null:
        printerr("[ERROR] Node not found: " + (node_path_str if node == null else target_path_str))
        printerr("[HINT] Use read_scene to see node paths")
        instance.free()
        quit(1)
        return
    var signal_found = false
    var closest = []
    for s in node.get_signal_list():
        var sn = str(s.get("name", ""))
        if sn == signal_name:
            signal_found = true
            break
        if edit_distance(sn.to_lower(), signal_name.to_lower()) <= 3:
            closest.append(sn)
    if not signal_found:
        printerr("[ERROR] Signal not found: " + signal_name + " on " + node.get_class() + " (" + node_path_str + ")")
        if closest.size() > 0:
            printerr("[HINT] Similar signals: " + ", ".join(closest))
        printerr("[HINT] describe_class lists every signal of a class; script signals appear once the script is attached")
        instance.free()
        quit(1)
        return
    var callable = Callable(target, method_name)
    if node.is_connected(StringName(signal_name), callable):
        print("MCP_JSON:" + JSON.stringify({
            "connected": false,
            "alreadyConnected": true,
            "scene": scene_path,
            "connection": {"from": node_path_str, "to": target_path_str, "signal": signal_name, "method": method_name},
        }))
        instance.free()
        return
    if not target.has_method(method_name):
        printerr("[ERROR] Method not found on target node: " + method_name + " (" + target_path_str + ")")
        if target.get_script() == null:
            printerr("[HINT] Target node has no script; attach one first with attach_script")
        else:
            printerr("[HINT] Target script does not define that method; add it with edit_script")
            var script_suggestions = []
            for m in target.get_method_list():
                var mn = str(m.get("name", ""))
                if mn != "" and not mn.begins_with("_") and edit_distance(mn.to_lower(), method_name.to_lower()) <= 3:
                    script_suggestions.append(mn)
            if script_suggestions.size() > 0:
                printerr("[HINT] Similar methods: " + ", ".join(script_suggestions))
        instance.free()
        quit(1)
        return
    var err = node.connect(StringName(signal_name), callable, CONNECT_PERSIST)
    if err != OK:
        printerr("[ERROR] connect() failed with code " + str(err))
        instance.free()
        quit(1)
        return
    if not pack_and_save_scene(instance, scene_path):
        instance.free()
        quit(1)
        return
    print("MCP_JSON:" + JSON.stringify({
        "connected": true,
        "alreadyConnected": false,
        "scene": scene_path,
        "connection": {"from": node_path_str, "to": target_path_str, "signal": signal_name, "method": method_name},
    }))
    instance.free()

# disconnect_signal: remove a previously wired connection (idempotent)
func disconnect_signal(params):
    var scene_path = resolve_res_path(op_arg(params, "scenePath", "scene_path", ""))
    var node_path_str = str(op_arg(params, "nodePath", "node_path", "root"))
    var signal_name = str(params.get("signal", ""))
    var target_path_str = str(op_arg(params, "targetPath", "target_path", ""))
    var method_name = str(params.get("method", ""))
    if signal_name == "" or target_path_str == "" or method_name == "":
        printerr("[ERROR] Required: scenePath, signal, targetPath, method")
        quit(1)
        return
    var packed = load_scene_checked(scene_path)
    if packed == null:
        return
    var instance = packed.instantiate()
    var node = resolve_node(instance, node_path_str)
    var target = resolve_node(instance, target_path_str)
    if node == null or target == null:
        printerr("[ERROR] Node not found: " + (node_path_str if node == null else target_path_str))
        instance.free()
        quit(1)
        return
    var callable = Callable(target, method_name)
    if not node.is_connected(StringName(signal_name), callable):
        print("MCP_JSON:" + JSON.stringify({
            "disconnected": false,
            "alreadyDisconnected": true,
            "scene": scene_path,
            "connection": {"from": node_path_str, "to": target_path_str, "signal": signal_name, "method": method_name},
        }))
        instance.free()
        return
    node.disconnect(StringName(signal_name), callable)
    if not pack_and_save_scene(instance, scene_path):
        instance.free()
        quit(1)
        return
    print("MCP_JSON:" + JSON.stringify({
        "disconnected": true,
        "alreadyDisconnected": false,
        "scene": scene_path,
        "connection": {"from": node_path_str, "to": target_path_str, "signal": signal_name, "method": method_name},
    }))
    instance.free()

# analyze_project: project-wide health report (issues + stats).
# Reports rather than fails: ok=false only when error-level issues exist.
func analyze_project(params):
    var issues = []
    var add_issue = func(level, message, file = ""):
        var entry = {"level": level, "message": message}
        if file != "":
            entry["file"] = file
        issues.append(entry)

    # 1. Main scene
    var main_scene = str(ProjectSettings.get_setting("application/run/main_scene", ""))
    if main_scene == "":
        add_issue.call("error", "No main scene set (application/run/main_scene); bare run_project will fail")
    elif not ResourceLoader.exists(main_scene):
        add_issue.call("error", "Main scene file does not exist", main_scene)

    # 2. Collect files
    var scripts = []
    collect_files_by_extension("res://", ".gd", scripts)
    scripts.sort()
    var scenes = []
    collect_files_by_extension("res://", ".tscn", scenes)
    scenes.sort()
    var resource_exts = [".tres", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".wav", ".mp3", ".ogg", ".ttf", ".otf", ".woff2", ".glb", ".gltf", ".obj", ".glsl"]
    var resources = []
    for ext in resource_exts:
        collect_files_by_extension("res://", ext, resources)
    resources.sort()

    # 3. Script parse check (single pass; engine prints file:line to stderr)
    var failed_scripts = 0
    for path in scripts:
        var res = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_REPLACE)
        var ok_entry = res != null
        if res is GDScript:
            ok_entry = res.reload() == OK
        if not ok_entry:
            failed_scripts += 1
            add_issue.call("error", "Script failed to load/compile (validate_project shows line detail)", path)

    # 4. Scene load + orphan scan
    var orphan_nodes = 0
    for path in scenes:
        var packed = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
        if packed == null or not (packed is PackedScene):
            add_issue.call("error", "Scene failed to load", path)
            continue
        var inst = packed.instantiate()
        if inst == null:
            add_issue.call("error", "Scene failed to instantiate", path)
            continue
        var stack = [[inst, "root"]]
        while stack.size() > 0:
            var pair = stack.pop_back()
            var n = pair[0]
            var npath = pair[1]
            if n != inst and n.owner == null:
                orphan_nodes += 1
                if orphan_nodes <= 10:
                    add_issue.call("warn", "Node '" + npath + "' has no owner; changes under it are NOT saved with the scene", path)
            for c in n.get_children():
                stack.append([c, npath + "/" + str(c.name)])
        inst.free()
    if orphan_nodes > 10:
        add_issue.call("warn", "...and " + str(orphan_nodes - 10) + " more orphan nodes")

    # 5. Reference scan for scripts/resources never mentioned outside themselves
    var haystack_parts = []
    var text_exts = [".tscn", ".tres", ".gd", ".godot", ".cfg", ".gdshader", ".txt", ".md", ".json"]
    var text_files = []
    for ext in text_exts:
        collect_files_by_extension("res://", ext, text_files)
    for tf in text_files:
        var f = FileAccess.open(tf, FileAccess.READ)
        if f == null:
            continue
        if f.get_length() > 4 * 1024 * 1024:
            continue
        haystack_parts.append(f.get_as_text())
    var haystack = "\n".join(haystack_parts)
    var unattached_scripts = 0
    for s in scripts:
        if haystack.find(s) == -1 and haystack.find(s.get_file()) == -1:
            unattached_scripts += 1
            add_issue.call("info", "Script is never referenced by any scene/config: " + s, s)
    var unused_resources = 0
    for r in resources:
        if haystack.find(r) == -1 and haystack.find(r.get_file()) == -1:
            unused_resources += 1
            if unused_resources <= 20:
                add_issue.call("info", "Resource is never referenced (may be loaded dynamically at runtime): " + r, r)
    if unused_resources > 20:
        add_issue.call("info", "...and " + str(unused_resources - 20) + " more unreferenced resources")

    var error_count = 0
    var warn_count = 0
    var info_count = 0
    for i in issues:
        match str(i.get("level", "info")):
            "error": error_count += 1
            "warn": warn_count += 1
            _: info_count += 1
    print("MCP_JSON:" + JSON.stringify({
        "ok": error_count == 0,
        "issues": issues,
        "summary": {"errors": error_count, "warnings": warn_count, "info": info_count, "total": issues.size()},
        "stats": {
            "scripts": scripts.size(),
            "scenes": scenes.size(),
            "resources": resources.size(),
            "failedScripts": failed_scripts,
            "orphanNodes": orphan_nodes,
            "unattachedScripts": unattached_scripts,
            "unusedResources": unused_resources,
            "mainScene": main_scene,
        },
    }))

# export_project: headless export against export_presets.cfg
func export_project(params):
    var preset = str(params.get("preset", ""))
    var output = str(params.get("output", ""))
    var mode = str(params.get("mode", "release"))
    var overwrite = bool(params.get("overwrite", false))
    if mode != "release" and mode != "debug":
        printerr("[ERROR] mode must be \"release\" or \"debug\"")
        quit(1)
        return
    if output == "":
        printerr("[ERROR] output is required (absolute path or res:// path, e.g. build/game.x86_64)")
        quit(1)
        return
    var presets_cfg = "res://export_presets.cfg"
    if not FileAccess.file_exists(presets_cfg):
        printerr("[ERROR] No export_presets.cfg in this project")
        printerr("[HINT] Create presets in the editor: Project > Export > Add Export Preset")
        quit(1)
        return
    var f = FileAccess.open(presets_cfg, FileAccess.READ)
    var preset_names = []
    var current_section = ""
    var found_names = {}
    while not f.eof_reached():
        var line = f.get_line().strip_edges()
        if line.begins_with("[") and line.ends_with("]"):
            current_section = line.substr(1, line.length() - 2)
            continue
        if current_section.begins_with("preset.") and not current_section.contains(".options"):
            if line.begins_with("name="):
                var pname = line.substr(5).strip_edges().trim_prefix("\"").trim_suffix("\"")
                if pname != "" and not found_names.has(pname):
                    found_names[pname] = true
                    preset_names.append(pname)
    if preset_names.size() == 0:
        printerr("[ERROR] export_presets.cfg contains no presets")
        printerr("[HINT] Add one in the editor: Project > Export > Add Export Preset")
        quit(1)
        return
    if preset == "":
        if preset_names.size() == 1:
            preset = preset_names[0]
        else:
            printerr("[ERROR] preset is required; available presets: " + ", ".join(preset_names))
            quit(1)
            return
    elif not found_names.has(preset):
        printerr("[ERROR] Unknown preset: " + preset + "; available: " + ", ".join(preset_names))
        quit(1)
        return
    var output_abs = output
    if output_abs.begins_with("res://"):
        output_abs = ProjectSettings.globalize_path(output_abs)
    if FileAccess.file_exists(output_abs) and not overwrite:
        printerr("[ERROR] Output file already exists: " + output_abs)
        printerr("[HINT] Set overwrite:true to replace it, or pass a different output path")
        quit(1)
        return
    var out_dir = output_abs.get_base_dir()
    if out_dir != "" and not DirAccess.dir_exists_absolute(out_dir):
        var mk = DirAccess.make_dir_recursive_absolute(out_dir)
        if mk != OK:
            printerr("[ERROR] Could not create output directory: " + out_dir)
            quit(1)
            return
    var godot_args = [
        "--headless",
        "--path", ProjectSettings.globalize_path("res://"),
        "--" + ("export-release" if mode == "release" else "export-debug"),
        preset,
        output_abs,
    ]
    var output_lines = []
    var exit_code = OS.execute(OS.get_executable_path(), godot_args, output_lines, true)
    var log_tail = []
    var start = maxi(0, output_lines.size() - 40)
    for i in range(start, output_lines.size()):
        log_tail.append(output_lines[i])
    var combined_log = "\n".join(output_lines).to_lower()
    if exit_code != 0:
        printerr("[ERROR] Export failed (exit code " + str(exit_code) + ")")
        for line in log_tail:
            printerr(line)
        if combined_log.find("template") != -1:
            printerr("[HINT] Install export templates: Editor > Manage Export Templates > Download")
        quit(1)
        return
    if not FileAccess.file_exists(output_abs):
        printerr("[ERROR] Export reported success but the output file is missing: " + output_abs)
        for line in log_tail:
            printerr(line)
        quit(1)
        return
    var size = 0
    var outf = FileAccess.open(output_abs, FileAccess.READ)
    if outf != null:
        size = outf.get_length()
    print("MCP_JSON:" + JSON.stringify({
        "exported": true,
        "preset": preset,
        "mode": mode,
        "output": output_abs,
        "bytes": size,
        "log": log_tail,
    }))
